# Ownward 扩展与贡献契约

> 这份文档定义公开 Ownward base 的稳定边界，以及外部 Vertical / Connector 如何在不污染 Kernel 的前提下扩展能力。
> 个人和公司业务可以基于 Ownward 开发，但业务实现、凭据、原始语料和联系人不应进入公开 base。

## 1. 先判断自己在贡献什么

Ownward 不是把所有代码都放进一个仓库的单体应用。贡献前先判断目标属于哪一层：

| 类型 | 应放在哪里 | 典型内容 | 不应做什么 |
|---|---|---|---|
| Base / Kernel | Ownward 公开仓 | Task、Run、Session、Action、Event、通用通知、通用 Web 组件、稳定数据契约 | 不绑定公司系统、个人联系人或业务术语 |
| Connector | Ownward base 或独立 Connector 仓 | 认证、轮询/长连接、标准化事件、checkpoint、health | 不直接创建 Action、调用 Provider、写通知或执行领域副作用 |
| External Vertical | 独立 Vertical 仓 | 领域实体、页面、业务规则、领域调度、领域 Action | 不直接 import Kernel 私有实现或读取 `data/` |
| 公司 / 个人 Vertical | 私有 corp 或个人仓 | 公司系统、私有 MCP、联系人、语料、业务映射 | 不提交到 GitHub base |
| Provider / Runner | Ownward base 的 Provider 契约或独立 Provider 仓 | normalized command/event、进程生命周期、Provider 适配 | 不把领域策略塞进 Provider |
| Client / Sidecar | 独立客户端或 sidecar 工程 | 移动薄壳、系统热键、系统通知 | 不复制代码和凭据到客户端，不提前引入桌面分发链 |

### 1.1 一个实用判断法

如果把公司名、项目名、联系人和具体平台名称全部替换掉，功能仍然成立，它可能是 base 能力；如果替换后功能就失去意义，应放进 Vertical 或 Connector。

例如：

- “待确认 Action、snooze、artifact manifest”是通用能力；
- “某公司的需求状态流转、私有质量平台查询、特定群聊联系人”是领域实现；
- “把外部状态变成稳定事件”是 Connector；
- “根据事件生成一条待办并通知人”是 Kernel policy 或 Vertical consumer，不是 Connector 本身。

## 2. Base 贡献的硬约束

### 2.1 数据和隐私

- 不提交 `data/`、`config.json`、`prompts/owner.md`、vault、Provider 原生会话、联系人、token、open_id 或原始语料。
- 新增数据必须说明 owner、路径、schema/version、可靠性、保留期、恢复方式和导出策略。
- 原始数据、处理结果和观测指标分层保存，不要把运行队列、通知流和长期语料混成一个文件。
- 明文保存原文可以是产品选择，但身份标识和凭据仍须按字段 allowlist 处理。导出必须默认脱敏，并支持 dry-run。
- 不把迁移演练脚本当成用户备份工具；导出和恢复必须有独立的 manifest、checksum 和失败报告。

### 2.2 可靠性和失败语义

必须明确数据属于哪一类：

- **关键投递**：事件队列、Action、Agent 唤醒、退出上报。消费成功前不得丢失，失败要可重试。
- **观测数据**：feed、健康指标、飞行记录。允许至多一次，不能为观测可靠性阻塞关键路径。

任何接口返回 `2xx` 或 `ok: true`，只能表示“已经完成”或“已经确定性排队”。不支持、未知结果、认证失败、协议不匹配和容量不足都必须显式呈现。

### 2.3 人工审批门

以下门是产品设计，不是待优化的摩擦：

1. Ownward 自演进的 verify → 人工批准上线；
2. Routine 草稿 → 人工确认后写入外部文档；
3. Memory / project candidate → 人工合并为正式记忆。

发送消息、改外部状态、自动修复、合并代码等新增副作用，也必须有自己的策略、幂等键、审计和失败回收，不得笼统地复用“任务完成”表示成功。

## 3. Vertical / Connector 扩展契约

### 3.1 Vertical

External Vertical 必须：

- 使用 `ownward.vertical.json`，声明 `kernelApiVersion`、版本、routes、assets 和 capabilities；
- 使用 `/api/verticals/<id>/...` 和 `/verticals/<id>/...` 命名空间；
- 仅使用 manifest 中声明且当前 Kernel 已开放的 scoped capability；External Vertical v1 至少通过 `ScopedStorage`，其他 capability 必须先经过契约评审和启用门；
- 默认 disabled，只有 `enabled: true` 和 `trusted: true` 同时满足才启动；
- 使用 `minKernelVersion` 表达最低 Kernel 版本；
- 为路径越界、symlink、超时、取消、重启恢复和 capability 缺失提供 contract tests。

