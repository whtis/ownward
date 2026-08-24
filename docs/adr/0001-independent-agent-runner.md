# ADR 0001：独立 Agent Runner 托管在途执行

- 状态：接受
- 日期：2026-08-16
- 适用阶段：架构重构阶段 1

## 背景

当前 Claude Code 与 Codex 进程由 `ai.ownward.daemon` 直接 `Bun.spawn`。生产升级会通过
`launchd/install.sh` bootout 并重新 bootstrap 整个 daemon job。macOS launchd 会清理该 job
负责的派生进程，因此一个正在运行的 Agent turn 会随 daemon 一起消失。下一代 daemon 只能看到
落盘的 Provider session ref，无法看到旧进程内存中的输入队列、审批、partial output 和准确结束边界；
现有 `reconcileEngine` 因而把仍为 running 的任务统一标成退出码 130。

Session ref 能让用户在下一轮续聊，却不能证明被杀的这一轮是否已经执行了外部副作用。自动重放
原输入可能重复改文件、commit、push 或发送消息；发送一个模糊的“继续”同样不能恢复精确边界。

## 决策

新增独立 launchd job `ai.ownward.runner`。Runner 拥有交互式 Provider 子进程、Provider 协议解析、
输入队列和审批等待；daemon 负责产品状态、HTTP/SSE、Task/Session/Action 及领域策略。升级 daemon
不得 bootout、kickstart 或以其他方式终止 Runner。

第一台阶只建立 Run 事件仓库，不实现 Runner 或改变生产调用链。后续按 Provider 逐个迁移。

明确不选择“daemon 启动后自动 replay 被中断 turn”作为主方案。Resume 只用于开始一个新的 turn，
或者在 Runner 自身故障后由用户确认未知结果再继续；绝不自动重放可能已经产生副作用的输入。

## Run 定义与事件边界

Run 等于一次 Agent turn，不等于 OS 进程或整个 Task。一个 Session 有多个 Run，一个 Task 可关联
多个 Session。`data/runs.jsonl` 是 append-only 事件日志，每个已开始 Run 必须最终出现且只出现一个
terminal event：

- `command-accepted`：命令已经确定性落盘，返回 accepted 才成立。
- `run-dispatching`：Runner 已开始向 Provider 投递，但尚未得到 Provider 接收确认；这个窗口重启必须
  收敛为 `run-unknown-outcome`，绝不自动 replay。
- `run-started`：Provider 已接受本轮输入；这时才进入 running。
- `run-completed`：Provider 明确报告成功终帧。
- `run-failed`：Provider 明确失败，或进程退出且没有成功终帧。
- `run-interrupted`：用户明确 interrupt/cancel，结果已知为中断。
- `run-unknown-outcome`：Runner 崩溃或丢失进程所有权，无法证明副作用边界。

daemon 与 socket 断线不改变 Run 状态。Provider 仍由 Runner 持有时，daemon 重启后从 journal cursor
重放事件并继续观察。同一 `eventId`、`commandId` 和 `runId` 必须幂等；相同 key 的不同内容是协议
冲突，不能静默覆盖。Task 展示状态由 Run 事件纯函数投影，`OWNWARD_EXIT` 和 PID 不再是最终真相。

消息 delta、usage 和 health 是观测数据，可以至多一次；命令接受、Run started/terminal、审批请求与
审批响应是关键状态，必须先持久化再确认。

## IPC、Journal 与版本

daemon 与 Runner 使用仅当前用户可访问的 Unix domain socket，文件权限为 `0600`。IPC 是带类型的
命令/事件协议，不接受任意 shell 字符串。每个命令携带 `commandId`；Runner 先写 command journal，
确认 durable 后才返回 accepted。Runner 先写规范化事件 journal，再向 daemon 推送。daemon 保存 cursor，
断线重连后按 cursor 补读；重复投递由稳定 ID 去重。

