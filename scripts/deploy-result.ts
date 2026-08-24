import { DATA } from "../src/util.ts";
import { reconcileEvolveReceipts, writeEvolveDeployReceipt } from "../src/evolve-release.ts";
const [id,attemptId,buildIdentity,result,diagnostic]=process.argv.slice(2);
if(!id||!attemptId||!/^[a-f0-9]{64}$/.test(buildIdentity)||!['applied','failed'].includes(result))throw new Error("deploy-result args invalid");
writeEvolveDeployReceipt(DATA,id,attemptId,buildIdentity,result as "applied"|"failed",diagnostic);
reconcileEvolveReceipts(DATA);
