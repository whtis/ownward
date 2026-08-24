import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cleanMessage, coreLog, emitCoreLog } from "./contracts.ts";

describe("core observability log contract", () => {
  test("core event has stable correlation fields and cannot carry secret payload keys", () => {
    const row = coreLog({ event: "provider-failed", moduleType: "provider", moduleId: "claude", operation: "execute", taskId: "task-1", runId: "run-1", sessionId: "session-1", eventId: "event-1", errorClass: "PROVIDER_BUSY" });
    expect(row).toEqual({ event: "provider-failed", moduleType: "provider", moduleId: "claude", operation: "execute", taskId: "task-1", runId: "run-1", sessionId: "session-1", eventId: "event-1", msg: "", errorClass: "PROVIDER_BUSY" });
  });

  test("unsafe correlations null and human message is redacted", () => {
    let line = "";
    emitCoreLog({ event: "x", moduleType: "connector", moduleId: "gmail", operation: "publish", eventId: "Bearer private value", msg: "token=private /Users/example/private/file" }, (value) => line = value);
    const row = JSON.parse(line);
    expect(row.eventId).toBeNull();
    expect(row.msg).toBe("token=[REDACTED]");
  });

  test("redaction corpus covers case, separators, nested objects and JSON strings", () => {
    const secrets = ["tok-A", "sec-B", "pw-C", "auth-D", "cookie-E", "key-F", "refresh-G", "private-H"];
    const values: unknown[] = [
      { access_token: secrets[0], nested: { CLIENT_SECRET: secrets[1], Password: secrets[2] }, rows: [{ Authorization: secrets[3] }, { cookie: secrets[4] }, { api_key: secrets[5] }] },
      JSON.stringify({ ACCESS_TOKEN: secrets[0], client_secret: secrets[1], nested: { password: secrets[2] } }),
      `Authorization: Bearer ${secrets[3]} cookie=${secrets[4]} API-KEY=${secrets[5]}`,
      `access-token=${secrets[0]}; client_secret:'${secrets[1]}' password=${secrets[2]}`,
      `PASSWORD=multi word ${secrets[2]} value\nnext=safe`,
      { API_KEY: secrets[5], bigint: 1n },
      { "Refresh Token": secrets[6], nested: { private_key: secrets[7] } },
      JSON.stringify({ refreshToken: secrets[6], "PRIVATE-KEY": secrets[7] }),
      `refresh_token : ${secrets[6]}\nprivate key = '${secrets[7]}'`,
      `Authorization: Bearer AbCdEf0123-._~+/==`,
      `private_key: -----BEGIN PRIVATE KEY-----\n${secrets[7]}\n-----END PRIVATE KEY-----`,
    ];
    for (const value of values) {
      const cleaned = cleanMessage(value);
      expect(cleaned.length).toBeLessThanOrEqual(500);
      for (const secret of secrets) expect(cleaned).not.toContain(secret);
      expect(cleaned).toContain("[REDACTED]");
    }
  });

  test("secret key token and suffix matching covers vendor-specific spellings", () => {
    const secrets = ["auth-A", "session-B", "github-C", "id-D", "vendor-E", "api-F", "credential-G"];
    const nested = {
      authToken: secrets[0],
      nested: { session_token: secrets[1], github_token: secrets[2], id_token: secrets[3] },
      integrations: [{ vendorKey: secrets[4] }, { vendor_api_key: secrets[5] }, { vendorCredential: secrets[6] }],
      safeMonkey: "visible",
    };
    const plain = `authToken=${secrets[0]}; session_token=${secrets[1]}; github_token=${secrets[2]}; id_token=${secrets[3]}\nvendorKey=${secrets[4]}\nvendor_api_key=${secrets[5]}\nvendorCredential=${secrets[6]}`;
    for (const value of [nested, JSON.stringify(nested), plain]) {
      const cleaned = cleanMessage(value);
      for (const secret of secrets) expect(cleaned).not.toContain(secret);
      if (value !== plain) expect(cleaned).toContain("visible");
    }
  });

  test("Authorization and Bearer redact the complete non-token68 value", () => {
    const corpus = [
      "Authorization: Basic abc:def with spaces",
      "authorization = Bearer abc:def / non token68 value",
      "Bearer abc:def with spaces and symbols !@#$%^*()",
      "prefix Bearer vendor credential: abc def",
      JSON.stringify({ Authorization: "Custom abc:def with spaces", note: "safe" }),
      { authorization: "Custom abc:def with spaces", nested: { authToken: "abc:def with spaces" }, note: "safe" },
    ];
    for (const value of corpus) {
      const cleaned = cleanMessage(value);
      expect(cleaned).not.toContain("abc:def");
      expect(cleaned).not.toContain("with spaces");
      expect(cleaned).toContain("[REDACTED]");
    }
  });

  test("message length is bounded after recursive sanitization", () => {
    const secret = "never-visible";
    const cleaned = cleanMessage({ note: "x".repeat(1_000), access_token: secret });
    expect(cleaned).toHaveLength(500);
    expect(cleaned).not.toContain(secret);
  });

  test("Runner critical paths do not regress to ad-hoc console JSON logs", () => {
    const root = resolve(import.meta.dir, "../../runner"), providerRoot = resolve(import.meta.dir, "../../providers");
    for (const file of [resolve(root, "server.ts"), resolve(root, "entry.ts"), resolve(providerRoot, "codex/adapter.ts"), resolve(providerRoot, "claude-code/adapter.ts")]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/console\.(?:error|warn)\(JSON\.stringify\(\{\s*event:/);
    }
    const server = readFileSync(resolve(root, "server.ts"), "utf8");
    for (const event of ["runner-observational-event-dropped", "runner-provider-abort-failed", "runner-terminal-append-failed", "runner-shutdown-terminal-failed", "runner-command-execution-unrecoverable"]) expect(server).toMatch(new RegExp(`event\\s*:\\s*"${event}"`));
  });

  test("extension critical lifecycle paths use the fixed structured envelope", () => {
    const files = [resolve(import.meta.dir, "../extensions/runtime.ts"), resolve(import.meta.dir, "../connectors/runtime.ts")];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/this\.log\(/);
    for (const event of [
      "vertical-discovered", "vertical-discovery-failed", "vertical-starting", "vertical-host-started", "vertical-host-exited", "vertical-migration-started", "vertical-migration-completed", "vertical-ready", "vertical-scheduler-failed", "vertical-stopped",
      "connector-discovered", "connector-discovery-failed", "connector-starting", "connector-host-started", "connector-host-exited", "connector-migration-started", "connector-migration-completed", "connector-ready", "connector-delivery-deferred", "connector-delivery-appended", "connector-delivery-dropped", "connector-journal-corrupt", "connector-recovery-completed", "connector-stopped",
    ]) expect(source).toContain(`"${event}"`);
  });
});