协议使用整数 `runnerApiVersion`。daemon 与 Runner 至少支持当前版和前一版，版本不兼容时 fail closed
并保留诊断能力。Runner 升级采用 drain：存在 active Run 时继续运行旧 Runner，不强杀；全部进入
terminal 后再切换。紧急安全升级若必须停止 Runner，所有失去所有权的 active Run 进入
`unknown_outcome`，不得伪装为普通失败或自动 replay。

## 安全边界

Runner 是本机受信代码，但只能执行 Kernel 授予的 Provider、cwd roots、extra dirs、模型和访问级别。
Vertical 不能直接连接 Runner，不能请求 `bypass/fullAccess`；授权由 Kernel 校验并写入命令审计。
socket 不监听 TCP，不信任客户端自报身份；使用目录所有权、`0600` 权限和首次启用时生成的随机 capability token。
日志不得包含 secret、图片正文或完整敏感 prompt。Runner 不开放通用 shell API。

审批响应必须匹配 session/run/requestId 且仍为 pending。daemon 离线期间审批保持 pending，重连后重现；
Provider 已退出的旧 requestId 必须显式失败，不能返回假成功。

`command-accepted` 与 `run-dispatching` 的 durable append 都是 Provider 边界硬闸。任一步失败必须返回
`RUN_DISPATCH_JOURNAL_UNAVAILABLE`，不得调用 stdin send、`Bun.spawn` 或其他 Provider 投递入口。

## 故障语义

| 故障 | 结果 |
|---|---|
| daemon 正常重启、崩溃或 SIGKILL | Runner 与 Provider PID 不变；Run 状态不变，重连补读 |
| socket 断线 | 不取消 Run；命令是否 accepted 由 command journal 查询 |
| Runner 在 dispatching 窗口重启 | `run-unknown-outcome`；命令可能已越过投递边界，绝不自动 replay |
| Provider 无终帧退出 | `run-failed`，记录分类与退出码 |
| 用户 interrupt | `run-interrupted`；后续输入创建新 Run |
| Runner 崩溃并失去 Provider | `run-unknown-outcome`；等待用户检查和确认 |
| journal 尾部截断 | 隔离坏行、暴露无原文诊断；绝不当作空日志或成功 |
| 重复 command/event | 内容相同幂等；内容冲突 fail closed |

Runner 自身由 launchd KeepAlive 拉起，但不能承诺其子进程跨 Runner 崩溃存活。该情况下安全性优先于
自动连续性：保留 Provider native ref，用户确认工作区和外部副作用后，创建新 Run resume。

Run journal 的正常写入必须在跨进程独占锁内完成 read/validate/append，并在确认前 `fsync` 文件；首次
创建还要 `fsync` 父目录。这承诺数据已提交到操作系统提供的同步边界，不把普通 `fsync` 夸大成所有
macOS 硬件上都保证物理介质落盘的 `F_FULLFSYNC`。锁回收只允许针对经过短 grace 且 owner PID 已死亡的锁。所有正常 acquire 在
创建公共锁前后都观察固定 recovery gate；回收者持有 gate 后重新读取旧 token，再原子 rename 到唯一
recovery 路径。认领前发现 ENOENT 或 token 换代属于良性竞争：释放自己的 gate 后重试；只有已经
rename 认领后才发现 token 歧义，才 fail closed 并保留现场。已正确认领旧锁、但 crossing acquirer
仍占着正式锁直到短等待超时时，同样只是可重试 busy：先释放自己的 gate、清理已验证的 recovery，
再返回 `RUN_REPOSITORY_BUSY`，不能把正常繁忙误留成永久 recovery 现场。释放
也不得 unlink 公共路径：先 rename 到本次唯一 cleanup，复核 token 后只删除私有路径。正式写入前还须
再次核对 owner token。同步 API 只短等 50ms，忙时返回
明确的 `RUN_REPOSITORY_BUSY` 让上层排队重试，不允许在 daemon 事件循环里无界等待。读取提供 strict 模式：未知 schema、
未知字段和任意坏行都 fail closed。自动修复仅允许最后一条无换行且 JSON 截断的尾巴，修复前完整
备份并同步落盘；合法且 shape 正确的 JSON 仅缺末尾换行时保留事件、只补换行。合法 JSON 但 shape
错误即使位于无换行尾部也绝不自动修；中间坏行、完整换行坏行和未来 schema
必须人工诊断，不能“尽量读取后继续写”。

