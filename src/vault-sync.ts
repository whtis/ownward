// vault git 同步：ownward 接管 vault 的 commit+push。
// 所有自动写入方（收割/日报/memory/routine）写完靠这里定期兜底同步到远端，
// 另一台机器随时能 pull。失败静默重试（离线常态），不阻塞任何业务。
// 前提：vault.autoSync 打开，且 vault root 本身是个配好远端的 git 仓库。
import { VAULT_ROOT } from "./paths.ts";
import { cfg, log, run } from "./util.ts";

const VAULT = VAULT_ROOT;
let syncing = false;
let warnedConflict = false;  // 冲突提醒只发一次，解决前每 30min 重复轰炸没意义

export async function syncVault(reason = "auto"): Promise<void> {
  if (!cfg.vault?.autoSync) return;
  if (syncing) return;
  syncing = true;
  try {
    const status = await run(["git", "-C", VAULT, "status", "--porcelain"], { timeoutMs: 15_000 });
    const lines = status.stdout.split("\n").filter(Boolean);
    // rebase --abort 后 autostash 回放仍可能留下冲突标记——有 unmerged 路径时绝不 add -A
    // 自动提交（会把 <<<<<<< 当正常内容推到远端），停下等人
    if (lines.some((l) => /^(U.|.U|AA|DD)/.test(l))) {
      log("vault-sync: 工作区有未解决的合并冲突，跳过自动提交，等人工处理");
      if (!warnedConflict) {
        warnedConflict = true;
        const { notify } = await import("./notify.ts");
        notify("⚠️ vault 工作区有未解决的合并冲突，自动同步已暂停，需要手动处理", { source: "system" }).catch(() => {});
      }
      return;
    }
    warnedConflict = false;
    const dirty = lines.length;
    if (dirty > 0) {
      // 大 vault 的 add 实测可到 15s+（fs 扫描），余量给足
      const a = await run(["git", "-C", VAULT, "add", "-A"], { timeoutMs: 120_000 });
      if (a.code !== 0) { log(`vault-sync add failed: ${a.stderr.slice(0, 120)}`); return; }
      const c = await run(["git", "-C", VAULT, "commit", "-m", `ownward: 自动同步 ${dirty} 处变更 (${reason})`], { timeoutMs: 60_000 });
      if (c.code !== 0) { log(`vault-sync commit failed: ${c.stderr.slice(0, 120)}`); return; }
      log(`vault-sync: committed ${dirty} change(s)`);
    }
    // 有本地领先就推（含之前离线攒下的）；远端可能有另一台机器的提交，先 rebase 再推
    const ahead = await run(["git", "-C", VAULT, "rev-list", "--count", "@{upstream}..HEAD"], { timeoutMs: 15_000 });
    if (ahead.code === 0 && parseInt(ahead.stdout.trim(), 10) > 0) {
      const r = await run(["git", "-C", VAULT, "pull", "--rebase", "--autostash"], { timeoutMs: 60_000 });
      if (r.code !== 0) {
        // 冲突要人来（两台机器改同一处），中止 rebase 保持本地完好
        await run(["git", "-C", VAULT, "rebase", "--abort"], { timeoutMs: 15_000 });
        log(`vault-sync: rebase 冲突，需要人工处理: ${r.stderr.slice(0, 120)}`);
        const { notify } = await import("./notify.ts");
        notify("⚠️ vault 与另一台机器有冲突，需要手动 git pull 解决", { source: "system" }).catch(() => {});
        return;
      }
      const p = await run(["git", "-C", VAULT, "push"], { timeoutMs: 300_000 }); // 首推/攒多了会慢
      if (p.code === 0) log("vault-sync: pushed");
      else log(`vault-sync push failed (离线?): ${p.stderr.slice(0, 100)}`);
    }
  } catch (e) {
    log(`vault-sync error: ${e}`);
  } finally {
    syncing = false;
  }
}
