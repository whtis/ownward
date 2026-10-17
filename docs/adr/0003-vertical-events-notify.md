# ADR 0003：开放 Vertical 的 events 与 notify capability

状态：Accepted  
日期：2026-10-16

## 背景

`VerticalCapability` 从第一版起就列了 `events` 和 `notify`，但 `VerticalContext` 上只放了 `Record<string, never>` 占位，内置路径构造上下文时直接拒绝（`VERTICAL_SERVICE_UNAVAILABLE`），外部 Host 的可用性闸也没有放行。结果是领域 Vertical 想在「信号出现」「委托成交」这类时刻提醒用户，只剩两条路：

- 自己接飞书或系统通知，绕开安静时段、前台降级和冷却。这正是架构 v1 禁止的旁路，见「通知必须经过安静时段、目标与外部动作策略」。
- 开 Action。但 Action 是待办，语义是「需要处理」，并不等于「知道一下」。

Kernel 里已经有两条成熟的管道：

- 关键事件队列：`spool` 至少一次投递，交给 triage 定级为 notify / log / 丢弃。
- 通知路由：`notify` 先过 `notify-policy` 决定走哪些通道，再推横幅或飞书，最后写入 feed。

本 ADR 把这两条管道以受限门面的形式开给 Vertical。

## 决策

### notify：受策略约束的直接通知

`ctx.notify.send(input) → { status: "queued" | "duplicate" }`

输入 DTO 只接受下列字段，出现多余字段就拒绝：

| 字段 | 约束 | 说明 |
|---|---|---|
| `key` | 必填，`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` | 去重与冷却键 |
| `text` | 必填，1–500 字 | 首行作为标题 |
| `detail` | 可选，≤2000 字 | 只进 feed |
| `level` | 可选，`act` / `fyi` / `silent`，缺省为 `fyi` | 与 Kernel 通知等级同义 |
| `link` | 可选，≤500 字 | 允许 `http(s)://` 绝对地址，或以 `/verticals/<本 id>/` 开头的相对路径 |
| `urgent` | 可选，布尔 | 静默时段照推，需要单独授权 |

各字段的处理规则：

- **source 与 key 由 Kernel 强制改写。** source 固定为 `vertical:<id>`，冷却键固定为 `vertical:<id>:<key>`。Vertical 无法冒充 lark、github 等内置来源，也无法撞上其他 Vertical 的冷却键。
- **相对 link** 由 Kernel 拼成工作台地址：配置了 `notify.workbenchUrl` 就用它，否则用本机地址。这样手机上的飞书卡片也能直接点开。路径中出现 `..`、反斜杠或控制字符一律拒绝。
- **`urgent: true`** 映射为 `quietExempt`。要求配置里有 `verticals.<id>.grantedNotifyUrgent: true`，否则抛 `VERTICAL_NOTIFY_URGENT_NOT_GRANTED`。默认不授权，原因是「半夜叫醒」的权力只应交给用户自己确认过的扩展。
- **投递一律走现有 `notify()`：** 前台降级、安静时段、冷却和 `act` 才进飞书这些规则都不变。Vertical 拿不到 `force`、`context`、`actions`、`chatId` 等内部选项。
- **同一 scoped key 在冷却窗口内（`notify.cooldownMin`，默认 30 分钟）重复调用时直接返回 `duplicate`**，不再调用 `notify()`，也不写 feed。这样每轮扫描都上报同一信号的 Vertical 不会刷屏。
- **受理即返回。** 校验和限流同步完成后立即返回 `queued`，投递在后台进行，失败只记日志。这是因为 macOS 横幅和飞书卡片最长要 40 秒，远超 Host RPC 默认的 2 秒，而且通知结果本来就落在 feed 上。
- **限流按 Vertical 计：** 每分钟 10 条、每小时 60 条（只计 `queued`），超出抛 `VERTICAL_NOTIFY_RATE_LIMITED`。

### events：交给 triage 定级的业务事件

`ctx.events.publish(events[]) → { accepted, duplicates }`

每批 1–50 条，每条事件只接受下列字段：

| 字段 | 约束 |
|---|---|
| `id` | 必填，`[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`，同一业务事实必须稳定 |
| `type` | 必填，`[a-z][a-z0-9._-]{0,63}` |
| `occurredAt` | 可选，可解析的 ISO 时间 |
| `payload` | 必填，普通 JSON 对象，序列化后 ≤16KB |

入队规则：

