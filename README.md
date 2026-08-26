# Ownward

> Your work, carried forward.

## AI 会话会结束，研发工作不该重新开始

Ownward 是给研发者用的本地 AI 工作台：从手机派任务，让 Claude Code、Codex 和 CodeBuddy 接力干活，再把散落在各个 Agent 中的执行事实收回自己的项目记忆。

项目仍处于早期 alpha，命令行入口是 `own`。

研发者用 AI 编程以后，真正麻烦的通常不是“模型不会写”，而是工作接不上：人离开电脑便无法跟进；Claude 限流后换 Codex，又得从头解释；不同 CLI 改过同一个项目，却没有一份完整记录；写周报时还要重新翻聊天和 Git 历史。

Ownward 在 Mac 上常驻，统一管理任务会话、项目目录和工作记录。Android / iPhone 是它的远程工作台，代码、凭据和 Agent CLI 仍留在你的 Mac 上。

## 五项研发优势

### 1. 无需依赖海外 Provider，Android / iPhone 随时编程

手机连接 Mac 上的 Ownward 后，可以派发研发任务，选择项目目录、附加目录、模型和权限；也可以查看流式回复、工具调用和图片，继续追问、中断任务、切换引擎，或检查仓库状态、diff、测试、commit 和 PR。

Android 客户端可从 [GitHub Releases](https://github.com/whtis/ownward/releases) 获取。iPhone 客户端要求 **iOS 26+**，可用 Xcode 安装到真机；TestFlight 渠道由发布者提供。构建说明见 [ios/README.md](ios/README.md)。

两端都不会把代码复制到手机执行。远程连接需要令牌，建议只通过 Tailscale 或可信 TLS 代理开放，不要把本地端口直接暴露到公网。

Ownward 同时接入 Claude Code、Codex 和腾讯 CodeBuddy。只配置 CodeBuddy 也可以使用完整任务链路，无需访问海外 Provider。Ownward 本身不提供代理，也不会改变 Claude、Codex 各自的网络要求。

### 2. 任务会话和普通 Chat 都能跨引擎继续

任务会话切换引擎时，Ownward 会建立一条可追溯的后继会话链。新引擎拿到有界的近期历史，并接手原工作目录、附加目录和访问权限；接力提示要求它先检查 Git 和文件的实际状态，不能照着旧会话重放工具调用。旧链仍可回看，结果未知的操作必须由人确认后才能接力。

```text
Claude Code ──限流──→ Codex ──换一种能力──→ CodeBuddy
      └──────────── 旧会话与执行记录继续保留 ─────────┘
```

普通 Chat 的切换方式不同：在已选对话中改 Provider 后，Ownward 用现有聊天历史重放上下文，不建立任务后继链，也不携带任务工作区状态。这适合讨论和咨询；涉及真实代码操作时，用任务会话更稳妥。

### 3. 三个 Agent 的执行事实回到同一个项目

在 Ownward 里派给 Claude Code、Codex 或 CodeBuddy 的任务，都会生成统一的 Run 和 Flight Record。无论本轮用了哪个 Agent，任务目标、执行过程、代码变化、commit 和结论都按同一套结构归回项目，不再散落在三个工具各自的界面里。

### 4. 自动收割会话，形成长期项目记忆

外部 Claude Code、Codex CLI 中发生的实质会话会被自动发现并收割。CodeBuddy 的私有 transcript 目前无法从外部回读，因此只收录由 Ownward 发起的 CodeBuddy 任务。

收割结果写入本地 Markdown vault：近期素材进入 inbox，项目演进进入 log，任务事实进入 flights；模型提出的长期知识先进入 `_candidates/`，由人确认后再成为正式项目记忆。下一次派任务时，Ownward 可以复用这些记录，不必指望某个 Agent 还记得上次聊过什么。

### 5. Routine 自动取材起草

Routine 适合晨会、周报、项目同步等固定职责。到时间后，Ownward 会从近期收割记录、任务结果和项目记忆中取材，生成一份待审草稿。

正式写入飞书文档前必须由人确认。Ownward 负责搜集和起草，不替你跳过最后的发布判断。Routine 默认关闭，可参考 [examples/routines.json](examples/routines.json) 配置 `data/routines.json`；飞书接入和详细配置见 [配置指南](docs/configuration.md)。

## 快速开始

目前服务端支持 macOS，需要：

- [Bun](https://bun.sh)
- Git
- 已登录的 [Claude Code](https://claude.com/claude-code) 或 [Codex CLI](https://github.com/openai/codex)
- 可选：腾讯 [CodeBuddy](https://copilot.tencent.com)

```bash
git clone https://github.com/whtis/ownward.git
cd ownward
./install.sh
open http://127.0.0.1:4517
```

安装脚本会生成本机配置，并通过 launchd 启动 daemon 和独立 Runner。工作台默认只监听 `127.0.0.1:4517`。

只安装 Codex 时，在生成的 `config.json` 中设置：

```json
{
  "llm": { "engine": "codex" }
}
```

CodeBuddy 默认不启用，需要设置 `providers.codebuddy.enabled: true`。

## 工作如何留下来

```text
手机 / Web / Terminal 中发起任务
                 ↓
       Claude / Codex / CodeBuddy
          必要时跨引擎继续
                 ↓
       Run / Flight Record / diff
                 ↓
      自动收割为项目工作素材
                 ↓
   人确认候选知识，更新项目当前真相
                 ↓
下一次任务与 Routine 使用已有记录
```

这套循环不是为了保存更多聊天，而是让下一次开发拿到上一次留下的事实。vault 是普通 Markdown，可以直接搜索、编辑、提交到 Git，也可以交给 Obsidian 管理；默认位置是 `~/Documents/ownward-vault/`。

## 能力与边界

| 能力 | Claude Code | Codex | CodeBuddy |
|---|---:|---:|---:|
| Ownward 内派发、续聊、看护 | ✓ | ✓ | ✓ |
| 任务会话跨引擎接力 | ✓ | ✓ | ✓ |
| 普通 Chat 跨引擎继续 | ✓ | ✓ | 按配置开放 |
| Ownward 任务进入统一记录 | ✓ | ✓ | ✓ |
| 自动收割外部 CLI 会话 | ✓ | ✓ | — |
| 无需访问海外 Provider | — | — | ✓ |

Ownward 不是 IDE，也不是 Agent 的安全沙箱。它负责工作连续性，不替代 Claude Code、Codex、CodeBuddy 或 Git。当前也不能导入 ChatGPT、Claude 网页端的全部历史。

## 派发任务

可以在工作台里派任务，也可以使用 CLI：

```bash
# 在 Terminal 中启动 Claude Code，随时人工接管
bin/own work ~/workspace/example "修复登录页闪退"

# 在隔离 worktree 中后台执行
bin/own work ~/workspace/example "补全单元测试" --bg
bin/own work ~/workspace/example "重构 utils 目录" --bg --codex

bin/own tasks
bin/own done <id>
```

后台任务默认在隔离 worktree 中运行。worktree 能减少误改主 checkout 的风险，但不是权限沙箱。

## 工作台

- **今日**：需要处理的 Action、Agent 收尾、Routine 和日程
- **任务**：派发、旁观、追问、审批、接管和引擎接力
- **对话**：普通 Chat，可在已有对话中更换 Provider
- **通知流**：外部事件的分流结果
- **笔记**：浏览和编辑 Markdown vault
- **系统**：事件源、定时任务、日志与运行状态

GitHub、飞书、Gmail 和股票等事件源默认关闭。不开外部账号，也可以使用任务派发、会话收割、项目记录、Action、Heartbeat、笔记和 macOS 通知。

## 配置与安全

Ownward 使用两层配置：仓库里的 `config.default.json` 保存默认值，本机的 `config.json` 只写覆盖项且不会进入 Git。常用行为还可以通过以下文件调整：

- `prompts/owner.md`：哪些人和事情重要，以及表达偏好；
- `prompts/heartbeat.md`：主动检查清单；
- `data/routines.json`：周期职责。

修改配置后运行 `bash install.sh`，让 Runner 与 daemon 一起切换到同一份配置快照。完整配置说明见 [配置指南](docs/configuration.md)。

存储和控制面在本地，不代表模型也在本地运行。发给 Provider 的内容受相应服务条款约束；Agent 可能以当前用户权限执行命令和修改文件。不要把 `config.json`、`prompts/owner.md`、`data/`、vault、凭据或原始会话提交到 Git。

Dashboard 默认带 Host / Origin 校验。安全边界和报告方式见 [SECURITY.md](SECURITY.md)。

## 架构与开发

Ownward 是 Bun / TypeScript daemon，内嵌一个无构建步骤的静态 Web 工作台，运行时零 npm 依赖。Provider 任务由独立 Runner 执行；daemon 更新或重启时，Runner 会先安全 drain，不会把活跃任务直接当成成功。

完整架构见 [docs/architecture-v1.md](docs/architecture-v1.md)，修改守则与已知陷阱见 [开发指南](docs/development.md)。开发前运行：

```bash
bun install --frozen-lockfile
./verify.sh
```

验证门包含构建、TypeScript 类型检查、单元测试、daemon 冒烟、API 探活和 Web JavaScript 解析。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

Ownward 采用 [Apache License 2.0](LICENSE)。

---

**Ownward — your work, carried forward.**
