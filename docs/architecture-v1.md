# Ownward v1 架构重构：Kernel / Provider / Connector / Vertical

状态：Alpha 参考实现；扩展契约会在公开试用中继续收敛
范围：Ownward v1 内部架构与扩展契约  
原则：保持现有行为和数据，渐进迁移，不做大爆炸重写

## 1. 背景与问题

Ownward 已从个人工作台演进为一个可承载不同专业领域的本地 Agent 工作底座。当前产品同时具备事件采集、Action、编码任务、Claude/Codex 会话、Vault、通知和 Web 工作台；不同领域可以在同一底座上以 Vertical 实现。

方向已经成立，但源码边界还停留在单一产品阶段：

- `src/daemon.ts` 直接启动 Lark、Gmail、GitHub、Stock，并直接看护 Agent 与任务。
- `src/server.ts` 直接调用 `dispatch.ts`、`workbench.ts` 和 vertical 路由。
- `src/workbench.ts` 同时处理通用会话、任务、Vault、Gmail、飞书和研发演进接口。
- `src/dispatch.ts` 把通用 Task 持久化、Agent Run、Git worktree、Terminal 启动及 Ownward 自演进混在一起。
- `src/agent-backend.ts` 已提供统一外观，但内部仍通过 `hasCodexSession` 和任务 mode 判断 `agent-session.ts` / `codex-session.ts`。
- `src/verticals.ts` 只有 `start + route`，模块直接 import 内核文件，没有稳定 Context、资源隔离、版本约束和生命周期状态。
- `src/sources/*` 既负责外部接入，也夹带领域处理和通知策略，尚不是统一 Connector。

这种结构能支持当前单机产品，但继续加入新的 Agent CLI、外部系统或领域工作流时，会迫使每个扩展了解内部磁盘格式、路由和进程实现，最终再次形成 fork。v1 的目标是收紧依赖方向，让 Ownward 成为一个小而稳定的内核，并允许 Provider、Connector、Vertical 独立演进。

## 2. 设计原则

1. **任务与会话是内核原语。** Task、Run、Session、Action、Event 是不同领域共同使用的基础能力，不整体插件化。
2. **领域工作流不是内核。** Git worktree、diff、commit、PR、`own work` 和 `own evolve` 属于内置 `dev` Vertical。
3. **Provider 与 Vertical 分离。** Provider 回答“由哪个 Agent 执行”；Vertical 回答“在什么领域做什么”。领域 Vertical 不实现 Codex/Claude 调用。
4. **Connector 只负责接入。** Connector 将外部变化规范化为 Event，Vertical 或内核策略决定如何处理。
5. **依赖只能指向稳定契约。** Vertical、Connector、Provider 不直接 import Kernel 私有实现和数据文件。
6. **先包裹、后迁移。** 现有实现先放到 Service/Adapter 后面，数据格式和 API 保持不变，再逐步移动代码。
7. **显式失败，不假成功。** 不支持的 capability、加载失败、事件丢弃、队列溢出必须可观测。
8. **单用户、本地优先。** v1 保持零 npm 运行时依赖和 macOS 本地 daemon 模型。
9. **审批语义不可含混。** evolve 上线、routine 草稿写入、memory 候选合并三道既有审批门不得被绕过；发送消息、合并 PR 等外部动作还须各自的用户策略或审批，不能笼统称为“第四道门”。
10. **用户连续性优先。** 任务和会话跨 daemon 重启后必须可继续；不能再把所有在途执行无差别收敛成退出码 130。

## 3. 非目标

v1 不做插件市场、第三方自动下载、代码签名、沙箱执行、热更新、多租户、多版本依赖求解或跨机器集群。Vertical 是用户明确安装并信任的本地代码；禁用和升级允许重启 daemon。也不在此次重构中重做前端框架、替换文件存储或改变现有 API/SSE 契约。

## 4. 术语与状态归属

