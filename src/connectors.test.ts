import { describe, expect, test } from "bun:test";
import { startConnectorServices } from "./connectors.ts";

describe("connector startup barrier", () => {
  test("historical recovery completes before live sources can publish", async () => {
    const projections: string[] = [];
    await startConnectorServices(
      { start: async () => { projections.push("live:github.snapshot"); } },
      { recover: async () => { projections.push("recovery:github.review"); } },
    );
    expect(projections).toEqual(["recovery:github.review", "live:github.snapshot"]);
  });
  test("real background recovery gate is installed before runtime starts",async()=>{const order:string[]=[];await startConnectorServices({start:()=>{order.push("runtime");}},{startRecovery:()=>{order.push("gate");},recover:async()=>{throw new Error("fallback must not run");}});expect(order).toEqual(["gate","runtime"]);});
});
