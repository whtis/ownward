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

## 同一底座，也能承载其他专业工作台

研发工作台是 Ownward 内置的 `dev` Vertical。它下面的 Kernel、独立 Runner、Provider 适配器，以及事实和权限层，并不依赖“写代码”这个具体场景。

完整 Vertical 契约定义了 sessions、tasks、actions、storage、scheduler、llm、sources 等受控 capability，内置 Vertical 可以按声明获得。当前 external Host 开放的是 storage、actions、scheduler、llm 和 sources；sessions、tasks 仍会被 Host 可用性闸明确拒绝。外部 Vertical 还可以挂载自己的 API 路由、页面和导航，并通过独立 Host 进程获得崩溃隔离和开发时热重载。

实际 Desk 扩展面向猎头顾问，把招聘领域档案、推荐流程和待办放在同一底座上，复用 Ownward 的引擎链、Action、调度、storage 和 sources；完整领域实现不在本仓库。公开的 [只读 Vertical 示例](examples/verticals/sample-readonly) 只用 scoped storage 展示脱敏候选人列表，用于验证 Host、路由、页面和授权边界。

同样的方式可以用于其他需要个人适配的工作台。外部 Vertical 必须是用户明确启用的 trusted 本地代码；独立进程用于隔离崩溃和生命周期，不是抵御恶意代码的安全沙箱。扩展契约和开发守则见 [开发指南](docs/development.md)。

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

## 附录：让手机从外网连接 Ownward

先在 `config.json` 开启远程监听，再重新安装：

```json
{
  "dashboard": { "listen": "all" }
}
```

```bash
bash install.sh
```

这会让 Ownward 监听 `0.0.0.0:4517`，并启用远程令牌鉴权。用防火墙或路由器挡住公网对 4517 的直接访问，只开放下面的 HTTPS 入口。首次从手机打开时，页面会要求访问令牌，令牌在 `data/secrets/api-token.txt`。

### Nginx

先为域名配置有效的 TLS 证书，再加入以下站点配置：

```nginx
server {
    listen 443 ssl;
    server_name ownward.example.com;

    # 首次登录会用查询参数交换令牌，不要把完整请求写进 access log。
    access_log off;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4517;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

重载 Nginx 后，在手机访问 `https://ownward.example.com`。`X-Forwarded-For` 会让 Ownward 按远程请求执行令牌鉴权，`X-Forwarded-Proto: https` 则让登录 cookie 带上 `Secure`。

### Cloudflare Tunnel

Cloudflare Tunnel 不需要在路由器上开放入站端口。安装 `cloudflared` 并准备一个已接入 Cloudflare 的域名后执行：

```bash
cloudflared tunnel login
cloudflared tunnel create ownward
cloudflared tunnel route dns ownward ownward.example.com
```

在 `~/.cloudflared/config.yml` 写入创建命令返回的 Tunnel UUID 和凭据文件路径：

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/you/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: ownward.example.com
    service: http://127.0.0.1:4517
  - service: http_status:404
```

启动并验证：

```bash
cloudflared tunnel run ownward
```

确认手机可以访问后，再按 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)将 Tunnel 注册为 macOS 常驻服务。

首次登录会短暂使用带令牌的查询参数，再换成 HttpOnly cookie。不要记录查询字符串，也不要复制或截图这段登录地址；Cloudflare 日志、监控和分析工具也应排除查询参数。如果令牌可能已经泄漏，删除 `data/secrets/api-token.txt` 后重新运行 `bash install.sh`，让所有客户端重新登录。

主要通过浏览器使用时，可以再启用 Cloudflare Access。原生 Android / iOS 客户端接入前，需要确认其鉴权方式与 Access 策略兼容。无论是否启用 Access，Ownward 自己的访问令牌都应保留。Nginx 配置项可查阅其[反向代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

---

**Ownward — your work, carried forward.**