- **Event**：已经发生的事实，如 `mail.received`、`call.finished`。关键事件至少一次投递，进入 spool 后消费成功前不删除。
- **Action**：需要 owner 处理或确认的事项。它不是后台任务；具体状态机沿用当前实现并另立契约，本 RFC 不把可能形成死状态的 `processing` 固化为公共 API。
- **Task**：一件有目标、状态和产物的工作，描述“要完成什么”，可跨多个 Run。
- **Run**：一次 Agent turn，即从一条用户输入开始，到该轮完成、失败、取消或中断为止。Run 不是 OS 进程，也不是整个 Task 的“执行尝试”；每次追问都会产生新 Run，并 append-only 落盘。
- **Session**：与 Agent 持续交互的上下文，绑定 Provider 原生 session ref，可关联 Task、Run 和领域 subject，负责续聊、输入权、interrupt 与审批。

约束：Task 不等于 Session，Session 不等于 Provider 进程，Action 也不等于 Event。一个 Task 可关联一个或多个 Session；一个 Session 包含多个 Run。Claude 的 session id、Codex rollout id 等差异只存在于 Provider 私有 ref，Kernel 对外只暴露 Ownward session id。

## 5. 四类模块边界

### 5.1 Kernel

Kernel 只提供通用运行时：daemon 生命周期、配置、Storage/migration、Event Bus 与 spool、Action Service、Task/Run Service、Session Service、审批、Provider/Connector/Vertical Registry、Scheduler、通知、HTTP/SSE 基础设施、Vault 边界、安全、备份恢复和可观测性。

`Task Runtime`、`Agent Session` 与 `Action` 留在 Kernel。最近会话、置顶和基础任务列表可以作为 Web Shell 的内置视图；其底层数据仍由 Kernel Service 提供。

### 5.2 Provider

Provider 是 Agent 执行适配器。首批为 Claude Code 与 Codex；未来 WorkBuddy、DeepSeek CLI、Gemini CLI 只需实现同一契约。Provider 声明 capability，Kernel 不再根据文件、mode 或 session id 猜具体实现。Provider 只能通过规范化 `SessionEventSink` 回报事件，不得依赖 actions、notify、dispatch、repo-panel、flight-record 或 Lark。

### 5.3 Connector

Connector 管理外部系统的认证、轮询/长连接和事件标准化。Lark、Gmail、GitHub 是 Connector；其他外部业务系统也应以 Connector 接入。Stock 行情接入是 Connector，但股票论点、仓位和策略判断属于 Vertical。Connector 不直接创建领域实体；必要时可通过内核策略创建通用通知或投递 Event。

### 5.4 Vertical

Vertical 实现领域模型、领域页面、领域 API、声明式事件处理和工作流。内置 `dev` 承载 Git 编码工作流；`strategy` 是内置 Vertical；其他领域应作为独立 Vertical。Terminal 模式由 dev Vertical 负责拉起，随后用 Kernel `SessionService.adopt` 认领外部 Session。个人记忆/角色/项目知识是否合并为 `personal-memory` Vertical 可在后续阶段决定。

## 6. 当前源码映射与耦合

| 当前文件                                                         | 目标归属                            | 当前问题                                                         |
| ---------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `src/daemon.ts`                                                  | Kernel bootstrap                    | 点名 sources、session reconcile、task reap 和各类 sweep          |
| `src/server.ts`                                                  | Kernel HTTP shell                   | 直接调用 `dispatch.startWork`，路由注册非声明式                  |
| `src/actions.ts`                                                 | Kernel Action Service               | 可保留存储格式，先加接口边界                                     |
| `src/dispatch.ts`                                                | 拆为 Kernel Task/Run + dev Vertical | Task 表、Provider 启动、worktree、Terminal、自演进混合           |
| `src/agent-backend.ts`                                           | Kernel Session Service 门面         | 仍识别 Codex 具体实现和 `task.mode`                              |
| `src/agent-session.ts`                                           | Claude Provider adapter             | 同时承担 provider 协议与部分 session 状态                        |
| `src/codex-session.ts`                                           | Codex Provider adapter              | 状态与 Task 文件耦合，并动态调用 repo panel / flight record      |
| `src/chat.ts`                                                    | Kernel/内置 chat UI                 | 与 Provider 只共享 binary/model/env 配置；是否统一持久化另立 ADR |
| `src/llm.ts`                                                     | Kernel Decision Model Service       | 决策模型调用与交互式 Agent Provider 应分开但共享 provider 配置   |
| `src/sources/*`                                                  | Connectors                          | 没有统一生命周期、health、checkpoint 和 Event schema             |
| `src/verticals.ts`                                               | Vertical Registry/Loader            | 仅 name/start/route，无 Context、版本、状态和隔离                |
| `src/strategy/*`                                                 | built-in strategy Vertical          | 是现有 vertical 迁移样板，但仍可直接使用核心内部实现             |
| `src/workbench.ts`                                               | 拆为 Web Shell + 模块路由           | 单文件跨越 Lark、Gmail、Task、Session、Vault、evolve             |
| `src/repo-panel.ts`、`src/github-pr.ts`、`src/terminal-tasks.ts` | dev Vertical                        | 研发领域特有                                                     |