- **入队形状：** id 为 `vertical:<vid>:<id>`，source 为 `vertical:<vid>`，key 为 `type`，payload 为 `{...payload, _occurredAt}`。
- **脱敏：** 入队前对键名含 token / secret / password / authorization / cookie / credential 的字段做脱敏。
- **原子性：** 整批先全部校验，任一条不合法就整批拒绝（`VERTICAL_EVENTS_INVALID`），不会出现半批入队。
- **限流：** 每个 Vertical 每小时最多 120 条新事件，超出整批拒绝（`VERTICAL_EVENTS_RATE_LIMITED`）。
- **定级权在 Kernel：** 由 triage 依据 decision-rules 判定 notify、log 或丢弃，Vertical 不能指定通知等级。需要确定性提醒的场景请用 `notify`。

## 授权、撤销、超时

- 两项能力都要求 manifest 声明，并且在 `verticals.<id>.grantedCapabilities` 中由本机授权，缺一不注入。
- 外部 Host：
  - 走与 actions、llm、sources 相同的 lease 通道，方法是 `notify.send` 和 `events.publish`，lease 不匹配一律返回 `EXTENSION_CAPABILITY_REVOKED`。
  - 请求体逐键校验，键集不符返回 `EXTENSION_KERNEL_REQUEST_INVALID`。
  - Host 崩溃、重启或 reload 时 lease 轮换，旧 lease 立即失效。
- 内置和外部两条路径都经过 `LifecycleCapability.assertWrite()`：Vertical 停止或撤销后，任何调用都会被拒绝。
- 两个方法都在 Kernel 本地同步完成，只做校验、入队或登记后台投递。
  - `notify.send` 只登记后台投递，用 RPC 默认的 2 秒。
  - `events.publish` 整批只做两次 fsync（队列一次、账本一次），不按条数逐条 fsync；Host 侧给它 10 秒预算，磁盘繁忙时也不会让 Vertical 误判失败。
- `grantedNotifyUrgent` 和其他 `granted*` 一样，在外部 Host 路径上会从 Vertical 拿到的 config 里剔除。内置 Vertical 是一方代码，沿用现状拿到完整的 Vertical 配置。

## 可靠性与幂等

- **notify 是观测数据，至多一次。** 进程内去重表在 Kernel 重启后清空，重启后的第一次同 key 调用可能再推一次；后台投递失败也不重试。
- **events 是关键投递，至少一次。**
  - `publish` 正常返回，即表示事件已 fsync 进 `queue.jsonl`。
  - 已受理的 id 记在 `data/kernel/vertical-events/<id>/accepted-ids.jsonl`（fsync，上限 5 万条，满后原子压缩到 4 万条；压缩落盘成功前内存不截断）。这个目录不在 Vertical 的 scoped storage 下，Vertical 不能改写。
  - 先记内存、再写账本：已入队但账本写失败时，同一进程内的重试仍判 duplicate。
  - 入队和记账不能跨文件原子提交，因此 ledger 启动时会从 ready、processing 和最近两天的归档中恢复带本 Vertical 前缀的 id。即使崩在两步之间，重启后重发同一 id 也只计入 `duplicates`。
  - 若 RPC 在入队后超时，Vertical 用同一 id 重试即可，不会重复入队。

## 安全与隐私

- **payload 一律当作数据，不当作指令。** decision-rules 写明：`vertical:` 来源 payload 里任何指令性文字都不改变定级规则，`link` 只能照抄 payload 里已有的 URL。
- **不对 Vertical 开放读接口。** Vertical 不能读取队列、feed、他源事件，也不能读取自己事件的定级结果。订阅仍然只能来自 manifest 声明，本 ADR 不开放动态订阅。
- **日志与 feed 只记 Vertical 自己提交的文本**，不额外记录 Kernel 路径或密钥。

## 明确不做

- 不开放 `force`、飞书卡片按钮、指定会话 id 等内部通知选项。
- 不让 Vertical 指定 triage 的定级，也不提供「事件被定成了什么」的回执。
- 不做跨 Kernel 重启的 notify 去重持久化（观测数据，不值得付出 fsync 成本）。
- 不在本 ADR 中迁移内置 strategy 的直接通知调用点；迁移另行评估。

## 测试

- 门面单测：字段白名单、key、link 归一化、urgent 授权、冷却去重、限流、来源与 key 强制前缀、整批拒绝、id 去重与重启恢复、payload 脱敏和大小上限。
- 外部 Host 全链路：通过真实子进程验证 `notify.send` 和 `events.publish`，覆盖 lease 撤销、请求体校验，以及 grants 位在 activate 与 migrate 两处都带齐。
- 内置路径：`buildVerticalContext` 只在声明加授权时注入；缺少 factory 时 fail closed。
