// AI 对话：流式输出 + 多供应商（claude / codex，均吃各自订阅）。
// claude 走 --resume 原生续聊 + stream-json token 级增量；
// codex 无原生续聊/流式，用「历史重放」保上下文、整段返回。
// 历史持久化在 data/chats/<id>.json。
//
// 图片附件（chat-images.ts）：字节落 data/chats/attachments/<chatId>/，消息里只记 { id, mediaType, bytes }。
// 两个 provider 都要**真的**收到图，投递方式不同：claude 走 stream-json 的 user 帧（base64 内联，
// 与 agent-session.ts 同一套编码），codex 走 --image=<持久文件路径>（exec 没有 stdin 内联通道）。
// 只有本轮的图片真发出去；历史重放只写「[附件：N 张图片]」——把所有历史图片重发一遍
// 既撑爆上下文又要重新计费。
//
// 角色绑定（Role V1）：对话可以在**新建时**绑定一个角色 + 一组项目，之后不可改——
// 续聊换角色等于让历史结论串味，改了也没人看得出来。绑定后两个 provider 注入同一份
// system prompt（全局记忆 + 角色记忆），对话结论只能存成 _candidates 候选，晋升是人的活。
//
// Role V2：绑定的角色是项目专家时，主项目必进 projectIds 且取消不掉（roleMemoryPack 那边
// 还会再强制一次——前端锁死是体验，后端锁死才是保证）。存候选时可以选归属：
// 角色候选（roles/<id>/_candidates）或项目候选（projects/<主项目>/_candidates）。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  CHATS_DIR,
  type ChatImageInput,
  type ChatImageMeta,
  type PreparedImage,
  defaultImageText,
  deleteChatAttachments,
  imageNote,
  persistChatImages,
  removeChatImageFiles,
  validChatId,
  validateChatImages,
} from "./chat-images.ts";
import type { ProjectCandidate } from "./project-memory.ts";
import type { Fail, RoleCandidate } from "./roles.ts";
import { cfg, log, run } from "./util.ts";

/** 消息里的图片只有元数据（id/类型/字节数）；字节住附件目录，取图走 /api/chat/image。
 *  旧对话没有这个键 = 纯文本消息，读出来一个字都不变。 */
export interface AiMessage { role: "user" | "assistant"; text: string; ts: string; images?: ChatImageMeta[]; }
export interface AiChat {
  id: string;
  title: string;
  provider: string;      // claude | codex
  model: string;
  claudeSessionId?: string;
  /** 绑定的角色 id（新建时定死；旧对话没有这两个字段，读出来就是普通对话） */
  roleId?: string;
  /** 本次对话注入的项目（必是角色已关联项目的子集，可为空数组=只要角色自身记忆） */
  projectIds?: string[];
  // ---- 绑定语义快照（V2）：记下"绑的时候这个角色是什么"，之后角色怎么改都不动这段历史 ----
  // 没有这两个键 = V1 时代建的对话：项目范围就是 projectIds，哪怕角色后来变成项目专家，
  // 也绝不给它追加主项目（那等于替用户改了历史绑定）。
  /** 绑定当时的角色类型 */
  roleTypeAtBind?: "lead" | "project";
  /** 绑定当时的主项目（仅项目专家有）：注入与项目候选归属都认它，不认角色现在的主项目 */
  primaryProjectAtBind?: string;
  createdAt: string;
  updatedAt: string;
  messages: AiMessage[];
}

export interface ChatEvent {
  type: "delta" | "tool" | "done" | "error";
  text?: string;
  msg?: string;
  chat?: AiChat;
}

function chatFile(id: string) { return join(CHATS_DIR, `${id}.json`); }

function loadChat(id: string): AiChat | null {
  // id 就是文件名：非法的一律当"对话不存在"，不给 ../ 拼出目录外的读取面
  if (!validChatId(id)) return null;
  try { return JSON.parse(readFileSync(chatFile(id), "utf8")); } catch { return null; }
}

function saveChat(c: AiChat) {
  mkdirSync(CHATS_DIR, { recursive: true });
  writeFileSync(chatFile(c.id), JSON.stringify(c, null, 2));
}

