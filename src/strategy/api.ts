// 策略页 API：/strategy 页面 + /api/strategy/*。挂在 server.ts 的路由链上（workbench 同款模式）。
import { readFileSync } from "fs";
import { join } from "path";
import { ROOT, log } from "../util.ts";
import { Thesis, buildView, loadTheses, refreshSnapshot, saveThesis } from "./engine.ts";
import { runStrategyScan } from "./scan.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export async function handleStrategy(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;

  if (p === "/strategy") {
    return new Response(readFileSync(join(ROOT, "web", "strategy.html")),
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (p === "/api/strategy") return json(buildView());

  if (req.method === "POST" && p === "/api/strategy/refresh") {
    const r = await refreshSnapshot();
    return json({ ...r, view: buildView() });
  }

  if (req.method === "POST" && p === "/api/strategy/scan") {
    // 全持仓扫描要 1-2 分钟：后台跑，页面轮询 meta.scanAt 感知完成
    runStrategyScan().catch((e) => log(`manual scan failed: ${e}`));
    return json({ ok: true, msg: "扫描已启动（1-2 分钟，完成后自动刷新）" });
  }

  if (p === "/api/strategy/thesis") {
    const sym = (url.searchParams.get("symbol") || "").toUpperCase();
    if (!sym) return json({ ok: false, msg: "缺 symbol" }, 400);
    if (req.method === "POST") {
      const body = await req.json() as Partial<Thesis>;
      saveThesis({
        symbol: sym,
        status: (body.status as Thesis["status"]) || "active",
        stop: body.stop != null && body.stop !== ("" as any) ? Number(body.stop) : undefined,
        target: body.target != null && body.target !== ("" as any) ? Number(body.target) : undefined,
        invalidation: body.invalidation || undefined,
        opened: body.opened || undefined,
        body: body.body || "",
      });
      return json({ ok: true, msg: `论点卡已保存：${sym}`, view: buildView() });
    }
    return json({ ok: true, thesis: loadTheses()[sym] || null });
  }

  return null;
}
