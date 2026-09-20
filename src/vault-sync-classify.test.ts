import { describe, expect, test } from "bun:test";
import { isTransportFailure } from "./vault-sync.ts";

describe("vault 同步失败分类", () => {
  test("够不着远端的一律静默重试——这些是 2026-09 实际告警里的原文", () => {
    for (const err of [
      "ssh: connect to host ssh.github.com port 443: Undefined error: 0",
      "Connection closed by 198.18.0.21 port 443",
      "Connection closed by 127.0.0.1 port 7897",
      "fatal: Could not read from remote repository.",
      "ssh: Could not resolve hostname github.com: nodename nor servname provided",
      "fatal: unable to access 'https://github.com/x.git': Failed to connect",
      "error: RPC failed; curl 56 recv failure",
      "fatal: the remote end hung up unexpectedly",
    ]) expect(isTransportFailure(1, err)).toBe(true);
    expect(isTransportFailure(124, "")).toBe(true);  // run() 的超时标记
  });

  test("真冲突仍然喊人", () => {
    expect(isTransportFailure(1, "CONFLICT (content): Merge conflict in work/inbox/2026-09-20.md")).toBe(false);
    expect(isTransportFailure(1, "error: could not apply 0bc19f1... ownward: 自动同步")).toBe(false);
  });
});
