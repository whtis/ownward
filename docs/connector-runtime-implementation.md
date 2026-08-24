# Connector Runtime 实施台阶

Connector 是外部事实进入 Ownward 的唯一采集边界。它只负责认证、轮询/长连接和标准化，输出带稳定上游 id 的 `ConnectorEvent`；不能创建 Action，不能调用 Provider、Runner 或 Vertical。Action 与领域对象必须由 Kernel/Vertical 的幂等订阅者产生。

Kernel 契约位于 `src/kernel/connectors/`：严格 manifest、整数 `kernelApiVersion`、声明式 event namespace、durable checkpoint、health/lifecycle、batch backpressure 和 secret 引用白名单。事件先 durable append 到 Kernel spool，再记录 connector accepted-id，最后原子推进 checkpoint；spool 的 `ts` 永远是 Kernel 入队时间，上游时间保存在 payload `_occurredAt`，不能污染队列/归档顺序。spool 满时批次进入有界、去重、可重启的 connector pending；drain 禁止再次 defer，只有确认真正 append 才 ack 原 pending，guard 后容量变化也不会丢事件。

领域消费由唯一的 Domain Dispatcher 负责：priority card 与普通事件各自串行、共享原子 journal 锁，因此 card 不会被 nightly 等长投影阻塞，Triage 也不再是第二个投影入口。普通事件入队后异步投影，durable spool 负责崩溃恢复；card 则等待即时内存投影完成。daemon 重启时从 ready/processing spool 恢复，有界状态快照记录实例 owner/lease：同 owner 的有效 lease 才跳过，旧 owner 即使 lease 未过期也立即显式收敛为 unknown/terminal。GitHub/daily 等幂等投影已知失败最多重试三次；card callback 非幂等，第一次失败即 terminal + Action，不做即时重放。系统只承诺 at-least-once ingest，不宣称 exactly-once。

外部 Connector 与外部 Vertical 使用同一信任原则：绝对路径仅代表被发现；默认 disabled，且必须 `enabled:true` + `trusted:true` 双门后才能执行。外部代码不被 daemon 同进程 import，而是在独立 Connector Host 子进程中通过 capability-authenticated、1 MiB framed Unix IPC 调用 manifest 已获授的异步 `publish/checkpoint/secret/reportHealth/log`。每个 source 的 poll/连接结果通过 `reportHealth` 主动进入 Runtime；显式 `probe()` 也能探测，`health()` 只返回纯只读快照。关闭采用 TERM→有界 KILL→wait→临时目录清理，start/stop 之间有跨 connector barrier。该边界不是 OS sandbox。

first-party Lark/GitHub/Gmail/stock manifest 已登记，旧 `sources.*` 配置继续作为兼容配置入口。daemon 只启动 Connector Registry 一条采集链；旧 `startX` 入口也只委托同一个 Registry。长连接消息、卡片回调和 Lark nightly 都产标准事件，Action/未读/digest 在 policy consumer 投影。GitHub snapshot ID 带 boot + emission nonce，即使 checkpoint 损坏被隔离、observation 回退，也不会与 accepted 历史相撞。旧扁平 key 与新 namespace-qualified key 的硬匹配只存在于 domain consumer/Lark reaction filter，并有双格式 fixture；Triage/digest 不按 key 解 payload。

secret 只能由 Kernel 按 connector id 的环境变量白名单或内置 opaque ref broker 解析；Gmail Connector 只拿 `GMAIL_ACCOUNTS` 引用结果，不自行扫描 secret 目录。config、`/api/system/connectors` diagnostics、日志与 durable event payload 都递归脱敏。Lark card 的短期 token 只存在于受信进程内的即时投影副本，spool/archive 永远保存脱敏值，恢复时也不会拿占位符发回写请求。checkpoint 损坏会保留 quarantine 证据、创建 Action、以空 cursor 降级启动；首次成功投递恢复 ready。

DeepSeek、WorkBuddy、Gemini CLI 是 Agent Provider，不是 Connector。未来接入只实现 Provider contract/capabilities，不应放进 Connector Registry。