## 分阶段迁移

1. 建立本 ADR、RunRepository、reducer 和故障 fixture；只旁路，不接生产 Provider。
2. 现有执行路径双写 Run 事件，验证 Task 状态、通知和 UI 投影等价。
3. 实现 Runner IPC、command/event journal 和 fake Provider contract tests。
4. Claude Code 迁入 Runner；演练审批、排队、interrupt、daemon 重启。
5. Codex 迁入 Runner；演练 rollout resume、沙箱和图片清理。
6. 通知、flight、harvest 改为消费 Run terminal event，保留旧路径双读观察期。
7. 安装双 launchd job，完成 evolve/apply 全链故障演练和 drain 升级。
8. 移除 `reconcileEngine → 130`、`OWNWARD_EXIT` 真相和旧 Provider 子进程所有权。

### 阶段 3A 已落地的协议与 journal 地基

当前先落地不接生产的 `src/runner/`：整数 `runnerApiVersion=1` 的严格 envelope、未来长度前缀可直接复用的
4-byte header 常量与 1MiB payload 上限，以及 `data/runner/commands.jsonl`、`events.jsonl` 两份独立
append-only journal。两者沿用 RunRepository 的安全等级：跨进程短等待独占锁、死 PID + grace 后才回收、
recovery gate、写前复核 token、短写循环、文件 fsync 与首次目录 fsync、未知 schema/字段 fail closed；只允许
对最后一条无换行截断 JSON 在完整备份后修复。

正常路径由单一 Runner writer 持有，journal 在进程内按纳秒级 inode/stat 指纹缓存已验证记录，并维护
id→record 索引；连续追加不再每次重解析或线性扫描整份 JSONL。外部进程改写、inode/size/mtime/ctime 任一
变化即丢弃缓存并严格全读；跨进程写仍只作为恢复/测试路径受 50ms busy 契约约束。5000 条连续追加是本阶段
回归门；在独立 Runner 接管生产前必须补容量/延迟监控，若实测超出单文件合理保留量，再以 generation 分片，
不得简单增大事件循环内等待时间。

命令输入和事件 delta/审批正文不进入 JSONL，写入 0600/0700 的 content-addressed blob，journal 只记录
ref、SHA-256 和 bytes。frame 上限 1MiB，blob 上限独立为 8MiB；UTF-8 解码 fatal。`commandId` / `eventId`
同语义内容幂等、内容冲突拒绝。Event 必须引用已 durable 的 command 且 run/session/provider 一致，按
command+run 使用连续 sequence，started/terminal 各唯一，terminal 后拒写。终态 `reason` 只允许稳定分类码，
Provider 原始详情进入 payload blob。重启恢复 API 只看 `start-run` 且按 run 去重：缺 snapshot、accepted、
dispatching 分别要求人工检查、人工确认、收敛 `unknown_outcome`，一律没有 replay 入口；running/terminal 只观察。Fake Provider
位于 `src/runner/testing/`，只为 contract tests 确定性产生 started/delta/approval/terminal 事件，不注册到生产。
它在非 `NODE_ENV=test` 构造时直接拒绝，并有 import-boundary 测试阻止生产模块引用。