禁止：

- 直接 import `util.ts`、`paths.ts`、`actions.ts`、`dispatch.ts`、Runner、Provider 或 Kernel 私有文件；
- 读取或修改其他 Vertical 的目录；
- 通过 HTTP、shell 或未登记的子进程绕过 capability；
- 在 base 的 `today.js`、`app.js`、`style.css` 中写入公司业务专用卡片。

### 3.2 Connector

Connector 只负责“外部事实进入 Ownward”：

- 输出稳定的 upstream event id；
- 使用 checkpoint、accepted-id、pending/replay 和 health；
- 在 Connector payload 中脱敏 secret；
- 明确限流、截断、重试、quarantine 和未知结果；
- 只发布声明过的 event namespace。

Connector 不负责：

- 创建 Action；
- 决定 act / ask / silent；
- 直接发通知；
- 调用 Agent、Runner 或领域 API。

这些事情由 Kernel policy 或 Vertical 的幂等 consumer 完成。

### 3.3 新 capability 的申请方式

当前某个 capability 不可用时，不能在扩展里偷偷实现一个旁路版本。先提交一个 Core Contract PR，包含：

1. 使用场景和不做什么；
2. 稳定 DTO / RPC schema；
3. 授权、撤销、超时和重启语义；
4. 可靠性级别和幂等策略；
5. 安全与隐私分析；
6. contract tests 和迁移/兼容方案。

然后再提交依赖这个契约的 Vertical PR。Core Contract 和业务实现应保持可分离。

## 4. Web 贡献约束

- 继续使用零构建、零运行时 npm 依赖的路线。
- base Web 只提供通用布局、事件总线、slot 和渲染协议；业务 tab 通过 Vertical asset 注入。
- 新增全局函数前，先检查 `web/*.js` 的 classic-script 共享作用域，避免重名覆盖。
- 保持现有移动端行为、Host/Origin 防护、`safeUrl` / `esc` / `jsq` 转义纪律。
- 连续工具流的折叠必须保留失败计数，不能为了视觉整齐改变消息顺序。
- 只有当单文件超过约 1500 行，或聊天交互复杂度确实爆发，才重新评估局部 vendored Preact+HTM；不以一次页面需求为理由引入全栈构建链。

## 5. 模型和调度配置

Vertical 不应硬编码具体模型名称。通用配置提供 `quality`、`bulk`、`saver` 等别名，由 Kernel 在运行时解析为当前机器可用的 Provider/model。

- `quality`：需要高质量交互或回复；
- `bulk`：蒸馏、批量抽取和低成本处理；
- `saver`：日报、摘要和可重试的后台汇总。

保留旧的直接模型名兼容期，但新 Vertical 只能依赖别名。模型解析失败要显式报错或按已声明的 fallback 规则处理，不能静默换模型。

## 6. 贡献流程

### 6.1 Issue / RFC 模板

大型功能或架构变化开工前，Issue 至少回答：

```text
目标仓：base / connector / external vertical / corp
是否新增 Kernel capability：
是否新增外部副作用：
数据路径与 schema：
可靠性：关键投递 / 观测数据
人工审批门：
幂等键与未知结果：
迁移、回滚和兼容方案：
是否含公司字面量：base 必须为否
测试与验证计划：
```

### 6.2 实现和验证

1. 先读 `docs/development.md`、`docs/configuration.md` 和相关 Runtime/Connector 文档；
2. 复杂改动先写 ADR，先定契约再写业务；
3. 建议使用隔离的开发 worktree 和临时 `config.json` / `data`，不要连接真实 vault 或凭据；
4. 行为变化必须增加测试，外部 Provider 不依赖贡献者的真实账号；
5. 在 worktree 根目录运行 `./verify.sh`；
6. PR 说明数据、隐私、兼容、回滚、审批和验证证据；
7. 不削弱 Host/Origin、路径校验、类型检查、Runner unknown outcome 或人工审批门。

当前 `verify.sh` 的实际门数以脚本为准；文档、CI 和 backlog 必须保持一致。

### 6.3 PR 分层建议

对于“通用底座 + 公司业务”混合需求，拆成两份 PR：

1. **Core Contract PR**：只包含可回流的通用接口和测试；
2. **Vertical PR**：只包含业务实体、适配器、页面和配置。

如果第二份 PR 没有第一份契约也能运行，说明可能还在绕过底座边界，需要重新审查。

## 7. 内部 Agent 规则与公开贡献规则的区别

每个 WP 独立 worktree、模型档位、subagent 编排、提交 trailer、节假日提醒等，是内部执行流程，不是公共开源贡献门槛。

公开规则只约束可验证的工程边界：仓库归属、数据安全、稳定契约、人工审批、失败语义、测试和发布质量。