依赖收口的完成标准不是“移动了文件”，而是扩展只能通过 `VerticalContext`、`ConnectorContext` 或 Provider 契约使用 Kernel。

## 7. 目标目录结构

```text
src/
  kernel/
    bootstrap.ts
    config/  storage/  migrations/
    events/  actions/  tasks/  sessions/  approvals/
    scheduler/  notify/  http/  observability/
    extensions/{registry,loader,context}.ts
  providers/
    claude-code/
    codex/
  connectors/
    lark/  gmail/  github/  stock-market/
  verticals/
    dev/
    strategy/
  shell/
    routes/  web-assets.ts
  daemon.ts
web/
  core/
  verticals/dev/
```

迁移期间允许新旧目录并存；不得为了目录整齐同时改所有 import。

## 8. 关键 TypeScript 契约草案

```ts
type Capability =
  | "stream"
  | "resume"
  | "interrupt"
  | "approval"
  | "images"
  | "tools"
  | "control-lease"
  | "adopt"
  | "add-dir"
  | "set-access"
  | "new-session";

type ProviderCommand =
  | { type: "start"; input: AgentInput }
  | { type: "resume"; ref: ProviderSessionRef; input: AgentInput }
  | { type: "interrupt"; ref: ProviderSessionRef }
  | {
      type: "respond-approval";
      ref: ProviderSessionRef;
      requestId: string;
      response: ApprovalResponse;
    }
  | { type: "adopt"; externalRef: string }
  | { type: "add-dir"; ref: ProviderSessionRef; dir: string }
  | { type: "set-access"; ref: ProviderSessionRef; access: KernelGrantedAccess }
  | { type: "new-session"; input: AgentInput };

interface AgentProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  execute(
    command: ProviderCommand,
    sink: SessionEventSink,
  ): Promise<ProviderCommandResult>;
  inspect?(ref: ProviderSessionRef): Promise<ProviderSessionState>;
}

interface TaskService {
  create(input: CreateTask): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(query?: TaskQuery): Promise<Task[]>;
  listRuns(taskId: string): Promise<Run[]>;
  complete(taskId: string, result?: TaskResult): Promise<Task>;
}

interface SessionService {
  create(input: CreateSession, grants: KernelSessionGrants): Promise<Session>;
  adopt(
    input: AdoptExternalSession,
    grants: KernelSessionGrants,
  ): Promise<Session>;
  send(id: string, input: AgentInput): Promise<{ queued: boolean }>;
  resume(id: string, input: AgentInput): Promise<void>;
  interrupt(id: string): Promise<void>;
  respondApproval(
    id: string,
    requestId: string,
    response: ApprovalResponse,
  ): Promise<void>;
  addDirectory(id: string, dir: string): Promise<void>;
  acquireControl(id: string, owner: ControlOwner): Promise<ControlLease>;
  state(id: string): Promise<SessionState>;
  bindSubject(id: string, subject: SubjectRef): Promise<void>;
}

interface ScopedSessionService {
  create(input: ScopedCreateSession): Promise<Session>; // roots/access 由 Kernel 闭包注入
  adopt(input: ScopedAdoptExternalSession): Promise<Session>;
  send(id: string, input: AgentInput): Promise<{ queued: boolean }>;
  interrupt(id: string): Promise<void>;
  state(id: string): Promise<SessionState>;
}

interface VerticalManifest {
  id: string;
  name: string;
  version: string;
  kernelApiVersion: number;
  entry: string;
  vault?: { scopes: string[]; sensitivity: "normal" | "sensitive" };
  subscriptions?: EventSubscriptionDeclaration[];
}

interface OwnwardVertical {
  manifest: VerticalManifest;
  activate(ctx: VerticalContext): Promise<void>;
  deactivate?(): Promise<void>;
  routes?: VerticalRoute[];
  navigation?: NavigationItem[];
  assets?: StaticAssetMount[];
  health?(): Promise<HealthReport>;
}

interface VerticalContext {
  readonly id: string;
  readonly config: ScopedConfig;
  readonly storage: ScopedStorage;
  readonly vault?: ScopedVault; // manifest 明确声明后才授予，默认无 Vault 权限
  readonly tasks: TaskService;
  readonly sessions: ScopedSessionService;
  readonly actions: ActionService;
  readonly events: ScopedEventPublisher;
  readonly scheduler: ScopedScheduler;
  readonly notify: PolicyBoundNotificationService;
  readonly log: ScopedLogger;
}

interface Connector {
  readonly manifest: ConnectorManifest;
  start(ctx: ConnectorContext): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthReport>;
}

interface ConnectorContext {
  readonly config: ScopedConfig;
  readonly checkpoint: ScopedStorage;
  readonly events: EventPublisher;
  readonly log: ScopedLogger;
}
```