Runner、journal、blob、quarantine 目录/文件权限每次访问收敛到 0700/0600。content-addressed blob 若在 journal
硬闸失败前已完成，可能成为 orphan；只能由显式 audit 列出，再由显式 quarantine 原子搬走，绝不自动删除。
`.tmp` 是写入崩溃现场，`.backup.*` 是尾修复原件：audit 单列，人工核验后处理；quarantine 同样长期保留至人工清理。

Blob 与 journal 采用固定且唯一的嵌套锁序：`runner/.blob-maintenance` → `commands.jsonl` 或 `events.jsonl`；
禁止 journal 持锁时反向获取 blob 锁。带 input/payload 的 append 必须让 blob 锁跨越 `durableBlob + journal append`
整个窗口；无 blob 的 append 不取该锁。quarantine 也持同一 blob 锁，并在锁内重新 audit 后才 rename，不能使用
调用前的旧审计结果；搬移后 fsync 源 family 和 quarantine 目录。这样 accept 与隔离并发时，最终要么隔离旧 orphan
后 accept 重新落 blob 再写 ref，要么 accept 先写 journal 使锁内 audit 拒绝隔离，不会留下 journal ref 指向缺失 blob。

### 阶段 3B 已落地的独立 IPC

Runner 现以独立 entry process 监听 `data/runner/runner.sock`。父目录每次访问收敛为 0700，socket 尽可能
收敛为 0600；启动只会清理确认是 socket 的旧路径，同名普通文件或 symlink 均 fail closed。首次启动生成
256-bit 随机 capability token（0600），后续 Runner 重启安全复用；所有权、权限或内容非法均 fail closed，
请求鉴权使用恒定时间比较。协议使用 4-byte big-endian
长度前缀，在分配 payload 前拒绝 0 和大于 1MiB 的声明长度，支持半包、粘包和连续多帧，UTF-8 fatal。
envelope 与每一种 request body 都按 kind 使用严格 allowlist，不开放任意 shell 或透传未知字段。

客户端以 requestId 关联响应；timeout 或 socket 断线只返回 `RUNNER_REQUEST_OUTCOME_UNKNOWN`，明确不表示取消，
重连后必须用 `query-command` 判断 durable accepted 状态。Runner 对 submit 先 fsync command journal 再回 accepted，
Provider event 也先 durable append 再 push。相同 commandId/内容幂等，不同内容拒绝。Runner 重启后只允许 query，
不 replay accepted command。Fake Provider 仍只在 `NODE_ENV=test + OWNWARD_RUNNER_ALLOW_FAKE=1` 双门下动态加载，
生产环境显式拒绝该开关。

`ai.ownward.runner` 的 plist 与显式 install/uninstall/health 脚本已准备，但 `launchd/install.sh` 仍只管理 daemon，
不会默认安装、停止或重启 Runner。等真实 Provider 迁移与 drain 演练通过后，才启用生产 Runner job。

IPC push 仅是已鉴权且显式 watch command 的 best-effort 实时提示，不是真相来源；断线后通过
`query-command(afterSequence, limit<=500)` 分页补读 durable journal。每次越过 Provider 边界前必须先追加
durable `dispatching` event；该硬闸失败绝不调用 Provider。启动时 dispatching/started 非终态统一收敛
`unknown-outcome`，accepted-only 保留结构化诊断且不 replay。Runner 使用带 pid/token/bootId/grace 的单实例锁，
shutdown 先进入 draining 拒绝新命令，再有界等待并为仍 active 的命令持久化 unknown-outcome。安装 Runner 默认
检查 `activeRuns` 并拒绝升级，只有显式 `--force` 才允许中断。

每个 Provider 单独提交和评审。Terminal.app 任务仍由 Terminal 所有；Ownward 只通过 adopt 把外部会话
纳入统一 Session 身份，不把 Terminal 进程迁入 Runner。

### Terminal launch-to-adopt 握手已落地

