# Ownward

> Your work, carried forward.

Ownward 是一个本地优先的 **AI 工作连续性层（AI work continuity layer）**。它把工作事件、Agent 执行过程和人工决策连在一起，整理成可读、可核对、可以继续使用的项目记录。

项目仍处于早期 alpha，产品品牌为 **Ownward**，命令行入口为 `own`。

## Agent 做完了，工作留下来了吗？

一个需求可能来自飞书或邮件，讨论留在某次 AI 会话里，代码改动发生在临时 worktree，最终决定只出现在一句聊天回复中。

几周后再回来，你知道事情做过，却很难回答：

- 任务为什么开始？
- Agent 实际执行了哪些命令，改了什么？
- 哪些方案试过但没有采用？
- 哪个结论经过了人工确认？
- 下一次应该从哪里继续？

Ownward 记录的是一次工作的生命周期，而不是又复制一份聊天历史。

```text
飞书 / Gmail / GitHub / 日历 / 人工需求
                      ↓
                Event / Action
                      ↓
          Claude Code / Codex 执行
                      ↓
       旁观 / 追问 / 审批 / 验证 / 接管
                      ↓
   项目日志 / Flight Record / 候选记忆 / 下一步
```

## 它解决什么

### 每次执行都有记录

后台任务会生成 Flight Record，保存任务目标、会话过程、权限审批、执行命令、代码变化、commit、token 使用和最终结论。

这不是一份只写“任务已完成”的摘要。需要追查问题时，你可以看到 Agent 当时做了什么。

### 每个结论都有依据

Ownward 的日报流程可以从近期工作中提出长期记忆候选；在绑定项目角色的对话里，用户也可以把结论手动存为项目知识候选。模型不能直接改写正式记忆。

候选内容先进入 `_candidates/`，保留来源和证据。人确认以后，它才会进入项目 README、decisions、operations 或正式 memory。这道人工确认不会被自动化掉。

### 项目可以从上次停下的地方继续

项目 README 被用作当前真相，由人与 AI 共同维护；月度日志记录演进过程，Flight Record 保留任务事实。下一次派发任务时，这些材料可以重新进入上下文，不必指望某个 Agent 还记得上一次会话。

### 未完成的事情会重新出现

飞书、邮件和 GitHub 等事件可以进入 Action 状态机：

```text
open → snoozed / processing → resolved / dismissed
```

暂缓的 Action 到期后会自动回到 `open`。Heartbeat 另行检查日历、GitHub 和用户定义的清单，主动提醒可能被忽略的事情。通知被划走、终端被关闭，不等于事情已经处理。

## Ownward 不是什么

Ownward 不是完整 IDE，也不准备取代 Claude Code、Codex 或其他 Agent。它不以“把所有 Agent 放进同一个聊天窗口”为目标。

它也不是自动吞下所有会话的第二大脑。正式项目知识仍然由人确认，worktree 也不会被包装成安全沙箱。

目前不能自动导入 ChatGPT 和 Claude 网页端的全部历史。现有执行端是 Claude Code 和 Codex；未来计划通过适配协议接入更多工具，而不是在 Ownward 里重新实现每一种 Agent。

## 快速开始

目前支持 macOS，需要：