`SessionEventSink` 只接受规范化的 turn-started、message-delta、message-completed、approval-requested、usage、turn-completed、turn-failed 等事件，再由 Session Service append `runs.jsonl`。Vertical 不接触 Claude/Codex 私有帧或 Provider Registry，只能请求 Session Service 选择 provider。`CreateSession.cwd` 必须位于该 Vertical 的授权 roots；`bypass/fullAccess` 只能由 Kernel 根据用户配置或当次审批授予，Vertical 不得传入。事件订阅来自 manifest 声明，动态订阅不开放。通知必须经过安静时段、目标与外部动作策略。`ScopedScheduler` 是 Vertical 注册周期任务的唯一入口，禁止自行 `setInterval`。每个 job 独立串行、失败后指数退避；job 健康度单独进入 Vertical health，不消耗路由熔断预算，也不会因一个 job 失败停掉同 Vertical 的其他 job。

## 9. 数据、配置、版本与迁移

迁移设计必须先覆盖当前真实磁盘面，而不是只列 Task：`state.json`、`queue.jsonl`、`events/`、`feed.jsonl`、`secrets/`、`tasks.json`、`tasks/` 下的 session meta/log/images、`chats/` 及 attachments、置顶/项目等索引、boots/daemon-life、CC hook settings，以及 Vault 中 flights、roles、memory、projects、daily/inbox 等。每类数据都要标注关键状态还是观测状态、owner、schema、保留策略和恢复方法。

目标布局可以是：

```text
data/kernel/{tasks,runs,sessions,actions,events}/
data/providers/<id>/
data/connectors/<id>/
data/verticals/<id>/
<vault-root>/verticals/<id>/
```

v1 初期不立即移动这些文件，但阶段 0.5 必须新增 `data/schema.json` 作为全局版本闸。二进制启动时若看到高于自身支持范围的 schema，必须拒绝写入并停止业务启动；crash-loop rollback 也不得让旧代码在未知新 schema 上运行。所有 migration 幂等、先备份、原子替换并记录 applied id。

事件 spool 改为 processing + ack 恢复：claim 后移动或标记 processing，处理成功才 ack；daemon 崩溃后重新投递未 ack 事件。重复消费由 event id 和消费者 checkpoint 保证幂等，不能继续依赖“读一批后整批截断”。