export function listChats(): Omit<AiChat, "messages">[] {
  if (!existsSync(CHATS_DIR)) return [];
  return readdirSync(CHATS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadChat(f.slice(0, -5)))
    .filter(Boolean)
    .map((c) => {
      const { messages, ...meta } = c!;
      return { ...meta, provider: meta.provider || "claude" };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getChat(id: string): AiChat | null { return loadChat(id); }

export function renameChat(id: string, title: string): boolean {
  const c = loadChat(id);
  if (!c) return false;
  c.title = title.slice(0, 60);
  saveChat(c);
  return true;
}

export function deleteChat(id: string): boolean {
  if (!validChatId(id) || !existsSync(chatFile(id))) return false;
  rmSync(chatFile(id));
  deleteChatAttachments(id);   // 历史没了，附件字节不许留在磁盘上
  return true;
}

export function providers(): Record<string, string[]> {
  return cfg.chat?.providers || { claude: ["sonnet", "opus", "haiku"], codex: ["default"] };
}

// ---- 角色绑定（创建时定死，续聊只校验没被偷换） ----
export interface ChatBinding {
  roleId?: string;
  projectIds?: string[];
  roleTypeAtBind?: "lead" | "project";
  primaryProjectAtBind?: string;
}
/** 客户端来的原始入参，一律当不可信处理 */
export interface ChatBindingInput { roleId?: unknown; projectIds?: unknown }

/** 展示用：这个对话到底注入了什么。
 *  类型与主项目一律报**绑定当时的快照**，不拿角色现在的样子覆盖历史事实——
 *  这个面板回答的是"这段对话是在什么前提下发生的"，不是"这个角色现在长什么样"。 */
export interface ChatBindingInfo {
  roleId: string;
  name: string;
  icon: string;
  color: string;
  scope: string;
  status: string;            // active | archived | missing | conflict
  type: string;              // lead | project | ""（旧对话没快照：真不知道，不编）
  primaryProject: string;    // 绑定时的主项目（锁定注入，前端不给取消）
  parentRoleId: string;      // 上级 lead（没有则空串）
  parentName: string;        // 上级显示名（读不到就退回 id）
  projectIds: string[];      // 创建时定下的项目
  injectedProjects: string[]; // 真正会注入的（快照主项目恒在内 + ∩ 角色当前关联）
  legacy?: boolean;          // 没有绑定快照的旧对话：项目范围冻结在创建时那份
  bindNote?: string;         // 绑定与角色现状不一致时的说明（前端别自己编）
  missing?: boolean;         // 角色不可用（删了 / role.json 坏了 / 同 id 有两份）：这个对话发不出去
  msg?: string;              // 不可用的原话（后端解释怎么修，前端别自己编）
}

/** tsconfig 关了 strict，判别式联合不会自动收窄——同 roles.ts，用显式守卫 */
const isFail = (r: { ok: boolean }): r is Fail => r.ok === false;

const slug = (v: unknown) => String(v ?? "").trim().toLowerCase();
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

function normProjects(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const x of raw) { const s = slug(x); if (s && !out.includes(s)) out.push(s); }
  return out;
}

/** 新建对话：解析并校验绑定（角色须存在且 active，项目须是角色已关联项目的子集）。
 *  续聊：以已持久化的绑定为准，传了不一样的直接报错——静默忽略等于假装改成功了。 */
export async function resolveChatBinding(
  chat: AiChat | null,
  input?: ChatBindingInput,
): Promise<({ ok: true } & ChatBinding) | Fail> {
  const wantRole = String(input?.roleId ?? "").trim();   // 不做大小写归一：id 就是目录名（同 roles.ts）
  const gaveProjects = input?.projectIds !== undefined && input?.projectIds !== null;
  const wantProjects = gaveProjects ? normProjects(input!.projectIds) : null;
  if (gaveProjects && !wantProjects) return { ok: false, code: "invalid", msg: "project_ids 必须是数组" };

  if (chat) {
    const curRole = chat.roleId || "";
    const curProjects = chat.projectIds || [];
    if (wantRole && wantRole !== curRole) {
      return {
        ok: false, code: "invalid",
        msg: curRole
          ? `这个对话已绑定角色 ${curRole}，不能中途换成 ${wantRole.slice(0, 40)}（另开一个对话）`
          : "已有对话不能补绑角色（另开一个角色对话）",
      };
    }
    if (wantProjects && !sameSet(wantProjects, curProjects)) {
      return { ok: false, code: "invalid", msg: "对话的项目范围创建后不可修改（另开一个对话）" };
    }
    // 续聊只回已持久化的那份（含快照）：角色现在是什么样，与这段历史无关
    return {
      ok: true,
      ...(curRole
        ? {
          roleId: curRole, projectIds: [...curProjects],
          ...(chat.roleTypeAtBind ? { roleTypeAtBind: chat.roleTypeAtBind } : {}),
          ...(chat.primaryProjectAtBind ? { primaryProjectAtBind: chat.primaryProjectAtBind } : {}),
        }
        : {}),
    };
  }

  // 普通对话：一个字段都不写进 JSON，行为与加角色之前逐字相同
  if (!wantRole) {
    if (wantProjects?.length) return { ok: false, code: "invalid", msg: "没有绑定角色时不能指定项目" };
    return { ok: true };
  }

  // resolveRole：不存在 / role.json 坏 / 跨 scope 同 id 冲突，三种失败原话回传，
  // 绝不静默挑一个角色开对话（挑错了整段历史都长在错的记忆上）
  const { resolveRole } = await import("./roles.ts");
  const r = resolveRole(wantRole);
  if (isFail(r)) return r;
  const role = r.role;
  if (role.status !== "active") return { ok: false, code: "invalid", msg: `角色 ${role.id} 已归档，先恢复再用它开对话` };
  // 选择只能缩小范围：没关联的项目直接拒绝，不悄悄过滤——否则用户以为注入了
  const picked = wantProjects ?? [...role.projects];
  const stray = picked.filter((s) => !role.projects.includes(s));
  if (stray.length) return { ok: false, code: "invalid", msg: `项目没关联到角色 ${role.id}：${stray.join("、").slice(0, 80)}` };
  // 项目专家的主项目强制补齐：这是"项目专家 = 完整理解一个主项目"的定义，客户端不给取消。
  // 补上去的结果会原样回给客户端（绑定详情里看得见），不是偷偷改语义。
  const expert = role.type === "project" && !!role.primaryProject;
  if (expert && !picked.includes(role.primaryProject)) picked.unshift(role.primaryProject);
  // 落一份绑定快照：角色以后改类型/换主项目，这个对话仍按今天的前提注入
  return {
    ok: true, roleId: role.id, projectIds: picked,
    roleTypeAtBind: expert ? "project" : "lead",
    ...(expert ? { primaryProjectAtBind: role.primaryProject } : {}),
  };
}

/** 这个对话在**绑定当时**是什么（注入、展示、候选归属都以它为准）。
 *  没有快照 = V1 时代的对话：类型未知、不带主项目，项目范围就是它自己那份 projectIds。 */
export function bindSnapshot(chat: AiChat): { type: "lead" | "project" | ""; primaryProject: string; legacy: boolean } {
  const type = chat.roleTypeAtBind === "project" || chat.roleTypeAtBind === "lead" ? chat.roleTypeAtBind : "";
  const primary = type === "project" ? slug(chat.primaryProjectAtBind) : "";
  return { type, primaryProject: primary, legacy: !type };
}

/** 绑定详情（/api/chat/messages 用）：没绑角色返回 null */
export async function chatBinding(chat: AiChat): Promise<ChatBindingInfo | null> {
  if (!chat.roleId) return null;
  const projectIds = [...(chat.projectIds || [])];
  const snap = bindSnapshot(chat);
  const { resolveRole } = await import("./roles.ts");
  const r = resolveRole(chat.roleId);
  if (isFail(r)) {
    // 角色目录被人删了 / role.json 坏了 / 同 id 有两份：如实报，别退化成普通对话
    // （下次发消息会明确报错）。conflict 单独标出来——修法不一样：改名，不是恢复目录。
    // 角色目录被人删了 / role.json 坏了 / 同 id 有两份：如实报，别退化成普通对话。
    // 快照是对话自己的字段，角色没了也还在——照报，不然连"这是个项目专家对话"都看不出来了
    return {
      roleId: chat.roleId, name: chat.roleId, icon: "star", color: "#888888",
      scope: "", status: r.code === "conflict" ? "conflict" : "missing",
      type: snap.type, primaryProject: snap.primaryProject, parentRoleId: "", parentName: "",
      projectIds, injectedProjects: [], ...(snap.legacy ? { legacy: true } : {}),
      missing: true, msg: r.msg,
    };
  }
  const role = r.role;
  // 注入清单与 roleMemoryPack 同一套算法：快照主项目排头且恒在（哪怕角色已经不关联它了）
  const injected = projectIds.filter((s) => role.projects.includes(s));
  const parent = role.parentRoleId ? resolveRole(role.parentRoleId) : null;
  // 绑定与角色现状不一致时说清楚——UI 不许自己编，也不许拿现状盖掉历史
  const notes: string[] = [];
  if (snap.legacy && role.type === "project") {
    notes.push(`这个对话建于「${role.name}」成为项目专家之前，项目范围沿用创建时的选择（不会追加主项目 ${role.primaryProject}）`);
  } else if (snap.type === "project" && role.type === "lead") {
    notes.push(`角色现在是职能负责人了，但这个对话仍按绑定时的项目专家注入主项目 ${snap.primaryProject}`);
  } else if (snap.type === "project" && role.primaryProject && snap.primaryProject !== role.primaryProject) {
    notes.push(`角色的主项目已改成 ${role.primaryProject}，这个对话仍按绑定时的 ${snap.primaryProject} 注入`);
  }
  return {
    roleId: role.id, name: role.name, icon: role.icon, color: role.color,
    scope: role.scope, status: role.status,
    type: snap.type, primaryProject: snap.primaryProject,
    parentRoleId: role.parentRoleId,
    parentName: parent && !isFail(parent) ? parent.role.name : role.parentRoleId,
    projectIds,
    injectedProjects: snap.primaryProject
      ? [snap.primaryProject, ...injected.filter((s) => s !== snap.primaryProject)]
      : injected,
    ...(snap.legacy ? { legacy: true } : {}),
    ...(notes.length ? { bindNote: notes[0] } : {}),
  };
}

const SYSTEM = [
  cfg.owner?.name
    ? `你是 ${cfg.owner.name} 的私人助理，在这个个人工作台 Ownward 里对话。`
    : "你是这个个人工作台 Ownward 主人的私人助理。",
  "简洁、直接、说人话；代码问题给可运行的代码；不确定就说不确定。",
  "需要最新信息或查资料时用 WebSearch / WebFetch 联网查证。",
  "这是聊天面板：不要读写文件、不要执行命令——重活让用户派任务。",
].join("\n");

/** 历史重放（codex 续聊 / claude 换供应商后的上下文桥接）。
 *  历史里的图片只标注张数，不重发字节：重发既撑爆上下文又重新计费，而且用户问的是"刚发的这张"。 */
function historyPrompt(chat: AiChat, text: string): string {
  const hist = chat.messages.slice(-12, -1) // 最后一条是刚 push 的本条 user 消息
    .map((m) => {
      const note = imageNote(m.images);
      return `[${m.role === "user" ? "用户" : "助理"}] ${note ? `${note} ` : ""}${m.text}`;
    })
    .join("\n\n").slice(-12_000);
  return hist ? `以下是此前的对话历史：\n\n${hist}\n\n---\n\n用户的新消息：${text}` : text;
}

/** 上下文包 = 全局 chat 记忆 +（绑定角色时）角色记忆。两个 provider 共用同一份：
 *  谁少注入一段，用户只能靠对话里「怎么忘了」发现，是最难查的一类差异。 */
async function contextPack(chat: AiChat): Promise<string> {
  const { memoryPack } = await import("./memory.ts");
  const global = memoryPack("chat");
  if (!chat.roleId) return global;
  const { roleMemoryPack } = await import("./roles.ts");
  try {
    // forcedProject 一律显式给：绑定快照说了算，绝不让"角色现在的主项目"回头改写老对话
    // （旧对话没快照 → 传空串 = 明确不强制，项目范围就是它当时选的那些）
    return global + roleMemoryPack(chat.roleId, chat.projectIds, { forcedProject: bindSnapshot(chat).primaryProject });
  } catch (e) {
    // 角色目录被人删了：这轮宁可失败，也不静默按普通对话发出去（假成功禁令）
    throw new Error(`对话绑定的角色 ${chat.roleId} 读不到了（vault 里被删或改名？）：${String(e).slice(0, 120)}`);
  }
}

/** system prompt：固定人设 + 上下文包。claude 走 --append-system-prompt，codex 拼在 prompt 头部，
 *  投递方式不同、内容必须逐字相同——parity 由这一个入口 + claudeArgs/codexPrompt 锁死。 */
export async function chatSystemPrompt(chat: AiChat): Promise<string> {
  return SYSTEM + await contextPack(chat);
}

/** claude 的命令行参数（唯一拼装处，测试按它验注入）。
 *  带图时改走 stream-json 输入：prompt 不再是 argv 参数，而是随 user 帧（含 base64 图片块）走 stdin，
 *  这样模型收到的是真正的多模态输入，而不是一句"用户发了张图"的文字提示。
 *  纯文本路径逐字不变——图片是叠加能力，不许顺手改写已验证过的老路径。 */
export function claudeArgs(chat: AiChat, prompt: string, system: string, hasImages = false): string[] {
  const args = [
    ...(hasImages ? ["-p", "--input-format", "stream-json"] : ["-p", prompt]),
    "--model", chat.model,
    "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    // 联网查证 + 读项目代码（绑定项目时能看源码）：效果对齐原生 CLI
    "--max-turns", "20",
    "--allowedTools", "WebSearch", "WebFetch", "Read", "Grep", "Glob", "Bash",
    "--append-system-prompt", system,
  ];
  if (chat.claudeSessionId) args.push("--resume", chat.claudeSessionId);
  return args;
}

/** codex 无 system 通道：同一份 system 拼在历史重放之前（唯一拼装处） */
export function codexPrompt(chat: AiChat, text: string, system: string): string {
  return `${system}\n\n${historyPrompt(chat, text)}`;
}

/** claude 的 stream-json user 帧（与 agent-session.ts 的 userFrame 同一套编码，唯一拼装处）：
 *  图片块在前、文本在后——Anthropic 的建议顺序，模型先看图再读问题。 */
export function claudeUserFrame(text: string, images: PreparedImage[] = []): string {
  const content: any[] = images.map((im) => ({
    type: "image", source: { type: "base64", media_type: im.mediaType, data: im.bin.toString("base64") },
  }));
  content.push({ type: "text", text });
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

export async function* streamChat(
  text: string, chatId?: string, provider?: string, model?: string, binding?: ChatBindingInput,
  images?: ChatImageInput[],
): AsyncGenerator<ChatEvent> {
  let chat = chatId ? loadChat(chatId) : null;
  // 绑定先过门：非法/试图改绑一律在落盘之前失败
  const b = await resolveChatBinding(chat, binding);
  if (isFail(b)) { yield { type: "error", msg: b.msg }; return; }
  // 图片再过门：路由层已经判过一次，这里是唯一真正落盘的入口，不许绕过（同 resolveChatBinding）
  const iv = validateChatImages(images);
  if (isFail(iv)) { yield { type: "error", msg: iv.msg }; return; }
  const pics = iv.images;
  // 纯图片发送：给一句默认提示，别把空文本丢给模型
  if (!text.trim()) {
    if (!pics.length) { yield { type: "error", msg: "内容为空" }; return; }
    text = defaultImageText(pics.length);
  }
  if (!chat) {
    chat = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: text.replace(/\s+/g, " ").slice(0, 24),
      provider: provider || "claude",
      model: model || cfg.llm?.claudeModel || "sonnet",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      // 绑定快照与 roleId 一起落盘：这三个键是一套，缺一个就说不清这段历史的前提
      ...(b.roleId
        ? {
          roleId: b.roleId, projectIds: b.projectIds ?? [],
          ...(b.roleTypeAtBind ? { roleTypeAtBind: b.roleTypeAtBind } : {}),
          ...(b.primaryProjectAtBind ? { primaryProjectAtBind: b.primaryProjectAtBind } : {}),
        }
        : {}),
    };
  }
  const prevProvider = chat.provider || "claude";
  if (provider) chat.provider = provider;
  if (model) chat.model = model;

  mkdirSync(CHATS_DIR, { recursive: true });
  // 附件先落盘：codex 只能吃文件路径，而且失败要按这份清单精确回滚（下面 catch）
  let files: string[] = [];
  try {
    const saved = persistChatImages(chat.id, pics);
    files = saved.files;
    chat.messages.push({ role: "user", text, ts: new Date().toISOString(), ...(saved.metas.length ? { images: saved.metas } : {}) });
  } catch (e) {
    removeChatImageFiles(files);
    yield { type: "error", msg: `图片保存失败：${String(e).slice(0, 160)}` };
    return;
  }

  let reply = "";
  try {
    // 两个 provider 同吃这一份（含角色记忆）：换供应商上下文不该变
    const system = await chatSystemPrompt(chat);
    if (chat.provider === "codex" || chat.provider === "codex-alt") {
      reply = yield* runCodex(chat, text, system, files);
    } else {
      // claude / codebuddy（协议克隆）同走 stream-json 通道；供应商切换或还没有会话 → 历史重放兜底上下文
      const active = chat.provider === "codebuddy" ? "codebuddy" : "claude";
      // claude↔codebuddy 的 session id 不互通，跨这两家切换必须丢弃再 resume 会直接报错
      if ((prevProvider === "claude" || prevProvider === "codebuddy") && prevProvider !== active) chat.claudeSessionId = undefined;
      const bridged = prevProvider !== active || !chat.claudeSessionId;
      reply = yield* runClaude(chat, bridged ? historyPrompt(chat, text) : text, system, pics);
    }
  } catch (e) {
    yield { type: "error", msg: String(e).slice(0, 200) };
    // 失败不落这条：用户消息弹掉，刚写的附件字节也一并删掉（不留孤儿附件）
    chat.messages.pop();
    removeChatImageFiles(files);
    return;
  }

  chat.messages.push({ role: "assistant", text: reply, ts: new Date().toISOString() });
  chat.updatedAt = new Date().toISOString();
  saveChat(chat);
  yield { type: "done", chat };
}

// ---- assistant 消息 → 候选记忆（人点的，只写 _candidates） ----
// 这里是三道人工审批门之一的入口侧：写候选而已，晋升永远是另一次人工点击
// （角色候选去角色页，项目候选去项目专家详情）。别在这个文件里加任何"自动存候选/自动晋升"的调用点。
//
// 归属二选一，语义不同、别混：
//   role    → roles/<角色>/_candidates：这个角色的通用原则/决策/待办（换项目还成立）；
//   project → projects/<主项目>/_candidates：只对这个项目成立的事实/决策/运维，跟着项目走。
export type CandidateTarget = "role" | "project";

export interface SavedCandidate {
  id: string;
  /** 落在哪：角色 id 或项目 slug（前端拿它拼提示语，不猜） */
  owner: string;
  target: CandidateTarget;
}

export async function candidateFromMessage(
  chat: AiChat, index: unknown, text?: unknown, target?: unknown,
): Promise<{ ok: true; candidate: RoleCandidate | ProjectCandidate; saved: SavedCandidate; msg: string } | Fail> {
  if (!chat.roleId) return { ok: false, code: "invalid", msg: "这个对话没有绑定角色，存不了候选记忆" };
  const to: CandidateTarget = target === undefined || target === null || target === "" ? "role" : target as CandidateTarget;
  if (to !== "role" && to !== "project") {
    return { ok: false, code: "invalid", msg: `候选归属只能是 role / project：${String(target).slice(0, 20)}` };
  }
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= chat.messages.length) {
    return { ok: false, code: "invalid", msg: `消息序号不存在：${String(index).slice(0, 20)}` };
  }
  const m = chat.messages[i];
  if (m.role !== "assistant") return { ok: false, code: "invalid", msg: "只能保存 AI 的回复（自己说的话不算结论）" };

  // 人可以改写成一句话；不改写就原文存，超长由落盘层明确拒绝——不截断（截断=悄悄改写结论）
  const body = String(text ?? "").trim() || m.text.trim();
  if (!body) return { ok: false, code: "invalid", msg: "候选内容为空" };
  const evidence = body === m.text.trim() ? "" : m.text;   // 原文存时证据就是它自己，不重复一遍

  if (to === "role") {
    const { createRoleCandidate } = await import("./roles.ts");
    const r = createRoleCandidate(chat.roleId, { text: body, evidence, sourceChatId: chat.id });
    if (isFail(r)) return r;
    log(`chat: ${chat.id} #${i} → 角色 ${chat.roleId} 候选 ${r.candidate.id}（待人工晋升）`);
    return {
      ok: true, candidate: r.candidate, saved: { id: r.candidate.id, owner: chat.roleId, target: "role" },
      msg: "已存为角色候选，去角色页人工晋升",
    };
  }

  // 项目候选：项目取自**绑定快照**、scope 取自角色（scope 不可改，稳定）——
  // 客户端给不了任意 slug，角色后来换主项目也不会让老对话的结论漂到新项目上。
  const snap = bindSnapshot(chat);
  const { resolveRole } = await import("./roles.ts");
  const rr = resolveRole(chat.roleId);
  if (isFail(rr)) return rr;
  const role = rr.role;
  if (snap.legacy) {
    // 旧对话没有快照：就算角色现在是项目专家，也说不清这段对话当初是围着哪个项目谈的
    return {
      ok: false, code: "invalid",
      msg: `这个对话建于项目专家之前（没有绑定快照），存不了项目候选——存成角色候选，或另开一个项目专家对话`,
    };
  }
  if (!snap.primaryProject) {
    return { ok: false, code: "invalid", msg: `这个对话绑的是职能负责人 ${role.id}，没有主项目——项目结论请在对应项目专家的对话里存` };
  }
  const { createProjectCandidate } = await import("./project-memory.ts");
  const r = createProjectCandidate(snap.primaryProject, role.scope, {
    text: body, evidence, sourceChatId: chat.id, sourceRoleId: role.id,
  });
  if (isFail(r)) return r;
  log(`chat: ${chat.id} #${i} → 项目 ${snap.primaryProject} 候选 ${r.candidate.id}（待人工晋升）`);
  return {
    ok: true, candidate: r.candidate, saved: { id: r.candidate.id, owner: snap.primaryProject, target: "project" },
    msg: `已存为项目候选（${snap.primaryProject}），去角色页人工晋升`,
  };
}

export async function saveChatCandidate(
  chatId: string, index: unknown, text?: unknown, target?: unknown,
): Promise<{ ok: true; candidate: RoleCandidate | ProjectCandidate; saved: SavedCandidate; msg: string } | Fail> {
  const chat = loadChat(String(chatId || ""));
  if (!chat) return { ok: false, code: "not_found", msg: "对话不存在" };
  return candidateFromMessage(chat, index, text, target);
}

async function* runClaude(chat: AiChat, prompt: string, system: string, images: PreparedImage[] = []): AsyncGenerator<ChatEvent, string> {
  const withImages = images.length > 0;
  const bin = chat.provider === "codebuddy" ? (cfg.llm?.codebuddyBin || "codebuddy") : (cfg.llm?.claudeBin || "claude");
  // 工作目录：绑定项目时切到项目目录（能读源码），否则用 CHATS_DIR
  const workDir = bindSnapshot(chat).primaryProject || CHATS_DIR;
  const proc = Bun.spawn([bin, ...claudeArgs(chat, prompt, system, withImages)], {
    cwd: workDir, stdout: "pipe", stderr: "pipe", stdin: withImages ? "pipe" : "ignore",
    env: { ...process.env, DISABLE_OMC: "1" },
  });
  if (withImages) {
    // 一帧发完就关 stdin：对话是一问一答，EOF 是 CC 结束本轮退出的信号
    // （不关就一直等下一帧，这轮永远读不到 result）
    proc.stdin.write(claudeUserFrame(prompt, images));
    proc.stdin.end();
  }

  let acc = "";
  let final: string | null = null;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.session_id) chat.claudeSessionId = ev.session_id;
        const delta = ev.event?.delta;
        if (ev.type === "stream_event" && delta?.type === "text_delta" && delta.text) {
          acc += delta.text;
          yield { type: "delta", text: delta.text };
        } else if (ev.type === "assistant") {
          // 联网工具调用 → 给客户端一个"搜索中"状态
          for (const c of ev.message?.content ?? []) {
            if (c?.type === "tool_use") {
              const label = c.name === "WebSearch" ? "联网搜索" : c.name === "WebFetch" ? "抓取网页" : null;
              if (!label) continue; // ToolSearch 等基建调用不值得展示
              const q = c.input?.query || c.input?.url || "";
              yield { type: "tool", text: `${label}${q ? "：" + String(q).slice(0, 80) : ""}` };
            }
          }
        } else if (ev.type === "result") {
          final = ev.result ?? null;
        }
      } catch { /* skip non-json */ }
    }
  }
  const code = await proc.exited;
  // 已流出完整回复时容忍收尾期的非零退出（别把整轮对话连图片附件一起弹掉）；
  // 失败要可观测：留日志，不许静默吞
  if (code !== 0 && !acc && !final) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${bin} 出错: ${err.slice(-200)}`);
  }
  if (code !== 0) log(`chat: ${bin} 非零退出(code=${code})但已有输出，保留回复`);
  return final ?? acc;
}

async function* runCodex(chat: AiChat, text: string, system: string, imageFiles: string[] = []): AsyncGenerator<ChatEvent, string> {
  const prompt = codexPrompt(chat, text, system);
  // 图片走已落盘的附件路径（codex exec 没有 stdin 内联通道）。用 `--image=` 连写：
  // -i / --image 是贪婪多值参数，空格分隔会把后面的 prompt 一起吞成图片路径（codex-session.ts 的血泪）
  const imgArgs = imageFiles.map((f) => `--image=${f}`);
  // 推理力度（fast 聊天体验）：config chat.codexEffort ∈ minimal/low/medium/high，空=账号默认
  const effort = ["minimal", "low", "medium", "high"].includes(cfg.chat?.codexEffort) ? [`-c`, `model_reasoning_effort=${cfg.chat.codexEffort}`] : [];
  // 工作目录：绑定项目时切到项目目录（能读源码），否则用 CHATS_DIR
  const workDir = bindSnapshot(chat).primaryProject || CHATS_DIR;
  // 沙箱：绑定项目时 workspace-write（可改代码跑命令），否则 read-only
  const sandbox = bindSnapshot(chat).primaryProject ? "workspace-write" : "read-only";
  const base = ["exec", "--skip-git-repo-check", "-C", workDir, "--sandbox", sandbox, ...effort, ...imgArgs];
  // codex-alt = 第二个 ChatGPT 账号（独立 CODEX_HOME / 独立额度）
  const env = chat.provider === "codex-alt"
    ? { CODEX_HOME: `${process.env.HOME}/.codex-alt` }
    : undefined;
  const bin = cfg.llm?.codexBin || "codex";
  const withModel = chat.model && chat.model !== "default";

  let r = await run([bin, ...base, ...(withModel ? ["-m", chat.model] : []), prompt],
    { timeoutMs: 300_000, cwd: workDir, env });
  // ChatGPT 账号只能用账号默认模型：指定 -m 会 400，自动去掉重试一次
  if (r.code !== 0 && withModel && /model.*not supported|invalid_request/i.test(r.stderr || r.stdout)) {
    log(`chat: codex 模型 ${chat.model} 不支持，回退默认`);
    chat.model = "default";
    r = await run([bin, ...base, prompt], { timeoutMs: 300_000, cwd: CHATS_DIR, env });
  }
  if (r.code !== 0) throw new Error(`codex 出错: ${(r.stderr || r.stdout).slice(-200)}`);
  // codex 无 token 流：最终结果一次性作为 delta 发出
  const reply = r.stdout.trim();
  yield { type: "delta", text: reply };
  return reply;
}