Terminal launcher 现在为每次启动创建 256-bit 一次性 token，pending 只保存 hash，原 token 位于 0600
文件，TTL 最长 5 分钟。Terminal 命令只携 launch id 与 token 文件路径；hook 用 stdin curl config 传
header，token 不进入 URL、argv、stdout、响应或日志。SessionStart 必须同时匹配 task、provider、realpath cwd、
launch id、Claude session id 与 transcript，成功后原子 single-use claim 并调用 `KernelSessionService.adopt`
（control=`external`）。重放、过期、错任务、错误 cwd/provider、insecure token file 均 fail closed；adopt
成功会把下一枚独立 token 原子写回同一个 0600 文件，并把新凭证绑定到 task、launch、uid 与已接管 Session；
后续 SessionStart（包括 Claude `/new` 产生的 nativeRef rotation）必须携带该 token，旧 token 和无 token 请求均拒绝。
失败只写无敏感信息的失败 receipt，不伪造 Session。旧 terminal Task 没有 launch id 时仍保留 legacy
fallback，作为迁移窗口。

`src/kernel/sessions/terminal-adopt.test.ts` 从 launcher record 一直打到真实 `/api/cc-hook` handler 和
Session repository，并验证只 adopt 一次。`docs/phase1-runner-cutover-audit.md` 记录完整边界与剩余切流面。

### 生命周期故障演练已落地

`src/runner/daemon-isolation.integration.test.ts` 以独立 OS 进程启动 Runner 和 daemon，在 active Run 期间
SIGKILL daemon，验证 Runner PID 与 active ownership 不变。`src/runner/install-runner.test.ts` 覆盖
quiesce/drain、切换前 TOCTOU、升级失败恢复旧 plist、旧 Runner resume 与恢复失败诊断。它们证明所选
独立 Runner 方案的关键故障门。当前默认 `sessionRunnerMode=runner`；canary 只约束 legacy 身份，native/adopted 身份不会因 allowlist 或 off 回到旧链。

### 阶段 4A 已落地的 Claude Code Adapter（尚未切生产入口）

`src/providers/claude-code/` 已作为 Runner 内真实 Provider 注册。Adapter 不 import Action、通知、dispatch、
repo panel、flight record、Lark 或 workbench；只接受严格 normalized input，并将 Claude 私有 stream-json
转换为 started、session-updated、delta、message-completed、usage、provider-notice、approval-requested 与 terminal 事件。
prompt、消息、工具输入、审批正文、stderr ring 和 Provider 错误详情只进入 content-addressed blob，journal 不含正文。
1MiB IPC frame 不因图片放宽：Kernel 先把图片写入 0600 content-addressed attachment blob，命令只携带
ref/hash/bytes；Adapter 读取前再次验证 owner、mode、hash 和大小。inline 超限明确返回 `RUNNER_INPUT_TOO_LARGE`。

start/resume、interrupt、approval-response、add-dir、set-access 与 new-session 均经过 command accepted 和
dispatching 两道 durable hard gate。控制请求的 IPC 响应只叫 `accepted`，不把“已落盘投递”伪装成 Provider
已处理；最终结果必须查询对应 command 的 terminal event。Claude Adapter 不包含风险匹配或自动批准规则：
它只上报 approval-requested，并转发 Kernel 明确给出的 allow/deny。旧 requestId、run/session 绑定不匹配、
缺失 native ref 的 Runner 重启后续聊都会显式 failed，不从 task mode 或 session 文件猜 Provider。
`resume-run` 是显式恢复命令；`send-input` 只复用 Runner 已持有的 Session（兼容恢复字段时也必须完整携带
nativeRef/cwd/options，且 ref 冲突 fail closed）。cwd 必须存在且是目录，传给 Claude 子进程前清除继承的
`CLAUDE_CODE_*` 环境变量。