Run 从阶段 1 起必须 append-only 写 `data/runs.jsonl`，不能仅从旧 Task 字段投影。旧 Task 首轮可 copy-forward 生成对应 Run，但原文件保留双读窗口。Session 身份迁移采用 copy-forward + 双读，核对三类真实持久化位置：`tasks.json`、per-task `.session.json` / `.codex.json`、`pinned-sessions.json`；同时校验其中的 Claude/Codex 原生 ref 与 chat/terminal hook 反向关联。最近会话是运行时派生结果，不把它误计为独立存储。`AgentState` 建立逐字 JSON fixture；前端纯 JS 对 `backend` 等字段的隐式协议建立运行时快照/契约测试。过渡期保留 `backend` 字段，并新增 `providerId` 双写，前端稳定后再决定移除。

`config.default.json` 保持默认真相，扩展配置收敛为：

```json
{
  "providers": { "claude-code": {}, "codex": {} },
  "connectors": { "lark": { "enabled": false } },
  "verticals": { "dev": { "enabled": true }, "strategy": { "enabled": false } }
}
```

Manifest 只用整数 `kernelApiVersion` 判断扩展契约，不在 v1 引入 semver range、configVersion 或 dataVersion。扩展自己的数据迁移由其代码负责，但仍由 Kernel 在 staging 副本上执行：先备份，迁移成功后原子替换并记录 applied id；故障恢复按 marker 自动前滚或回滚，同一版本幂等跳过。内置与外部 Vertical/Connector 使用同一事务，外部 Host 的 migration/runtime storage lease 分离，旧 lease 在提交、失败、停止或 Host 退出时立即撤销。Connector 的 checkpoint、accepted journal 与 pending queue 属于 Kernel，不暴露给扩展迁移。失败时扩展进入 `migration_failed`，Kernel 继续提供诊断 UI，但禁止该扩展写数据。

## 10. 安全与可信模型

v1 Vertical/Connector/Provider 都是**本地受信代码**，进程边界不构成恶意代码沙箱。当前 as-built 中 Provider 由独立 Runner child process 托管；外部 Vertical/Connector 由各自 capability Unix IPC Host child process 托管；内置 Vertical/Connector 仍与 daemon 同进程。Host/Runner 改善生命周期与故障所有权，但这些进程仍继承本机用户权限。ScopedStorage/ScopedVault 是防误用和稳定契约，不宣称抵御恶意扩展。安装第三方代码由用户显式完成，默认仅加载内置清单和配置中的绝对路径。

即使受信，以下边界仍由 Kernel 强制：Host/Origin 与远程 token 校验、请求体大小、Secret 不进入扩展日志、三道既有人工审批门，以及各类外部动作的用户策略/审批和 capability 校验。Vertical 默认没有 Vault，manifest 必须声明 scope 与敏感级别，Kernel 再返回带斜杠边界检查的 ScopedVault。路由只能挂在 `/api/verticals/<id>/`，静态资源挂在 `/verticals/<id>/`；扩展不能覆盖 Core 路由。Connector 只能发布声明过的 Event namespace。

## 11. 生命周期、错误隔离与可观测性

启动顺序：schema 闸与恢复 → Kernel storage → registries → Providers → Connectors → Verticals → scheduler jobs → HTTP ready。关闭顺序反向，并给 `stop/deactivate` 超时。扩展状态至少包括 discovered、disabled、starting、ready、degraded、failed、stopping。v1 不承诺运行时热禁用：启停通过配置修改并重启，避免遗留 listener、timer 或流。

同进程代码无法做到真正崩溃隔离，因此 v1 采用逻辑隔离：lifecycle、普通 JSON route、subscription、job 包错误边界。当前 HTTP 层尚无统一 route timeout；未来实现时，timeout 只表示 Kernel 可以提前返回 504，并不会取消已经运行的 Promise，处理器仍须使用 AbortSignal 和幂等写；SSE、stream 和 Agent 交互路由豁免普通 route timeout，使用各自心跳与断连协议。单个扩展启动失败不阻止诊断 HTTP 和其他扩展启动；连续失败触发熔断并产生 Action。未捕获异常仍由 daemon-life 留痕。

