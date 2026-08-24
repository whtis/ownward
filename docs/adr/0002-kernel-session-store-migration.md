# ADR 0002：Kernel Session Store copy-forward 与孤儿关联归档

状态：Accepted（实现、真实副本演练与独立安全复审整改完成）
日期：2026-08-17  
迁移 id：`stage6-kernel-sessions-v1`

## 背景

Session Service 已成为会话身份的唯一 owner，但 canonical store 仍位于 legacy `data/sessions.json`。真实数据副本存在一条 Session→Task dangling 引用：Session 和 Provider native ref 可验证，完整 WorkTask 不存在。Session 无法证明 WorkTask 的任务正文、项目根、模式、开始时间或生命周期；自动创建 WorkTask 会伪造业务事实，并可能误触发 reaper、harvest 或 flight。

## 决策

1. 将 Session Store copy-forward 到 `data/kernel/sessions.json`。Kernel primary 存在时只读它；不存在时只读 fallback `data/sessions.json`。所有新写进入 primary，legacy 源永不由本迁移修改或删除。
2. 对精确审计确认的缺失 Task 关联，不创建 Task、不删除 Session/native ref/history。迁移后的 Session：active `taskIds` 为空；保存严格的 `archive` provenance；DTO 明确 `operability=read-only`。归档 state/states 只读本地 initial-history snapshot，缺失时明确 unavailable，不调 Provider、不回落 legacy、不写盘；refresh 与所有运行态 mutation 均 fail closed。
3. 归档不是 tolerated dangling。原 ref 已从 active graph 解除，但仍在独立 provenance 集合中接受完整性校验；inventory 分别报告 active refs 与 archived provenance。
4. repair input 是副本本地的 `0600` 文件，位于 data root 之外，包含精确 Session/ref 对和源聚合 SHA-256。读取必须在同一 fd 上 `O_NOFOLLOW` open + `fstat`，验证 owner、regular file、`0600`、`nlink=1`；输出父目录也必须通过 owner/mode 边界。源指纹覆盖 canonical source、Task/pin/Action、schema 与 marker 状态；任一语义输入变化都拒绝 apply。
5. 迁移只允许带 sanitized-copy marker、无 secrets、无 symlink 的数据副本。生产 apply 不属于本 ADR 的自动步骤。

## 原子性与恢复

- apply 前校验磁盘空间至少覆盖 backup + target copy-forward，再加 20%。
- 获取 migration lease，创建 `0700` backup/staging 与 `0600` 文件，逐文件和目录 fsync。
- 在 staging 构造完整 target，并在隔离验证根校验数量、active refs 与 archived provenance；随后持久化 `schema.json.applied` 和 prepared commit marker，最后以 target 原子 rename 作为唯一读可见性切换点。marker 已写但 target 未发布的崩溃可从 staging 校验后重跑收敛。
- legacy source 必须保持逐字不变。backup manifest 绑定源 fingerprint，但不在 rollback 时恢复为业务文件。
- commit marker 明确绑定 target digest、post cardinality/ref aggregate 与 post semantic-input digest。幂等快路逐项重算 schema applied、target、数量、引用和当前输入；合法但被替换的 target 或任何 drift 均 fail closed。
- rollback 只撤销本 plan 拥有的 primary/schema/marker。primary 先原子 rename 到隐藏位置，reader 立即回到 legacy；随后恢复 schema，最后撤 marker。durable rollback journal 使 primary-switch/schema/marker 三个中断点都可重跑。不回写 Task/Action/pin 等其他 owner 的迁移后业务写；target 已有业务 drift 时拒绝 rollback。

当前 executor lease 只互斥迁移器，不等价于 daemon 停写协议。若未来允许生产 apply，必须先停止 daemon/Runner 的业务 writer，或让所有 writer 共同遵守同一全局 lease。

## 兼容窗口与旧 reader 删除门

`data/sessions.json` 至少保留一个完整发布周期。期间收集 primary/legacy fallback 状态，并持续执行真实副本、关联和 backup restore 演练。Phase 6 完成不要求在同一发布删除 legacy reader。

真正删除 fallback reader/legacy source 必须另立 ADR，且同时满足：至少一个已部署发布周期没有非预期 fallback；所有 Session/Task/pin/Action/native ref/history 关联通过；真实副本 apply/fault/rollback 再次通过；last-good/旧二进制恢复范围已记录；删除动作与本次 copy-forward 不在同一提交。

## 明确不做

- 不迁移全部 `data/kernel/*` 或 Provider artifacts；目标布局只是候选，其他 owner 未稳定前不为整洁搬目录。
- 不读取 Provider transcript 正文来猜 WorkTask。
- 不把任何具体领域 Vertical 的完整迁移并入 Phase 6。
- 不把 `recoverable=true` 解释为可运行；归档 Session 即使保留 native ref 也只能读取。