- [Bun](https://bun.sh)
- Git
- 已登录的 [Claude Code](https://claude.com/claude-code) 或 [Codex CLI](https://github.com/openai/codex)（可选：腾讯 [CodeBuddy](https://copilot.tencent.com)，`providers.codebuddy.enabled` 开启）

```bash
git clone https://github.com/whtis/ownward.git
cd ownward
./install.sh
open http://127.0.0.1:4517
```

安装脚本会生成本机配置，并用 launchd 启动常驻 daemon。Dashboard 默认只监听 `127.0.0.1:4517`。

默认决策引擎是 Claude。只安装 Codex 时，需要在生成的 `config.json` 中设置：

```json
{
  "llm": { "engine": "codex" }
}
```

不配置外部账号也可以使用：

- Claude Code / Codex 任务派发与看护
- Claude Code 会话收割
- 项目日志与 Flight Record
- Action 队列和 Heartbeat
- Markdown 笔记
- macOS 通知

飞书、Gmail、GitHub、日历和股票事件源默认关闭，需要时再开启。

## 派发 Agent 任务

命令行入口是 `own`：

```bash
# 在 Terminal 中启动 Claude Code，随时人工接管
bin/own work ~/workspace/example "修复登录页闪退"

# 在隔离 worktree 中后台执行
bin/own work ~/workspace/example "补全单元测试" --bg
bin/own work ~/workspace/example "重构 utils 目录" --bg --codex

bin/own tasks
bin/own done <id>
```

Dashboard 会显示流式输出、工具调用和权限请求。你可以继续追问、中断或接管任务，也可以检查仓库状态、diff、测试、commit 和 PR。

## 本地工作记录

默认 vault 位于：

```text
~/Documents/ownward-vault/
```

主要结构：

```text
ownward/YYYY-MM-DD.md          事件分流摘要
inbox/YYYY-MM-DD.md            收割的工作素材
projects/<slug>/
  README.md                    项目当前真相
  log/YYYY-MM.md               项目演进日志
  _candidates/                 待确认的项目知识
flights/                       任务执行记录
daily/YYYY-MM-DD.md            每日总结
memory/
  _candidates/                 待确认的长期记忆
```

配置工作/私人分流后，项目、日志和记忆会分别进入 `work/` 与 `private/` scope。

主要产物是普通 Markdown。可以直接阅读、编辑、搜索、提交到 Git，也可以用 Obsidian 或其他文本工具管理。

## 可选事件源与周期职责

Ownward 可以接入：

- GitHub：通知、PR 检查、review 与合并
- 飞书：消息、日历和文档相关工作
- Gmail：邮件分流与少量常用动作
- 股票：定时行情事件，仅作为个人化模块

Routine 用于晨会、周报等周期职责。系统先从工作记录生成草稿，由人审核，再派 Agent 写入正式文档。

事件源和 Routine 都不是运行 Ownward 的前置条件。配置方法见 [配置指南](docs/configuration.md)。

## 工作台

Dashboard 是 daemon 内嵌的静态 Web 页面，没有单独的前端构建步骤。

- **今日**：Action、Agent 注意力、Routine 和日程
- **通知流**：事件分流结果
- **任务**：派发、旁观、追问、审批和接管 Agent
- **对话**：Claude / Codex 对话入口；它是执行入口之一，不是产品定位
- **笔记**：浏览和编辑 Markdown vault
- **系统**：事件源健康、定时任务、日志和运行状态

## 架构

Ownward 是一个 Bun / TypeScript daemon，内嵌纯静态 Web 工作台。运行时零 npm 依赖。
整体分四层：**Kernel / Provider / Connector / Vertical**（完整设计见
[docs/architecture-v1.md](docs/architecture-v1.md)）。

### 进程拓扑

```text
launchd
├── ownward daemon（Kernel + Web + Connector + Vertical Runtime）
├── ownward Runner（独立进程：Provider 执行，daemon 重启不杀任务）
└── 外部 Vertical Host × N（每个外部扩展一个独立进程，unix socket RPC）
```

daemon 与 Runner 分进程是刻意的：Runner 持有正在执行的 Agent 会话，
daemon 升级/崩溃/重启都不打断任务；两者之间靠 **durable journal**
（append-only jsonl + fsync，commands/events 双日志）对账，命令结果丢失时
收敛为显式 `unknown-outcome`，绝不猜测成功。

### 四层职责

- **Kernel** — daemon 本体：SessionService（会话身份/权限/审批的唯一真相）、
  任务注册表（tasks.json，原子写 + 进程锁）、Action 状态机、调度、发布事务。
- **Provider** — Agent CLI 适配器，注册在 Runner 里，目前三家：

  | Provider | CLI | 说明 |
  |---|---|---|
  | `claude` | Claude Code | stream-json 全能力：审批桥 / 图片 / 续聊 / 热加目录 / 历史回读 |
  | `codex` | Codex CLI | 每轮 `codex exec resume`，rollout 文件回读历史 |
  | `codebuddy` | 腾讯 CodeBuddy | Claude Code 协议克隆，同一 adapter 参数化复用；无审批桥（standard 权限自动退化 `--permission-mode acceptEdits`），transcript 为私有格式不支持历史回读；opt-in 注册，不进发布门 |

  适配器对 CLI 能力做**运行时探测**（`--effort` / `--permission-prompt-tool`），
  探不到就显式降级，绝不发未知旗标把进程打崩。
- **Connector** — 外部事件源（飞书 / GitHub / Gmail / 股票）：严格 manifest、
  durable checkpoint、spool 重建去重、背压与脱敏。
- **Vertical** — 业务面。内置 `dev`（开发台）与 `strategy`；外部扩展包经
  `verticals.externalPaths` 发现装载，跑在独立 Host 进程里，崩溃只熔断自己、
  退避重启，不连坐 daemon。

### 事件与工作流水线

```text
Sources
  ↓
Durable Spool
  ↓
Triage ──→ Feed / Notification
  ↓
Actions
  ↓
Dispatch / Agent Sessions（Kernel → Runner → Provider）
  ↓
Harvest / Flight Record
  ↓
Project Knowledge / Memory Candidates / Daily Digest
```

### 发布事务

自演进和日常部署走同一条发布事务：

```text
代码 + config 冻结为 release 快照 → 安装 Runner → 安装 daemon
→ 120s 观察窗（daemon/Runner 身份漂移比对，provider 只比 id/version/capabilities）
→ provider canary（真实拉起 claude/codex 各跑一发）→ state 提交
```

任一步失败自动回滚到上一个 release。两个由此而来的运维事实：

- **改 `config.json` 必须重跑一次发布事务**（`bash install.sh`）——daemon/Runner
  读的是冻结快照，热改文件、单独 kickstart 进程都不会生效。
- **观察窗内不要派任务 / 发消息**——正常做法是等 `release committed` 再动。

### 不会轻易改变的设计

- 需要处理的事件走持久队列，成功消费前不会主动丢弃
- Feed 和健康信息属于观测数据，不阻塞关键路径
- Action 准入和状态转换是确定性的，不让模型猜测事情是否完成
- 项目知识和正式记忆以 Markdown 文件为真相
- 自演进上线、Routine 正式写入、候选记忆晋升始终需要人工确认
- 事件源、Provider 和 Vertical 分别扩展，互不渗透

公开路线见 [ROADMAP.md](ROADMAP.md)；alpha 阶段的 API 和数据格式仍可能调整。

## 配置

Ownward 使用两层配置：

- `config.default.json`：仓库中的完整默认配置
- `config.json`：本机覆盖层，已被 Git 忽略

常用入口：

1. `config.json`：端口、vault、通知、事件源和模型
2. `prompts/owner.md`：哪些人和事情重要，以及你的表达偏好
3. `prompts/heartbeat.md`：主动检查清单
4. `data/routines.json`：晨会、周报等周期职责

修改配置后运行：

```bash
bash install.sh
```

## 隐私与安全

Ownward 的存储和控制面在本地，但它不是安全边界。

- 发送给 Claude、Codex 或其他外部服务的内容受相应服务条款约束
- Dashboard 默认只监听 localhost，并进行 Host / Origin 校验
- 远程访问需要令牌，建议只通过 Tailscale 或可信 TLS 代理开放
- Agent 可能以当前用户权限执行命令和修改文件
- worktree 可以减少误改主 checkout 的风险，但不是沙箱
- `config.json`、`prompts/owner.md`、`data/`、vault、凭据和原始会话不应提交到 Git
- 不要在公开 Issue 中提交漏洞细节、私人日志或访问令牌

安全报告方式和支持范围见 [SECURITY.md](SECURITY.md)。

## 开发与验证

```bash
bun install --frozen-lockfile
./verify.sh
```

验证门包括 Bun 构建、`tsc --noEmit`、单元测试、daemon 冒烟测试、API 探活和 Web JavaScript 解析。

开发环境、架构边界和验证要求见 [开发指南](docs/development.md)。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 安卓发版

```bash
cd /path/to/ownward-public && scripts/android-publish.sh -n "发布说明" # 仅在公开 main：bump 版本 → tag → push
scripts/android-release.sh --from-github                  # 从公开 GitHub Release 下载 APK 到 daemon，手机「检查更新」升级
```

推 `android-v<versionName>+<versionCode>` tag 后，公开仓库 `whtis/ownward` 的 GitHub Actions（`.github/workflows/android-release.yml`）
用 repo secrets 里的签名密钥构建 release APK，连同 `android.json`、`SHA256SUMS` 发到 GitHub Releases
（alpha/beta 标为 prerelease）。渠道 `--channel alpha|beta|stable` 只能前进，stable 必须已有同版本 beta；
`--version X.Y.Z` 才改版本号，默认只递增构建号（`YYYYMMDDN`）。推 `android-test*` tag 或手动触发只构建不发布，
用来自检流水线。私有仓只保留 Android 构建 artifact，不能创建 Release。

## 二次开发

两条路径：给 Ownward **写外部 Vertical 扩展**（推荐入口，不碰底座），
或**修改 Ownward 本体**（自演进流程）。

### A. 外部 Vertical 扩展包

一个外部 Vertical 是一个自带 `package.json` 的独立目录（独立 git 仓库亦可），
官方样板见 [examples/verticals/sample-readonly](examples/verticals/sample-readonly)：

```text
my-vertical/
├── ownward.vertical.json     # manifest（见下）
├── index.ts                  # entry：默认导出 OwnwardVertical
├── package.json              # 三方依赖自带 node_modules（不进 import lint）
├── src/                      # 领域代码 + 测试
└── web/                      # 前端资产（html/css/js）
```

**manifest 要点**（`ownward.vertical.json`）：

```jsonc
{
  "id": "my-vertical",              // ^[a-z][a-z0-9-]*$
  "name": "示例扩展",
  "version": "1.0.0",
  "kernelApiVersion": 1,
  "entry": "index.ts",
  "capabilities": ["storage"],      // 按需申报，config 里还要再授一次
  "routes": ["/api/verticals/my-vertical/items"],   // 必须此前缀，逐条精确列举
  "assets": [{ "path": "/verticals/my-vertical/index.html",
               "file": "web/index.html",
               "contentType": "text/html; charset=utf-8" }],
  "navigation": [{ "id": "my-vertical", "label": "示例",
                   "href": "/verticals/my-vertical/index.html" }]
}
```

**entry 契约**（`index.ts` 默认导出）：

```ts
export default {
  async activate(ctx) { /* 存 ctx；ctx.config / ctx.log / ctx.storage 按授权注入 */ },
  async deactivate() {},
  async route({ request, url, signal }) { /* 返回 Response 或 null */ },
  health() { return { ok: true }; },          // 不要在这里落隐私字段
  async migrate({ migrationId, storage }) {}, // 可选；按 (id, version) 幂等执行一次
};
```

**接入**（宿主机 `config.json`，改完跑一次 `bash install.sh` 走发布事务）：

```jsonc
{
  "verticals": {
    "externalPaths": ["/abs/path/my-vertical"],
    "my-vertical": {
      "enabled": true,            // 双门之一
      "trusted": true,            // 双门之二：确认这是你信任的本地代码
      "grantedCapabilities": ["storage"],
      // ……其余键作为领域配置原样进入 ctx.config
    }
  }
}
```

**规则与边界**：

- `enabled` + `trusted` 双门缺一不可；外部扩展是**受信本地代码**，
  进程隔离是可用性边界（崩溃不连坐），不是安全沙箱。
- import lint：第一方源码禁止 import 底座模块（`util.ts` / `actions.ts` /
  kernel/runner 内部），动态 import 必须是字符串字面量；`node_modules` 不扫。
- capability 按申报 + 授权双重确认后注入 `ctx`：`storage`（scoped JSON 存储，
  落 `data/verticals/<id>/`）、`actions`（open/list/resolve/dismiss，全异步；
  id 强制 `<verticalId>:` 前缀、source 由 kernel 强制为属主）、`scheduler`
  （`ctx.scheduler.every(id, ms, fn)`，只能在 activate 期间注册，由 kernel 按拍驱动）。
- 外部路由默认限制：JSON-only、请求 ≤256KB、响应 ≤512KB、2s 超时。受信 Vertical 可在
  config 按项授权放宽：`grantedRouteTimeoutMs`（硬顶 600s）、`grantedRouteBodyBytes`
  （硬顶 64MB，frame 上限随之协商）、`grantedRouteBinary: true`（非 JSON 透传；
  multipart 上传原生可解，image/pdf inline、其余 attachment）。
- 页面资产（html/css/js）inline 渲染，CSP 收紧为同源 + 内联、禁外联。

**热重载（开发循环的核心）**：

```bash
curl -X POST http://127.0.0.1:4517/api/system/verticals/reload \
     -H 'Content-Type: application/json' -d '{"id":"my-vertical"}'
```

或在工作台「系统 → 扩展 Vertical」面板点「重载」。原理是杀 Host 进程重拉，
重新 import 磁盘代码，秒级生效、daemon 不动；新 manifest / 代码**先校验后拆旧**，
改坏了旧实例继续跑。manifest 的路由 / 资产变更随重载进账，改 `id` 会被拒绝。

**用开发台开发扩展的闭环**（人不写代码也能迭代）：

1. 扩展目录加进 `architecture.allowedRoots`，`bash install.sh` 生效
2. 开发台派任务给 Agent（claude / codex / codebuddy 任选），
   Agent 在隔离 worktree 里改代码、跑包内测试、commit
3. 合回检出 → 点「重载」验证 → push / PR 协作

### B. 修改 Ownward 本体（自演进）

1. 通读 [开发指南](docs/development.md)（架构边界、开发约束与验证要求）
2. 在隔离 worktree 修改，根目录 `./verify.sh` 必须输出 `VERIFY: PASS`
3. 合并后走发布事务上线（观察窗 + canary + 自动回滚兜底）

工作台「系统」页有「派发演进任务」入口，Agent 可以全程代跑这条流水线，
上线动作始终留给人确认。

### ⚠️ 大流量场景必须切换装载模式（ADR）

外部 Vertical 当前的 **Host 进程模型**换来了崩溃隔离与热重载，代价是路由
经 unix socket RPC 有一次 base64 内存拷贝。这个取舍只对
「单用户 + 中小载荷」成立——**一旦出现高频大载荷路由（视频 / 大文件流式、
多用户并发），不要在 Host 模型上硬扛，必须切换 in-process 受信装载**。

切换是宿主侧 loader 换挡：manifest / entry / `ctx` 契约在两种模式下完全一致，
扩展包代码零改动。判断信号：路由 P95 内存拷贝开销可见、单请求载荷持续逼近
帧上限、或并发用户数超过个位数。

## 当前状态

Ownward 仍处于早期 alpha：

- 当前只正式支持 macOS
- 当前执行端是 Claude Code、Codex 和 CodeBuddy（腾讯）
- 外部事件源需要自行配置相应 CLI 或 OAuth 凭据
- Provider / Agent Adapter 尚未形成稳定的第三方插件 API
- 数据格式、API 和界面仍可能变化

项目采用 [Apache License 2.0](LICENSE)。

---

**Ownward — your work, carried forward.**