用户可感知目标是：daemon 重启后 Task、Session、消息、输入权和 Provider ref 不丢，下一轮可以继续；已有 OS 子进程是否继续存活是另一层问题。最强反例是 launchd 曾连坐杀死 Codex 后台进程，而系统把在途任务统一标成 130，用户既不能继续也不知道真实死因。可执行路径有两种：让 Provider runner 脱离 daemon 由独立 supervisor 托管，或接受进程会终止但持久化 ref/事件边界并在重启后安全 resume。前者涉及进程所有权、日志、升级和权限，本 RFC 不假承诺已经实现；须在阶段 1 前选型并另立 ADR。无论选择哪种，都不能把“统一 reap 成 130”当成跨重启支持。

每个模块必须暴露 health、最近成功/失败时间、错误分类、队列深度和版本。Runner、Provider、Connector、Vertical 的关键生命周期、失败、投递、丢弃、journal 与 recovery 日志使用统一 JSON envelope：`event/moduleType/moduleId/operation/taskId/runId/sessionId/eventId/msg/errorClass`；缺失关联显式为 null，`msg` 是脱敏后的人类可读摘要，日志对象拒绝额外 secret-shaped 字段。关键投递至少一次；feed、指标等观测数据至多一次，不用观测路径反压关键路径。

## 12. 分阶段迁移计划与验收门

### 阶段 0：冻结契约与回归基线

记录现有 API/SSE、`AgentState` 逐字 fixture 和完整磁盘清单，建立关键恢复场景测试；不改变生产数据。

验收：`verify.sh` 全绿；历史任务/会话恢复、续聊、审批、daemon 重启行为有回归测试；fixture 能发现字段丢失和 SSE 改名。

### 阶段 0.5：数据安全地基

先实现 spool processing/ack 恢复、`data/schema.json` 版本闸、未知 schema 拒绝旧代码启动，以及 session 身份 copy-forward + 双读框架。升级和 crash-loop rollback 都必须经过 schema 检查。

验收：在 claim、写入、ack 各点 kill daemon 都不丢关键事件；重复事件不产生重复 Action；用未来 schema 启动会 fail closed；三类 session 持久化位置的数量、原生 ref 与反向关联一致。

### 阶段 1：Task/Run 与 Session 身份稳定

建立 Task/Session Service 门面；每个 Agent turn append-only 写 `runs.jsonl`，追问创建新 Run。Claude/Codex 私有 ref 藏在 provider data，公开 session id 稳定。过渡期 `AgentState.backend` 保留并双写 `providerId`。Terminal 由 dev launcher 启动后调用 `SessionService.adopt`。

验收：首轮、追问、失败、中断各产生一条且仅一条 Run；旧数据 copy-forward 后可双读；daemon 重启后任务/会话可继续，而不是统一 130；长任务存活方案 ADR 已定并至少完成所选方案的故障演练。Terminal 现有 `osascript` launch 与 `/api/cc/adopt` 是两个独立阶段；若选择自动接管，ADR 和实现必须显式补上 launch-to-adopt 握手，不能把两者视为天然衔接。

### 阶段 2：Provider Registry 与反向依赖拆解

在不先移动大文件的前提下，将 `agent-session.ts` / `codex-session.ts` 包成 Provider Adapter。Provider 只收 command、只发规范化 sink event；移除它们对 actions/approval/notify/dispatch/repo-panel/flight-record/lark 的反向依赖。Claude 的 approval 自动放行规则属于 Kernel 审批状态机迁移，不与 Codex 的浅层回调拆解按同一工作量估算。`agent-backend.ts` 按持久化 providerId 分发。`chat.ts` 仅共享 binary/model/env 发现，不在本阶段统一历史格式。

验收：Claude/Codex 的流式、续聊、interrupt、approval response、adopt、addDir、setAccess/newSession 按 capability 通过 contract tests；不支持显式报错；Provider import 扫描不含禁止模块；前端 fixture 无变化。

### 阶段 3：两个真实内置 Vertical

