# Ownward iOS

iPhone 端（iOS 26+，SwiftUI + Liquid Glass），与 `android/` 同一套 daemon API、同一套色板与交互语法：
收件箱（审批/回答/行动卡）、Agent 会话续聊（连续工具调用折叠、排队消息可撤回、斜杠命令补全、接管租约）、
派新任务、旁观并接管本机 Claude/Codex 会话、AI 对话（流式）、侧边栏一步切会话。零第三方依赖。

## 构建

```bash
brew install xcodegen          # 一次性
cd ios && ./build.sh           # 生成 Ownward.xcodeproj + 模拟器 Debug 构建
./build.sh --test              # 单元测试（Markdown 解析 / NDJSON / 默认值解码 …）
./build.sh --run               # 装到 iPhone 17 Pro 模拟器并启动（模拟器直连 http://127.0.0.1:4517 或 dev 的 4519）
./build.sh --open              # 用 Xcode 打开（真机：先 cp Signing.xcconfig.example Signing.xcconfig 填 Team ID）
```

`Ownward.xcodeproj` 由 `project.yml` 生成、不进 git；改文件列表/版本号只改 `project.yml`。

## 版本

- `MARKETING_VERSION`（CFBundleShortVersionString）只能纯数字点分（App Store 校验），渠道+日期放
  `OwnwardVersionName`（如 `0.1.0-alpha.20260821`）；`CURRENT_PROJECT_VERSION` = build `YYYYMMDDN`。
- 发布后在 daemon 机器上跑 `scripts/ios-release.sh "说明" "<TestFlight 链接>"`，写 `data/app/ios.json`，
  手机端设置页「检查更新」比对 build 号。

## 结构

```
Ownward/App        入口 + 三 tab 壳（每 tab 一条 NavigationStack；返回有触感）+ 侧边栏路由
Ownward/Core       Models（@Defaulted 缺省解码）/ OwnwardClient（Bearer、NDJSON 流）/ Keychain 配置 /
                   轮询 / 触感 / 图片编码 / SessionLists（本机会话归并口径）
Ownward/UI         色板排版 / Markdown 解析+渲染 / 打字机流式文本 / 玻璃 composer / 权限卡 /
                   Feed（工具调用折叠规则）/ Slash（斜杠补全规则）/ Sidebar（抽屉）
Ownward/Features   Setup / Inbox / Agent(列表+会话详情+派任务+旁观接管) / Chat(列表+对话) / Settings
OwnwardTests       Swift Testing 单测
```

纯逻辑单独成文件（`Feed.swift` / `Slash.swift` / `SessionLists.swift`）是刻意的：这三处是
**三端必须同口径**的规则（web / android / ios），各写各的迟早漂成三种行为，所以都不碰 SwiftUI，
且有与 android 逐条配对的单测。

## 调试直达（DEBUG only，截图/自动化用；Release 不编译）

```bash
xcrun simctl launch <dev> ai.ownward.app \
  -ownward.baseURL http://127.0.0.1:4519 \   # 免去手填设置页
  -ownward.debugTab agent \                  # inbox | agent | chat
  -ownward.debugRoute "task:<id>" \          # settings | newchat | dispatch | chat:<id> | task:<id> | observe:<ccId>
  -ownward.debugDrawer 1 \                   # 开着侧边栏启动（抽屉没有 URL 入口）
  -ownward.debugInput "/c"                   # 预填会话输入框（模拟器没法脚本化打字）
```

## 与 Android 的差异点

- 聊天 delta 走自适应打字机（落后越多越快），codex 一次整段也能连续吐字；Android 是整段跳变。
- 触感：发送/返回/完成/新待决/错误；Android 无。
- 更新检查读 `/api/app/ios`（Android 是 `/api/app/android` + APK 自更新）；iOS 只能跳转安装页。
- **抽屉只能点 ☰ 拉出，不做左滑边缘手势**：左边缘是系统返回手势的地盘，抢过来会把 NavigationStack
  的滑动返回废掉。详情页的 ☰ 挨在系统返回键右边（Android 是拿 ☰ 替掉返回键，iOS 那颗得留着跟滑动返回配对）。
- **列表搜索走原生 `.searchable`**（下拉露出搜索栏），Android 是点顶栏放大镜原位替换标题；
  抽屉里没有 NavigationStack，仍用自绘的 `SearchField` 药丸。过滤口径三处共用 `searchHit`，
  同一个关键字结果一致——统一的是口径，不是呈现。
- 长按复制走 `.contextMenu`（iOS 标准长按菜单），Android 是 `combinedClickable` + 震动 + Toast。
- 撤回排队消息失败时用自绘的 Toast 浮条，Android 用 Snackbar；两边都不能挂在错误横幅上——
  会话页 2.5s 一轮轮询，refresh 成功就把 error 清空，挂上去的提示活不过一次轮询。

## 踩过的坑

- ⚠️ **Swift 的 `"abc".contains("")` 返回 `false`**（走 `range(of:)`），而 Kotlin 的 `contains`、
  JS 的 `includes` 都返回 `true`。斜杠补全照抄那两端的写法，结果是「打完 `/` 一条候选都不弹」。
  `Slash.matches` 里显式挡了空查询，`SlashTests` 有用例钉着。
- `/api/cc/session` 的成功体**不带 `ok` 键**（只有失败时才写 `ok:false`）。Swift 的 `@Defaulted var ok: Bool`
  会落 `false`，于是每一页都被判成读取失败、旁观页永远空白。`CcPage` 用 `Bool?` + `isOK { ok ?? true }`。
