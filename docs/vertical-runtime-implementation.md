# Vertical + Extension Runtime 实施台阶

本台阶实现架构 v1 阶段 3/4 的最小闭环，不迁移数据目录、不改变既有 API/SSE，也不加载任意扫描目录。

## 边界

- Kernel runtime 只发现内置注册项和 `verticals.externalPaths` 中用户明确配置的绝对目录。
- 外部目录发现后默认不执行；只有 `verticals.<id>.enabled: true` 与 `trusted: true` 同时存在才启动独立 Host。`trusted` 表示用户确认运行本地代码，不是代码签名或安全审计。
- 外部目录以 `ownward.vertical.json` 为真相；严格校验字段、`kernelApiVersion=1`、id、版本、entry、路由、导航、资源和声明能力。
- 加载前递归扫描 extension 源码 import。禁止引用 Runner、Provider、Kernel 私有实现、`paths.ts`、`util.ts`、`actions.ts`、`dispatch.ts` 或相对路径逃出扩展根。
- 内置 Vertical 只能得到 Kernel 构造的 `VerticalContext`。dev 的 Task/Session roots 是 Kernel grant 的闭包，Task 输入逐字段校验、cwd/extraDir 以 realpath 复核，permission 固定为 safe，调用者无法请求 full access/bypass。
- 外部 Vertical 在独立子进程 Host 中运行，经 capability-authenticated framed Unix IPC 请求 Kernel API。这个边界隔离崩溃、超时和 Kernel 对象，grant 是 API contract；v1 不提供 OS sandbox，同一用户的本地代码仍可能自行访问该用户可读文件，因此不支持运行不受信代码（`untrustedUnsupported: true`）。
- 外部 Host v1 只开放 async ScopedStorage RPC；Task、Session、Scheduler、Vault 即使写进 manifest 也会 fail closed 为 `VERTICAL_CAPABILITY_UNAVAILABLE`，等各自 RPC schema 与撤销语义完成后再逐项开放。Host 永远拿不到 Kernel 对象或 Kernel data path。
- API 只允许 `/api/verticals/<id>/...`，资产只允许 `/verticals/<id>/...`。旧 dev/strategy URL 由内置兼容别名转发，外部扩展不能声明别名。
- 外部 route/activate 超时会撤销 capability 并终止整个 Host 进程组；连续失败指数退避，三次后熔断。health 是独立诊断来源，不累计 route breaker。内置 Promise timeout 仍只提前返回，不宣称取消代码。显式 disabled/trusted 配置跨重启保留，crash 计数只属于当前 daemon 世代。
- 外部 route 只返回有界 JSON；静态资产由 Host 校验 realpath/逐段 symlink 后读取，Kernel 再做大小与 MIME allowlist，危险类型降为 attachment，并附 `nosniff` 与拒绝执行的 CSP。

## 首批 Vertical

- `dev`：声明工作派发 command 与工作台路由的所有权；新的 namespaced route 只通过 scoped Task Service 工作。`/api/work` 本台阶仍保留原兼容入口，不移动 Provider/Runner 代码，待本机 roots 配置完成后再切成薄转发。
- `strategy`：通过 runtime 挂载现有 strategy 页面/API，调度由 ScopedScheduler 承载，不再在 Vertical 内自行注册 interval。

## 验证

Contract tests 覆盖合法 fixture、坏 manifest、未来 kernel API、越权 import、activate throw/timeout、route throw/timeout、禁用、路径越界、重启恢复、命名空间覆盖和 scoped storage。完整验证再运行 `tsc --noEmit`、diff check 与项目 `verify.sh`。

Task/Run/Session 仍是 Kernel 原语，不伪装成领域插件；`dev` 是它们的首个 first-party scoped consumer。外部 manifest 的 capability、cwd root 和 Vault scope 都只是申请：先经过本机 grant，再经过当前 Host API 可用性闸，任何一层不满足都不会注入。

外部扩展示例配置：`{"verticals":{"externalPaths":["/absolute/path"],"journal":{"enabled":true,"trusted":true,"grantedCapabilities":["storage"]}}}`。`trusted` 是运行本地代码的显式确认，不代表“安全扩展”。