先把 dev 与 strategy 都迁成真实 Vertical，验证契约不是为单一领域定制。dev 接走 worktree、Terminal、repo panel、GitHub PR、flight record 和 evolve；strategy 拆分行情输入与策略领域。CLI/API 保持薄转发。

验收：两者不直接读 Kernel 私有数据；所有周期 job 走 ScopedScheduler；evolve 上线审批不变，PR merge 等外部动作继续受各自用户策略/审批约束；关闭 dev/strategy 配置并重启后，基础 Chat/Session/Action 仍工作。

### 阶段 4：Extension Runtime 契约正式化

在两个真实 Vertical 证据上定稿 manifest、Context、路由、导航、资源、声明式订阅、health 和配置重启。`journal` 只作为 contract test fixture，不发布正式示例。用一个只读、无外部依赖的示例包作为外部试金石。

验收：fixture 与公开示例包都不 import Kernel 私有文件；cwd roots、Vault 默认拒绝、敏感 scope、路由覆盖、通知策略、超时未取消语义均有测试；kernelApiVersion 不匹配时拒绝加载并可诊断。

### 阶段 5：Connector Registry

将 `src/sources/lark.ts`、`gmail.ts`、`github.ts` 和 stock 行情逐个适配 Connector；先包裹原实现，不同时重写协议。领域处理通过 manifest 声明的 Event 订阅完成。

验收：每个 Connector 可独立启停、有 checkpoint/health；重复 Event 可幂等处理；认证失效和限流可见；关闭 Connector 不影响 daemon。

### 阶段 6：目录与数据迁移

仅在 Service 契约稳定后迁移 data 目录，提供 dry-run、备份、校验和回滚说明；移除旧格式读取需单独 ADR。

验收：使用真实数据副本演练；迁移前后任务、会话、置顶、Action 数量及关键关联一致；失败注入不会留下半迁移状态。

### 实施纪律

每个阶段单独提交、单独评审，不把下一阶段的目录整理混入功能变更。新增 Service 时，先以现有实现为唯一 Adapter，并为旧 API 保留薄转发层；只有所有调用者已迁移且真实数据恢复演练通过，才允许删除旧入口。接口草案不是一次冻结的公共 SDK：在 dev、strategy 和外部只读薄切片都通过 contract tests 前，统一标记为 experimental。

评审时重点检查三类证据：第一，依赖方向可由 import 扫描证明，扩展没有穿透 Context；第二，行为等价可由 API fixture、SSE 事件和 UI 冒烟证明；第三，恢复能力可由真实数据副本、daemon 重启和故障注入证明。只通过单元测试不能宣称阶段完成。任何迁移都要先产出 dry-run 报告，列出源、目标、数量和校验摘要；发生未知 schema 时停止并保留原数据，不允许“尽量读取后保存”造成静默丢字段。

对外扩展契约采用最小暴露原则。Kernel Service 返回稳定 DTO，不返回内部文件路径、可变对象或 Provider 私有帧；写操作必须经过方法校验和审计日志。Contract tests 作为 SDK 的可执行规范，至少覆盖生命周期幂等、重复事件、路径越界、能力缺失、取消、超时和重启恢复。后续若契约确需破坏性修改，必须增加新版本并给出迁移器，而不是让每个 Vertical 自行猜测 Kernel 版本差异。

## 13. 外部 Vertical 接入路径

新领域应先用只读薄片验证外部加载，再逐步迁移领域实体、页面和任务流：领域数据进入 scoped storage，页面/API 使用 namespaced assets/routes，周期工作走 scoped scheduler，待办走 `ctx.actions`，Agent 调用走 `ctx.sessions`，外部输入经 Connector Event 进入。

接入时先做代码迁移，不让 Vertical 直接 import `util.ts`、`paths.ts`、`actions.ts` 或 Provider 实现。公开的 `examples/verticals/sample-readonly` 是当前 contract consumer；领域概念不能为了兼容旧实现回流进 Kernel。

## 14. 风险与待决策项

