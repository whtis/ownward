import { RunnerServer } from "../server.ts";
import { FakeRunnerProvider } from "./fake-runtime.ts";
import { resolve } from "path";

if (process.env.NODE_ENV !== "test" || process.env.OWNWARD_RUNNER_ALLOW_FAKE !== "1" || process.env.OWNWARD_RUNNER_TEST_ROOT !== "1" || !process.env.OWNWARD_DATA_ROOT) throw new Error("Fake Runner entry 需要显式 test 三门与独立 data root");
const fake = new FakeRunnerProvider(), server = new RunnerServer(resolve(process.env.OWNWARD_DATA_ROOT), (providerId) => {
  if (providerId !== "fake") throw new Error(`Provider 未注册: ${providerId}`); return fake;
});
server.start(); let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { if (shuttingDown) return; shuttingDown = true; void server.shutdown(1_000).finally(() => process.exit(0)); });