事件不是同一可靠性等级。started、session-updated、message-completed、approval-requested 和 terminal 是
关键事实；任何一条无法 durable 都先 abort Provider，再无 payload 地重试写 `unknown-outcome`，最终失败有
结构化错误，不能静默从 active map 消失。delta、usage 与 provider-notice 是观测事件，写锁忙或容量故障时
只增加 drop counter 并记录无正文日志，绝不因此杀 turn。token delta 在一个 assistant message 内聚合后才写，
不逐 token fsync。Runner 暴露 events attempted、observation append/drop、push drop、critical failure、watchdog
和 append latency 指标；5000 usage 容量测试锁定索引与延迟路径。

同一 Claude Session 的 turn/config 状态通过 async mutex 和同步 reservation 串行，add-dir/set-access/new-session
与 send 交错时必有一方显式 `provider_busy`，不会出现检查 idle 后另一个 turn 插入的 TOCTOU。interrupt 与
approval-response 写 stdin 后必须等待匹配的 Claude control response；未确认按 `provider_no_ack` 失败，原 turn
只有收到 interrupt ack 后的 Provider result 才可记 interrupted。通用的“无 normalized 进展” watchdog 默认关闭，
因为长时间运行的工具调用可能合法地保持静默；只有 Provider 具备可靠的 heartbeat 语义，或用户明确配置
`providerNoProgressMs > 0` 时才启用，超时后收回 Provider 并记 `provider_no_progress` unknown。Runner shutdown
在落 unknown 后调用 Provider lifecycle，回收全部 Claude child，
禁止一个命令出现两个 terminal。

私有 system status、compact error 和 synthetic 错误只规范化为 category 固定的 provider-notice
（rate_limited/auth_expired/api_error/compacting/compact_failed）；sidechain 与未知帧只计数丢弃。单个坏 JSON
行计数后跳过，连续阈值才失败；stdout 半行有硬上限，stderr 只保留有界 ring。AskUserQuestion 规范为
question/options，不把 Claude 私有帧交给 Kernel；全零 usage 仍可观测。

本台阶仍不安装 `ai.ownward.runner`，也不切换现有 daemon 的 `agent-session.ts` 调用链。完成对抗 review、
真实 Claude 故障演练与 Session Service 消费端迁移后，才进入双写/切流和生产安装门。

### 阶段 4B 已落地的 Codex Adapter（尚未切生产入口）

Codex Adapter 按本机 CLI 的真实 clap/JSONL 契约实现：一次 Run 对应一个独立 `codex exec --json` 进程，
续聊使用 `exec` 父 options 后再进入 `resume -- <nativeRef> <prompt>`，且 nativeRef 只接受 Codex thread UUID。sandbox、add-dir、model、image、
color 等父 options 不得放在 resume 后；prompt 必须非空且固定由 `--` 隔离，不能被解释为权限参数。
`codex` 与其他 CODEX_HOME 通过显式 Provider options 区分，不从 task mode 或历史文件猜测。

Adapter 声明 stream/resume/interrupt/images/tools/add-dir/set-access/new-session；Codex exec 没有可验证的
stdin approval ack，因此不声明 approval，approval-response 显式 unsupported。stdout 按 UTF-8 JSONL
有界解析，snapshot 只有在同 item id 且新文本以旧文本为前缀时才产生 suffix delta；file_change、
web_search、command_execution、mcp、reasoning、todo 和 error 都先规范化再写事件，未知 frame 只计数及
记录无正文 hash。usage 的 input/context 不重复叠加 cached，cached 与 reasoning 单列。

每轮进程使用独立 process group。默认 15 分钟无 stdout/stderr 活动才触发 Provider 自身 watchdog，先
TERM 后有界 KILL 整组；interrupt 同样等待退出并回收 descendants。stderr 实时读取到有界 ring，并在
terminal 前作为 best-effort notice 落盘；Provider 尚未 started 的诊断 notice 是唯一允许的 pre-start
观测事件。图片正文仍来自授权 attachment blob，物化副本只在 runner/tmp，正常退出删除，崩溃残留由
blob audit 作为 temporary 暴露。该阶段只注册 Runner Provider，不安装 Runner、不改 daemon 消费链。

