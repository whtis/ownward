import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("listen=all remote authentication", () => {
  test("rate-limit keys trust XFF only from an exact loopback peer", async () => {
    const { remoteRateLimitKey } = await import("./server.ts");
    expect(remoteRateLimitKey("127.0.0.1", "198.51.100.1, 203.0.113.2")).toBe("203.0.113.2");
    expect(remoteRateLimitKey("127.0.0.1", "malformed, 198.51.100.1")).toBe("198.51.100.1");
    expect(remoteRateLimitKey("::ffff:127.0.0.1", "2001:db8::1")).toBe("2001:db8::1");
    expect(remoteRateLimitKey("127.0.0.1", "unknown")).toBe("127.0.0.1");
    expect(remoteRateLimitKey("127.0.0.1", "198.51.100.1, malformed")).toBe("127.0.0.1");
    expect(remoteRateLimitKey("198.51.100.8", "203.0.113.9")).toBe("198.51.100.8");
  });

  test("only a genuine local direct request bypasses token authentication", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ownward-remote-auth-"));
    const script = `
      import { readFileSync } from "fs";
      import { join } from "path";
      import { cfg } from ${JSON.stringify(join(import.meta.dir, "util.ts"))};
      const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = reservation.port;
      reservation.stop(true);
      cfg.dashboard = { ...(cfg.dashboard || {}), port, listen: "all" };
      cfg.verticals = { ...(cfg.verticals || {}), dev: { enabled: false }, strategy: { enabled: false }, externalPaths: [] };
      const { startServer } = await import(${JSON.stringify(join(import.meta.dir, "server.ts"))});
      const server = startServer(), base = "http://127.0.0.1:" + server.port;
      const token = readFileSync(join(process.env.OWNWARD_DATA_ROOT, "secrets/api-token.txt"), "utf8").trim();
      const call = async (headers = {}, path = "/api/state", method = "GET") => (await fetch(base + path, { headers, method })).status;
      const proxyHeaders = [
        { forwarded: "for=203.0.113.9" },
        { "x-forwarded-for": "203.0.113.9" },
        { "x-forwarded-host": "remote.example" },
        { "x-forwarded-proto": "https" },
        { "x-real-ip": "203.0.113.9" },
      ];
      const forcedAuth = [];
      for (const headers of proxyHeaders) forcedAuth.push(await call(headers));
      for (let i = 0; i < 40; i++) await call({ "x-forwarded-for": "malformed, 198.51.100.1", authorization: "Bearer wrong" });
      const result = {
        local: await call(),
        localBadOrigin: await call({ origin: "https://attacker.example" }, "/api/system/verticals/reload", "POST"),
        localGoodOrigin: await call({ origin: "http://127.0.0.1:" + server.port }, "/api/system/verticals/reload", "POST"),
        localNoOrigin: await call({}, "/api/system/verticals/reload", "POST"),
        rebound: await call({ host: "attacker.example" }),
        reboundAuthed: await call({ host: "attacker.example", authorization: "Bearer " + token }),
        proxied: await call({ "x-forwarded-for": "203.0.113.9" }),
        proxiedAuthed: await call({ "x-forwarded-for": "203.0.113.9", authorization: "Bearer " + token }),
        blockedClient: await call({ "x-forwarded-for": "malformed, 198.51.100.1" }),
        otherClientBare: await call({ "x-forwarded-for": "198.51.100.2" }),
        otherClientAuthed: await call({ "x-forwarded-for": "198.51.100.2", authorization: "Bearer " + token }),
        forcedAuth,
      };
      server.stop(true);
      console.log(JSON.stringify(result));
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, OWNWARD_DATA_ROOT: dataRoot }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    try {
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
        local: 200,
        localBadOrigin: 403,
        localGoodOrigin: 400,
        localNoOrigin: 400,
        rebound: 401,
        reboundAuthed: 200,
        proxied: 401,
        proxiedAuthed: 200,
        blockedClient: 429,
        otherClientBare: 401,
        otherClientAuthed: 200,
        forcedAuth: [401, 401, 401, 401, 401],
      });
      expect(readFileSync(join(dataRoot, "secrets/api-token.txt"), "utf8").trim()).not.toBe("");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
