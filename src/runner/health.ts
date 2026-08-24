import { RunnerClient } from "./client.ts";
import { resolve } from "path";
import { parseRunnerHealth } from "./health-contract.ts";

let client: RunnerClient | undefined;
try {
  client = new RunnerClient(resolve(process.env.OWNWARD_DATA_ROOT || "data"), 2_000);
  const control = process.argv.includes("--quiesce") || process.argv.includes("--quiesce-control-only") ? "quiesce" : process.argv.includes("--resume") || process.argv.includes("--resume-control-only") ? "resume" : undefined;
  if (control) await client.request(control, {});
  if (process.argv.includes("--quiesce-control-only") || process.argv.includes("--resume-control-only")) console.log(JSON.stringify({ ok: true, control }));
  else { const reply = await client.request("ping", {}),raw={ ok: true, ...reply.body };const expected=process.argv.includes("--expected-build")?process.argv[process.argv.indexOf("--expected-build")+1]:undefined,required=process.argv.flatMap((arg,index)=>arg==="--required-provider"?[process.argv[index+1]!]:[]);parseRunnerHealth(raw,{expectedBuild:expected,requiredProviders:required});console.log(JSON.stringify(raw)); }
}
catch (error: any) { console.error(JSON.stringify({ ok: false, errorCode: error?.code || "RUNNER_UNAVAILABLE", error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
finally { client?.close(); }