### 阶段 4C Session Service 消费门面（默认关闭）

`src/kernel/sessions/` 建立稳定 DTO 与 Kernel SessionService。Provider 选择只取持久化
`SessionRepository.providerId`；task mode、native ref 形状和运行态探针都不再参与身份猜测，repository/legacy
漂移直接 fail closed。当前实现默认 `runner`；`off` 仅为存量 legacy Session 保留兼容读取与受保护操作，native/adopted Session 仍由 Runner 持有，因此不是完整回滚开关；`shadow` 已删除并拒绝解析。此前 shadow 只调用旧执行链，随后做
copy-forward/DTO 对账并写无正文诊断，代码路径不会创建 RunnerClient，因此不能发生双投递。

Runner 消费端为每个 turn 生成稳定 commandId/runId/sessionId，在写 socket 前先硬闸 append Kernel
`command-accepted`，再通过 `query-command(afterSequence, limit)` 分页补读 durable events；push 不是真相。
dispatching/started/terminal 幂等投影到 `runs.jsonl`，session-updated 双写 `sessions.json`，控制命令只留在
Runner command journal、不误计为 Run。控制命令在发给 Runner 前同样以稳定 command/run identity 写入 Kernel
bridge acceptance；只有匹配的 completed event 才能生效，并按 acceptance 当时捕获的 cwd roots/access 再验证，
避免授权在异步完成前漂移。control lease 持久化在 SessionRepository，存在 active Run 时拒绝换手。approval response
仍由 Kernel 校验，Provider 只收到明确决策。迁移 dry-run 可由
`/api/system/session-migration-report?id=<taskId>` 查询。本阶段仍不安装生产 Runner，也不启用 runner 切流。

灰度切流使用 `architecture.sessionRunnerTaskIds` 的确定性 allowlist，但它只约束已有 canonical/legacy 身份：先解析 canonical Session，`id` 或任一
`taskIds` alias 命中即整组切入，避免同一 Provider 会话同时走 legacy/Runner。硬切后的全新任务始终由 Runner 创建，不因未出现在 allowlist 而回落旧链。空数组明确表示全量；配置不是数组
时所有 mode 均以 EX_CONFIG fail closed。缩窄 allowlist 或回 `off` 后，未 terminal 的 bridge/Runner command
会阻断 legacy 写并返回 409，必须先 drain 或收敛为 unknown-outcome；unknown mutation 返回原 commandId/runId，
由 `/api/system/session-command` 查询，不能盲重投。Runner journal 保留且不会被旧链消费。
永久 pending 的 bridge command 只允许通过 `/api/system/session-drain` 按精确 sessionId、commandId，并提交固定确认串
`MARK_UNKNOWN_OUTCOME` 显式收敛；未满安全等待窗口或 Runner 仍报告对应 active run 时拒绝。收敛只追加
`unknown-outcome`/terminal 事实，不删除或改写 Runner 证据，并向 0600 `session-drain-audit.jsonl` 追加审计记录。
若本地 journal 已有真实 terminal，drain 只推进 bridge 并按真实 outcome 审计；Runner ping 超时、协议缺失
`activeRuns` 或响应不可验证都 fail closed，只有明确 `ENOENT/ECONNREFUSED` 才按“Runner 不可达”进入人工收敛。
读路径在 socket 不可用时返回本地 durable journal 投影并标记 `stale/errorCode`；所有写路径继续 fail closed。

