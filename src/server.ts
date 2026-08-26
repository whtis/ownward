// Dashboard server：127.0.0.1 only。静态 UI + JSON API + SSE 实时流。
// SSE 靠 watch feed.jsonl 文件驱动——CLI 等外部进程写入的通知也能实时到达页面。
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch } from "fs";
import { join } from "path";
import { loadTasks } from "./dispatch.ts";
import { FEED_FILE, readFeed } from "./feed.ts";
import { runHeartbeat } from "./heartbeat.ts";
import { notify } from "./notify.ts";
import { queueSize } from "./spool.ts";
import { isDevDomainRoute, reloadVertical, routeVerticals, verticalDiagnostics } from "./verticals.ts";
import { runTriage } from "./triage.ts";
import { OWNWARD_DIR, VAULT_ROOT } from "./paths.ts";
import { DATA, ROOT, cfg, fmt, loadState, log, run } from "./util.ts";
import { handleWorkbench } from "./workbench.ts";
import { connectorSourceSnapshot } from "./connector-config.ts";

const INDEX = join(ROOT, "web", "index.html");
const sseClients = new Set<ReadableStreamDefaultController>();
export const CORE_API_PATHS = ["/api/state", "/api/feed", "/api/tasks", "/api/events"] as const;
export const SSE_EVENT_NAMES = ["state", "feed", "tasks"] as const;

