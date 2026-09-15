# App 通用约定（移动端 / 桌面端）

Ownward 的 iOS、Android（以及以后任何客户端）都遵守这份约定。它从作者的全局开发规范
（`~/.claude/rules/dev-guidelines.md` 第 1 节）搬进仓库，成为项目内的硬要求：
改客户端时先对照这里，公开仓库导出时**不得**改写其中的署名与链接。

## 1. 版本与构建号

- 版本号与根目录 `package.json` 的 `version` 一致（见 `docs/public-maintenance.md`「Version parity」）。
  三通道格式：Alpha `X.Y.Z-alpha.YYYYMMDD`、Beta `X.Y.Z-beta.YYYYMMDD`、Stable `X.Y.Z`；
  发布流程 Alpha → Beta → Stable，Stable 必须有对应的 beta tag。
- 构建号 `YYYYMMDDN`：当天日期 + 当日递增序号（从 1 开始），纯整数、无点号，每次发布 +1。
  - Android：`versionCode`；iOS：`CFBundleVersion` / `CURRENT_PROJECT_VERSION`。
  - iOS 的 `MARKETING_VERSION` 只能纯数字点分（App Store 校验），带渠道的版本串放 `OwnwardVersionName`。
- 不要用 semver 的 `+build` 元数据表示构建：比较时被忽略，更新器分不出两个构建。
- **只有用户明确要求才动 X.Y.Z**；发布只递增构建号。bugfix → patch，新功能 → minor，大版本 → major。

## 2. 检查更新

设置页「关于」必须有「检查更新」入口：

- 拉最新版本信息（版本串 + 构建号）：Android 先读公开 Pages 的 `android.json`，daemon 的
  `/api/app/android` 作离线 / 局域网兜底；iOS 读 daemon 的 `/api/app/ios`。
- 服务端构建号 > 本地构建号 → 有更新。弹窗：当前版本/构建 → 新版本/构建，可选发布说明，
  按钮「以后再说」+「立即更新」；带 `force_update` 时隐藏「以后再说」。
- 「立即更新」：Android 下载 APK 后拉起安装；iOS 打开下载页（TestFlight / 分发链接）。
- 发现更新但用户按了「以后再说」：设置入口显示红点（Android `App.updateAvailable`，
  iOS `AppSettings.updateAvailable`），装上新版或再查确认已是最新才清除。
- 「检查更新」行的副标题写更新状态（检查中 / 可更新至 x.y.z / 提示语），**不要重复当前版本号**——
  当前版本只在页脚出现一次。检查结果就近显示在「关于」区，不要混进服务器配置的保存提示。

## 3. 署名与链接

设置页底部居中两行（`FutureBuilder`/`Bundle` 读版本，别写死）：

1. `{AppName} v{version} ({buildNumber})` — 小号次要色
2. `© {year} Tis Wu · Apache-2.0` — 同字号，60% 不透明度

两行间距 4，页脚下方留 16。Ownward 以 Apache-2.0 开源，所以第二行写许可证而不是
"All rights reserved"；作者署名 **Tis Wu** 是要求，公开仓库导出不得替换成 "contributors"。

「关于」区还要有两条外链，整行可点：

- 源代码：`https://github.com/whtis/ownward`（副标题 `github.com/whtis/ownward · Apache-2.0`）
- 项目主页：`https://whtis.github.io/ownward/`

## 4. SwiftUI 数字插值陷阱

`Text("\(intValue)")` 会按 locale 加千位分隔符（`LocalizedStringKey` 插值）：年份 `2026` 显示成
`2,026`，构建号 `20260309` 显示成 `20,260,309`。凡是进 `Text` 的数字都用 `String()` 包一层：
`Text("© \(String(year)) Tis Wu")`。`print()` 和普通字符串插值不受影响。