1. **长任务跨 daemon 升级如何存活**：独立 Provider runner supervisor，还是持久化边界后安全 resume？这是最强未决项，阶段 1 前必须 ADR；不能用统一退出码 130 掩盖。
2. **交互 Chat 是否等同 Session**：当前 `chat.ts` 与编码会话模型不同。本 RFC 只共享 binary/model/env 配置；统一持久化另立 ADR，不强行合并 UI 语义。
3. **Vertical 前端装载方式**：v1 选择 manifest 声明的静态资源与导航，不引入前端 bundler；JS 隔离不是安全边界。
4. **扩展发现机制**：v1 选择内置注册 + 配置绝对路径，不扫描任意目录。
5. **版本策略**：v1 用 `kernelApiVersion` 整数；何时提供外部 SDK 另议。
6. **进程隔离**：同进程故障仍可能致命。v1 接受受信模型，保留未来 child-process host 的可能。
7. **Strategy 边界**：行情采集归 Connector，策略/仓位归 Vertical；迁移时需拆清共享类型。`verticals.strategy.enabled` 控制 Strategy Vertical（页面/API）的生命周期，`strategy.enabled` 只控制领域 scheduler；关闭后者不能让历史策略页和查询 API 消失。迁移期仍接受原先写在 `verticals.strategy` 下的领域 override，并合并到 domain；新配置应写入显式 `verticals.strategy.domain`。
8. **Personal Memory 边界**：先留现状，等 dev Vertical 稳定后再决定是否抽为内置 Vertical。

## 15. ADR：最终决策摘要

- **决定**：Ownward 采用 Kernel + Provider + Connector + Vertical 四类模块；不是“一切皆插件”。
- **决定**：Task、Run、Session、Action、Event、审批与调度是 Kernel 原语。
- **决定**：Run 明确定义为一次 Agent turn，append-only 落盘，不等同 OS 进程或 Task 尝试。
- **决定**：Git 编码、worktree、PR 与 evolve 是 built-in `dev` Vertical。
- **决定**：Claude Code、Codex、未来 WorkBuddy/DeepSeek 是 Provider；领域模块不得绑定具体 Provider。
- **决定**：Lark、Gmail、GitHub、其他外部业务系统和行情输入是 Connector；Connector 产出 Event，不承载领域模型。
- **决定**：v1 Vertical 是本地受信代码，同进程运行，通过 scoped Context 限定接口和路径。
- **决定**：先建立 schema/spool/session 身份安全地基，再建立 Task/Session Service、Provider Registry 和 contract tests；保持现有行为，拒绝大爆炸重写。
- **决定**：不做市场、签名、沙箱、热更新、多租户；这些只有出现真实需求后另立 ADR。
- **决定**：先以 dev + strategy 两个真实内置 Vertical 验证契约；journal 只做测试 fixture；公开只读样例用于验证外部加载，完整领域接入必须等底座稳定。

本 RFC 的成功标志不是代码看起来更模块化，而是：新增一个 Provider、Connector 或 Vertical 时无需修改其他扩展，Kernel 可独立启动，旧数据可恢复，失败明确可见，人工审批和安全边界不被绕过。

## 16. Claude Code 评审吸收记录

对抗评审后，本版纠正了四类过度抽象：把 Run 从“执行尝试”收紧为一次 turn，并要求立即 append-only 落盘；补齐 Provider 的审批响应、接管、目录与访问控制命令，同时禁止反向依赖；把 VerticalContext 从 raw Provider/Vault/EventBus 收紧为 Session Service、声明式订阅和显式敏感 scope；把数据安全提前到阶段 0.5，加入 spool ack、schema fail-closed、三类 session 持久化位置及其关联双读。

评审还重排了实施顺序：先保证数据与跨重启身份，再抽 Provider，随后用 dev 与 strategy 两个真实 Vertical 验证，最后正式化扩展契约。文档不再承诺 timeout 能取消代码、运行时热禁用、Chat 统一持久化或 Provider 子进程天然跨升级存活；这些均改成明确语义或独立 ADR。最关键的开放问题仍是长任务在 daemon 升级时的进程所有权，本 RFC 要求先用故障演练选型，不允许以统一 130 伪装完成。