export function formatSseEvent(event: typeof SSE_EVENT_NAMES[number], data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function shouldBroadcastTaskUpdate(method: string, pathname: string, response: Response | null): boolean {
  return method === "POST" && pathname === "/api/work" && response?.ok === true;
}

function stateSnapshot() {
  const s = loadState();
  return {
    now: new Date().toISOString(),
    pid: process.pid,
    queue: queueSize(),
    health: s.health || {},
    lastTriageAt: s.lastTriageAt || null,
    lastHeartbeatAt: s.lastHeartbeatAt || null,
    triageIntervalMin: cfg.triage.intervalMin,
    heartbeatIntervalMin: cfg.heartbeat.intervalMin,
    quietHours: cfg.quietHours,
    vaultToday: join(OWNWARD_DIR, `${fmt(new Date(), "date")}.md`),
    vaultRoot: VAULT_ROOT,   // 客户端剥 vault 相对路径用（别在客户端硬编码目录名）
    allowFullAccess: cfg.architecture?.allowFullAccess === true,
    // 派发弹窗的默认值（config: dispatch.defaults = {dir, model, permission, codex}）——前端不硬编码
    dispatchDefaults: cfg.dispatch?.defaults && typeof cfg.dispatch.defaults === "object" ? cfg.dispatch.defaults : {},
    // 任意 gmail*.json 即视为已配置（多账号）
    gmailConfigured: (() => {
      try {
        const { readdirSync } = require("fs") as typeof import("fs");
        return readdirSync(join(DATA, "secrets")).some((f) => /^gmail(-.+)?\.json$/.test(f));
      } catch { return false; }
    })(),
    sources: connectorSourceSnapshot(cfg),
  };
}

function broadcast(event: typeof SSE_EVENT_NAMES[number], data: unknown) {
  const msg = formatSseEvent(event, data);
  for (const c of sseClients) {
    try { c.enqueue(msg); } catch { sseClients.delete(c); }
  }
}

function watchFeed() {
  let offset = existsSync(FEED_FILE) ? statSync(FEED_FILE).size : 0;
  const emit = () => {
    if (!existsSync(FEED_FILE)) return;
    const size = statSync(FEED_FILE).size;
    if (size <= offset) { offset = size; return; }
    // 按字节增量读：之前用字符 slice 配字节 offset，中文内容会切错位产生坏 JSON
    const fd = openSync(FEED_FILE, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
      try { broadcast("feed", JSON.parse(line)); } catch { /* skip */ }
    }
  };
  try {
    watch(DATA, (_, file) => { if (file === "feed.jsonl") emit(); });
  } catch (e) { log(`feed watch failed: ${e}`); }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** 远程访问（iPhone 真机走 Tailscale）：listen="all" 才对外监听，且非本机请求必须带 token */
/** 令牌比较用常数时间,不给远程侧留时序侧信道 */
function tokenEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try { return require("crypto").timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// 远程模式下浏览器未带凭证时的令牌输入页(输入后走 ?token= 引导换 cookie)
const TOKEN_PAGE = `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ownward · 访问令牌</title>
<body style="font:14px/1.6 -apple-system,'PingFang SC',sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<form onsubmit="location.search='token='+encodeURIComponent(document.getElementById('t').value.trim());return false" style="text-align:center;max-width:340px">
<p style="margin-bottom:12px">远程访问需要<b>访问令牌</b><br><span style="color:#6e7681;font-size:12px">在主机的 data/secrets/api-token.txt 里,找管理员要一次即可,本浏览器会记住</span></p>
<input id="t" autofocus autocomplete="off" style="padding:9px 12px;width:100%;box-sizing:border-box;border-radius:9px;border:1px solid #2d333c;background:#161b22;color:#e6edf3;font-family:ui-monospace,monospace">
<button style="margin-top:10px;padding:8px 18px;border-radius:9px;border:1px solid #2b527f;background:#1f3a5f;color:#a8cdff;cursor:pointer">进入</button></form>`;

// 失败限速：同 IP 10 分钟窗口 40 次带凭证的失败尝试 → 封 10 分钟（防 token 爆破）。
// 只计「带了凭证但错了」的请求——裸访问(无 token/cookie)只会看到令牌页,不计数,
// 避免换了 token 后旧 cookie 的浏览器自己把自己刷进小黑屋。
const authFails = new Map<string, { n: number; winAt: number; until: number }>();
function authBlocked(ip: string): boolean {
  const e = authFails.get(ip);
  return !!e && Date.now() < e.until;
}
function authFail(ip: string) {
  if (authFails.size > 2000) authFails.clear();  // 攻击面兜底,别让 Map 无限长
  const now = Date.now();
  const e = authFails.get(ip);
  if (!e || now - e.winAt > 600_000) { authFails.set(ip, { n: 1, winAt: now, until: 0 }); return; }
  e.n++;
  if (e.n >= 40) { e.until = now + 600_000; e.n = 0; e.winAt = now; }
}

function loadApiToken(): string {
  const dir = join(DATA, "secrets"), f = join(dir, "api-token.txt");
  const { chmodSync, mkdirSync, writeFileSync } = require("fs") as typeof import("fs");
  try {
    const tok = readFileSync(f, "utf8").trim();
    // 收紧历史安装留下的宽权限（早期版本按 umask 落成 0644/0755）
    try { chmodSync(dir, 0o700); chmodSync(f, 0o600); } catch { /* 尽力而为 */ }
    return tok;
  } catch { /* 首次生成 */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* 已存在目录 mkdir 不会重设 mode */ }
  const tok = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  writeFileSync(f, tok, { mode: 0o600 });
  return tok;
}

export function startServer() {
  const port = cfg.dashboard?.port || 4517;
  const listenAll = cfg.dashboard?.listen === "all";
  const apiToken = listenAll ? loadApiToken() : "";
  watchFeed();
  setInterval(() => broadcast("state", stateSnapshot()), 15_000);

  // 统一安全响应头。web 大量使用内联 onclick/style，CSP 必须带 unsafe-inline——
  // 这层的价值是禁外源脚本/连接（限制数据外传面）+ 禁 iframe 内嵌，不是内联 XSS 的
  // 完整防线（那由前端 esc() 转义纪律负责，见 web/app.js 头注）。
  const secure = (res: Response): Response => {
    const h = res.headers;
    if (!h.has("X-Content-Type-Options")) h.set("X-Content-Type-Options", "nosniff");
    if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "DENY");
    if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "no-referrer");
    if ((h.get("Content-Type") || "").includes("text/html") && !h.has("Content-Security-Policy"))
      h.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    return res;
  };

  const handle = async (req: Request, server: { requestIP(req: Request): { address: string } | null }): Promise<Response> => {
      const url = new URL(req.url);
      const p = url.pathname;

      // 请求体全局护栏：已知最大合法 body 是图片 send（约 20MB，路由内还有流式硬停）。
      // 超大声明直接 413；不带长度的 chunked 上传没有合法来源（浏览器 fetch 一律带 Content-Length），拒收。
      if (req.method !== "GET" && req.method !== "HEAD") {
        if ((req.headers.get("transfer-encoding") || "").includes("chunked")) return new Response("length required", { status: 411 });
        if (Number(req.headers.get("content-length") || 0) > 32 * 1024 * 1024) return new Response("payload too large", { status: 413 });
      }

      // CSRF / DNS-rebinding 防护（仅默认 localhost 模式；listenAll 远程模式靠下面的 token 鉴权）。
      // 恶意网页用 fetch 打 localhost:4517 时，浏览器带的 Host 是攻击者域名（DNS rebinding 也会暴露）→ 拒；
      // 原生客户端 / 本地 web dashboard 都发 127.0.0.1|localhost。状态变更再查 Origin（浏览器跨站必带，
      // 原生 URLSession 不带 Origin 故放行）。见安全评审 HIGH#1。
      if (!listenAll) {
        const host = req.headers.get("host") || "";
        const okHost = host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
        if (!okHost) return new Response("invalid host", { status: 403 });
        if (req.method !== "GET" && req.method !== "HEAD") {
          const origin = req.headers.get("origin");
          if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}` && origin !== `http://[::1]:${port}`) {
            return new Response("csrf blocked", { status: 403 });
          }
        }
      }

      if (listenAll) {
        const ip = server.requestIP(req)?.address || "";
        // 本地反代(frp/nginx 转发到 127.0.0.1)会让远程流量看起来像本机——带 X-Forwarded-* 的一律按远程对待。
        // 注意:纯 TCP 转发不带这些头,识别不出来;要反代必须用 http 模式(会加 X-Forwarded-For)。
        const proxied = !!(req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip"));
        const isLocal = !proxied && (ip === "127.0.0.1" || ip === "::1" || ip.endsWith("127.0.0.1"));
        if (!isLocal) {
          if (authBlocked(ip)) return new Response("尝试次数过多，10 分钟后再试", { status: 429 });
          // TLS 终结在反代（cloudflared/nginx）时给 cookie 加 Secure，纯内网 http（Tailscale IP 直连）不加
          const secure = (req.headers.get("x-forwarded-proto") || "").includes("https") ? "; Secure" : "";
          // 登出：清 cookie 回令牌页（不需要已登录，幂等）
          if (p === "/logout") {
            return new Response(null, { status: 302, headers: {
              "Location": "/",
              "Set-Cookie": `ownward_token=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`,
            } });
          }
          const cookieTok = (req.headers.get("cookie") || "").match(/(?:^|;\s*)ownward_token=([A-Za-z0-9]+)/)?.[1] || "";
          const bearer = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
          const authed = tokenEq(bearer, apiToken) || tokenEq(cookieTok, apiToken);
          if (!authed) {
            // 浏览器引导:?token=xxx 验证通过 → 换 HttpOnly cookie → 跳回干净 URL(令牌不留在地址栏)
            const qt = url.searchParams.get("token") || "";
            if (tokenEq(qt, apiToken)) {
              authFails.delete(ip);
              url.searchParams.delete("token");
              return new Response(null, { status: 302, headers: {
                "Location": url.pathname + url.search,
                "Set-Cookie": `ownward_token=${apiToken}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=31536000`,
              } });
            }
            if (qt || bearer || cookieTok) authFail(ip);  // 带了凭证但错了才计数
            if ((req.headers.get("accept") || "").includes("text/html")) {
              return new Response(TOKEN_PAGE, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
            }
            return new Response("unauthorized", { status: 401 });
          }
          authFails.delete(ip);
          // cookie 会话有 CSRF 面:改状态请求若带 Origin,必须与 Host 同源(Bearer 的 API 客户端不带 Origin,放行)
          if (req.method !== "GET" && req.method !== "HEAD") {
            const origin = req.headers.get("origin");
            if (origin) {
              let oh = "";
              try { oh = new URL(origin).host; } catch {}
              if (oh !== (req.headers.get("host") || "")) return new Response("csrf blocked", { status: 403 });
            }
          }
        }
      }

      // no-cache：响应本身没带校验器，浏览器启发式缓存会让 PWA 长期跑旧 JS——本地小文件，每次取最新
      if (p === "/") {
        return new Response(readFileSync(INDEX), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
      }
      // web/ 静态资源：单段文件名白名单后缀——正则本身排除 / 和 ..，无路径穿越面
      if (req.method === "GET" && /^\/[\w.-]+\.(js|css|html|svg|png|ico|woff2|webmanifest)$/.test(p)) {
        const f = join(ROOT, "web", p.slice(1));
        if (existsSync(f)) {
          const mime = p.endsWith(".js") ? "text/javascript; charset=utf-8"
            : p.endsWith(".css") ? "text/css; charset=utf-8"
            : p.endsWith(".html") ? "text/html; charset=utf-8"
            : p.endsWith(".svg") ? "image/svg+xml"
            : p.endsWith(".webmanifest") ? "application/manifest+json"
            : p.endsWith(".woff2") ? "font/woff2" : "image/png";
          // 字体大且几乎不变给周级缓存；其余保持 no-cache（防 PWA 跑旧前端）
          const cache = p.endsWith(".woff2") ? "public, max-age=604800" : "no-cache";
          return new Response(readFileSync(f), { headers: { "Content-Type": mime, "Cache-Control": cache } });
        }
      }
      // 皮肤壁纸资产：sha 寻址（内容不可变 → immutable 缓存），文件名严格正则无穿越面
      const skinAssetM = p.match(/^\/skin-asset\/([a-f0-9]{16,64}\.(?:webp|jpe?g|png))$/);
      if (req.method === "GET" && skinAssetM) {
        const { skinAsset } = await import("./skins.ts");
        const a = skinAsset(skinAssetM[1]);
        if (a) return new Response(a.bin, { headers: { "Content-Type": a.mime, "Cache-Control": "public, max-age=31536000, immutable" } });
        return new Response("not found", { status: 404 });
      }
      // 会话图片（agent 截图/读图，data/runner/agent-images/）：内容寻址不可变 → immutable 缓存
      const agentImgM = p.match(/^\/api\/agent-image\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/([a-f0-9]{16}\.(?:png|jpg|webp|gif))$/);
      if (req.method === "GET" && agentImgM) {
        const { readAgentImage } = await import("./runner/agent-images.ts");
        const img = readAgentImage(DATA, agentImgM[1], agentImgM[2]);
        if (img) return new Response(img.bin, { headers: { "Content-Type": img.mime, "Cache-Control": "public, max-age=31536000, immutable" } });
        return new Response("not found", { status: 404 });
      }
      const sessionImgM = p.match(/^\/api\/session-image\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/([a-f0-9]{64})$/);
      if ((req.method === "GET" || req.method === "HEAD") && sessionImgM) {
        const { readSessionImage } = await import("./kernel/sessions/session-images.ts");
        const img = readSessionImage(DATA, sessionImgM[1], sessionImgM[2]);
        if (img) return new Response(req.method === "HEAD" ? null : img.bin, { headers: { "Content-Type": img.mime, "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" } });
        return new Response("not found", { status: 404 });
      }
      // Android 客户端自更新：data/app/ 由 scripts/android-release.sh 写入（APK 不进 git）
      if (p === "/api/app/android") {
        const f = join(DATA, "app", "android.json");
        if (!existsSync(f)) return json({ ok: false, msg: "尚未发布安卓版本" }, 404);
        return new Response(readFileSync(f), { headers: { "Content-Type": "application/json" } });
      }
      // iOS 客户端「检查更新」：data/app/ios.json 由 scripts/ios-release.sh 写入
      // （{ok,versionName,versionCode,notes,url}，url 为 TestFlight/安装页；ipa 不进 git）
      if (p === "/api/app/ios") {
        const f = join(DATA, "app", "ios.json");
        if (!existsSync(f)) return json({ ok: false, msg: "尚未发布 iOS 版本" }, 404);
        return new Response(readFileSync(f), { headers: { "Content-Type": "application/json" } });
      }
      if (req.method === "GET" && p === "/app/ownward.apk") {
        const f = join(DATA, "app", "ownward.apk");
        if (!existsSync(f)) return new Response("not found", { status: 404 });
        return new Response(Bun.file(f), {
          headers: { "Content-Type": "application/vnd.android.package-archive", "Cache-Control": "no-cache" },
        });
      }
      if (p === "/api/state") return json(stateSnapshot());
    if (p === "/api/system/verticals") return json(await verticalDiagnostics());
    if (req.method === "POST" && p === "/api/system/verticals/reload") {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const id = String(body.id || "");
      if (!id) return json({ ok: false, msg: "缺 id" }, 400);
      try { return json({ ok: true, status: await reloadVertical(id) }); }
      catch (e: any) { return json({ ok: false, code: e?.code || "VERTICAL_RELOAD_FAILED", msg: String(e?.message || e).slice(0, 200) }, e?.code === "VERTICAL_NOT_FOUND" ? 404 : 400); }
    }
    if (p === "/api/system/connectors") return json(await (await import("./connectors.ts")).connectorDiagnostics());
    if (p === "/api/system/runtime-health") return json((await import("./release/runtime-health.ts")).runtimeHealth());
      if (isDevDomainRoute(p)) {
        const dev = await routeVerticals(req, url);
        if (!dev && p === "/api/work") return json({ ok: false, code: "DEV_ROOTS_NOT_CONFIGURED", msg: "未配置 architecture.allowedRoots，拒绝派发任务" }, 403);
        if (shouldBroadcastTaskUpdate(req.method, p, dev)) broadcast("tasks", loadTasks().slice(-30).reverse());
        return dev ?? new Response("not found", { status: 404 });
      }
      const wb = await handleWorkbench(req, url);
      if (wb) return wb;
      const vr = await routeVerticals(req, url);
      if (vr) return vr;
      if (p === "/api/feed") return json(readFeed(parseInt(url.searchParams.get("limit") || "100", 10)));
      if (p === "/api/tasks") return json(loadTasks().slice(-30).reverse());

      if (p === "/api/events") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            sseClients.add(c);
            c.enqueue(formatSseEvent("state", stateSnapshot()));
          },
          cancel() { sseClients.delete(ctrl); },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      if (req.method === "POST" && p === "/api/action") {
        const { action } = await req.json() as { action: string };
        if (action === "triage") { runTriage().then(() => broadcast("state", stateSnapshot())); return json({ ok: true, msg: "triage 已触发" }); }
        if (action === "heartbeat") { runHeartbeat().then(() => broadcast("state", stateSnapshot())); return json({ ok: true, msg: "heartbeat 已触发" }); }
        if (action === "test-notify") { notify("✅ dashboard 测试通知", { source: "system" }); return json({ ok: true, msg: "已发送" }); }
        if (action === "open-vault") {
          // 走本机 open 命令：webview 里自定义协议跳转会被 WKWebView 拦截。
          // 打开器按平台分：Windows 上没有 `open`，硬调会抛 ENOENT 并把整个请求
          // 变成 500 HTML 错误页（不是 JSON），前端只会看到一坨乱码。
          const uri = `obsidian://open?path=${encodeURIComponent(stateSnapshot().vaultToday)}`;
          const opener = process.platform === "darwin" ? ["open", uri]
            : process.platform === "win32" ? ["cmd", "/c", "start", "", uri]
            : ["xdg-open", uri];
          try { Bun.spawn(opener, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); }
          catch { return json({ ok: false, msg: "打不开 Obsidian（没装，或系统没注册 obsidian:// 协议）" }, 500); }
          return json({ ok: true, msg: "已在 Obsidian 打开" });
        }
        return json({ ok: false, msg: `未知动作: ${action}` }, 400);
      }

      // daemon 重启：交给独立 launchd one-shot helper；它延迟两秒，让本响应先送达。
      // 两步：不带 confirm 先回「谁会被中断」，客户端确认后再带 confirm 真重启。
      if (req.method === "POST" && p === "/api/system/restart") {
        const { launchdManaged, requestRestart } = await import("./restart.ts");
        if (!await launchdManaged()) {
          return json({ ok: false, msg: "当前实例不由 launchd 托管（dev/前台运行），退出后没人拉起，不给重启" }, 400);
        }
        const body = await req.json().catch(() => ({})) as { confirm?: boolean };
        const running = loadTasks().filter((t) => t.status === "running")
          .map((t) => ({ id: t.id, title: t.title || t.task.split("\n")[0].slice(0, 40) }));
        if (!body.confirm) return json({ ok: false, needConfirm: true, pid: process.pid, running });
        const helper = await requestRestart("dashboard");
        return json({ ok: true, pid: process.pid, helper, msg: "daemon 重启已交给独立 helper…" });
      }

      // 目录选择走浏览器内弹窗：旧 /api/pick-dir 的 osascript Finder 弹在 daemon 那台机器的
      // 屏幕上，远程打开 web 时浏览器只会挂死到超时。列目录严格圈在 architecture.allowedRoots
      // （realpath 归一化 + 前缀匹配，见 fs-browse.ts），派任务本来也只允许这些根。
      if (req.method === "GET" && p === "/api/fs/dirs") {
        const { listDirs } = await import("./fs-browse.ts");
        const r = listDirs(url.searchParams.get("path"), cfg.architecture?.allowedRoots ?? []);
        return json(r, r.ok ? 200 : 400);
      }

      return new Response("not found", { status: 404 });
  };

  const srv = Bun.serve({
    hostname: listenAll ? "0.0.0.0" : "127.0.0.1",
    port,
    idleTimeout: 120, // SSE 长连接：默认 10s 会掐断流；配合 15s 的 state 推送保活
    async fetch(req, server) { return secure(await handle(req, server)); },
  });
  log(`dashboard: http://127.0.0.1:${port}`);  // 原先写在 return 之后，从没执行过
  return srv;
}