HTTP turn mutation 必须携带每次用户操作新生成的 `clientMutationId`。只有显式复用同一个 key 才复用原
command/run identity；正文哈希相同但 key 不同仍是两个真实 turn。未知结果的重试必须沿用原 key，或直接按
原 commandId 查询。切 canary 前必须确认 legacy Provider 不再 alive/running；已有 legacy owner 只能先安全
handoff，或创建全新的 Runner-owned Session，禁止同一会话双写。所有 legacy Provider 最低写边界都有共享
ownership guard，覆盖 HTTP、飞书审批、队列自动续发和 dispatch/adopt 入口。
`/api/system/session-runner-status` 只暴露 canary count/hash、draining 与 activeRunCount，不暴露 task id、run id
或 Provider 原始 metrics。daemon 启动只恢复 allowlist canonical Session 内的 bridge command；Runner 不可用时
记录 fail-closed 诊断，不回退投递到 legacy Provider。

Runner 由 `launchd/install-runner.sh` 显式、幂等安装。升级前检查 active runs，失败时恢复旧 plist/job；
daemon 安装脚本不管理 Runner，但 runner 模式下重启前要求 Runner health 通过。

运行时采用降级而非整机失活：daemon 对 Runner 做有界健康重试，失败后仍启动核心 HTTP、事件源与 Action，
并在 system health 暴露 `RUNNER_UNAVAILABLE`、创建一条确定性去重诊断 Action。此时 Session journal 仍可读，
所有 Session 写入/control 明确 fail closed。安装、部署与 evolve 的切换边界仍必须先安装并验证独立 Runner，
避免把“运行时可降级”误解为“部署时可跳过依赖”。`new-session` 使用持久化两阶段 reset：submit 前记录
command/旧 ref，只有 durable completed 才清 ref、快照并推进 history cursor；失败回滚，未知结果由重启恢复。
安装器通过 capability-authenticated `quiesce` 先原子关闭新命令入口，再轮询 active command 清零，并在
bootout 前做最后一道 TOCTOU 检查；`--force` 不再绕过该门。安装过程持有单实例锁，plist 临时文件与备份
均位于 LaunchAgents 同卷，enable/bootstrap/新 health 任一步失败都会恢复旧定义、重试 bootstrap 并验证旧
health；恢复失败使用独立退出码。用户级安装拒绝 root，plist 固定 Umask 0077。daemon installer 使用与运行时
相同的 mode/allowlist parser，配置读取或解析失败时 fail closed。
新版 ping 明示 protocol version、`quiesce/resume` capabilities 与 build identity。安装器对旧 Runner 兼容：
只有可信 ping 且 activeRuns 连续两次为空才进入受控升级；新版 quiesce 后若在修改 plist 前失败，会 resume
旧 Runner，drain timeout 不会留下不可写服务。安装后必须同时证明 pid 已换代且 build identity 等于本次源码。
plist 存在但 socket 明确 ENOENT/ECONNREFUSED 时，只有 `--repair CONFIRM_NO_ACTIVE_RUNNER` 可继续，并复核
instance-lock owner pid 与 socket、追加 0600 审计；其他 health 错误不允许 repair。安装锁位于用户全局
LaunchAgents 目录，活 pid 拒绝并发、死 pid 且目录内容严格可识别时才恢复。

## 回滚

历史阶段 6 之前旧执行链曾是真相；当前实现已经硬切。`off` 只提供存量 legacy 身份兼容面，不能把 native/adopted Session 切回旧链。
回退 daemon 不得顺带停止 Runner：必须等待 active Runs drain，并保留 append-only 数据，
确认所有 terminal event 与 Provider ref 已同步，再停止 Runner。若无法证明某个 Run 的结果，将其标为
`unknown_outcome`，不重放。旧 daemon 遇到未知全局 schema 必须拒绝写入。

## 验收故障演练

Claude 与 Codex 都要执行“写唯一哨兵后长等待”的真实任务，在 run start、工具执行、审批等待、命令
accepted 和 terminal event 后分别重启或 SIGKILL daemon，验证 Provider PID 不变、哨兵恰好一次、事件
不重不漏。另覆盖 Runner kill、重复 commandId、journal 截断、旧 daemon/新 Runner 版本不匹配、active
Run 阻止升级、审批离线重现及 evolve apply 全链。
