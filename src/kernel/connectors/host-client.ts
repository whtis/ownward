import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";
import {
  encodeHostFrame,
  HostFrameDecoder,
  type HostEnvelope,
} from "../extensions/host-protocol.ts";
import type { ConnectorContext, ConnectorManifest } from "./contracts.ts";
import type { ScopedStorage } from "../extensions/contracts.ts";
type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const MAX_OUTGOING_BYTES = 2 * 1024 * 1024;
export class ConnectorHostClient {
  private socket?: Bun.Socket<ConnectorHostClient>;
  private proc?: Bun.Subprocess;
  private decoder = new HostFrameDecoder();
  private pending = new Map<string, Pending>();
  private readonly outgoing: Uint8Array[] = [];
  private outgoingOffset = 0;
  private queuedBytes = 0;
  private dir = "";
  private path = "";
  private terminating = false;
  private termination?: Promise<void>;
  private exited = false;
  private cap = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");
  private storage?: ScopedStorage;
  private storageLease = crypto.randomUUID();
  constructor(
    private root: string,
    private manifest: ConnectorManifest,
    private ctx: ConnectorContext,
    private onExit: () => void,
  ) {}
  setStorage(storage: ScopedStorage | undefined) {
    this.storage = storage;
    this.storageLease = crypto.randomUUID();
  }
  async describe(timeout = 3000) {
    return this.request("describe", {}, timeout);
  }
  async migrate(
    config: Record<string, unknown>,
    migrationId: string,
    timeout = 5000,
  ) {
    return this.request(
      "migrate",
      {
        config,
        migrationId,
        grants: { storage: !!this.storage, leaseId: this.storageLease },
      },
      timeout,
    );
  }
  async activate(config: Record<string, unknown>, timeout = 5000) {
    return this.request(
      "activate",
      { id: this.manifest.id, generation: this.ctx.generation, config },
      timeout,
    );
  }
  async launch(timeout = 5000) {
    this.dir = mkdtempSync(
      join(tmpdir(), `ownward-connector-${this.manifest.id}-`),
    );
    chmodSync(this.dir, 0o700);
    this.path = join(this.dir, "host.sock");
    this.proc = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./host-entry.ts", import.meta.url)),
      ],
      {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          LANG: process.env.LANG || "C.UTF-8",
          OWNWARD_CONNECTOR_SOCKET: this.path,
          OWNWARD_CONNECTOR_CAPABILITY: this.cap,
          OWNWARD_CONNECTOR_ENTRY: join(this.root, this.manifest.entry),
        },
      },
    );
    void this.proc.exited.then(() => {
      this.exited = true;
      this.disconnect(
        Object.assign(new Error("host exited"), {
          code: "CONNECTOR_HOST_EXITED",
        }),
      );
      if (this.dir) {
        rmSync(this.dir, { recursive: true, force: true });
        this.dir = "";
      }
      if (!this.terminating) this.onExit();
    });
    const end = Date.now() + timeout;
    let ready = false;
    while (Date.now() < end && !this.exited) {
      // Windows：命名管道没有文件实体可 stat，uid/mode 也无从谈起（getuid 不存在）。
      // 等 host-entry 落下的 .ready 标记；归属由管道名 + capability 握手保证。
      if (process.platform === "win32") {
        if (existsSync(this.path + ".ready")) { ready = true; break; }
        await Bun.sleep(5);
        continue;
      }
      if (existsSync(this.path)) {
        const st = lstatSync(this.path);
        if (!st.isSocket() || st.uid !== process.getuid()) {
          await this.terminate();
          throw Object.assign(new Error("host socket identity invalid"), {
            code: "CONNECTOR_HOST_SOCKET_UNSAFE",
          });
        }
        if ((st.mode & 0o077) === 0) {
          ready = true;
          break;
        }
      }
      await Bun.sleep(5);
    }
    if (!ready) {
      await this.terminate();
      throw Object.assign(
        new Error(
          this.exited ? "host exited during start" : "host start timeout",
        ),
        {
          code: this.exited
            ? "CONNECTOR_HOST_EXITED"
            : "CONNECTOR_HOST_START_TIMEOUT",
        },
      );
    }
    let connected = false,
      lastConnectError: unknown;
    while (Date.now() < end && !this.exited && !connected) {
      try {
        await this.connect();
        connected = !!this.socket;
      } catch (e) {
        lastConnectError = e;
        if (!this.exited) await Bun.sleep(5);
      }
    }
    if (!connected || this.exited) {
      await this.terminate();
      throw Object.assign(
        new Error(
          this.exited
            ? "host exited during connect"
            : String(lastConnectError || "host connect timeout"),
        ),
        {
          code: this.exited
            ? "CONNECTOR_HOST_EXITED"
            : "CONNECTOR_HOST_CONNECT_TIMEOUT",
        },
      );
    }
  }
  async start(config: Record<string, unknown>, timeout = 5000) {
    await this.launch(timeout);
    return this.activate(config, timeout);
  }
  private async connect() {
    const self = this;
    await Bun.connect<ConnectorHostClient>({
      unix: this.path,
      data: this,
      socket: {
        binaryType: "buffer",
        open(s) {
          self.socket = s;
        },
        data(_s, b) {
          let frames;
          try {
            frames = self.decoder.push(b);
          } catch {
            self.kill();
            return;
          }
          for (const f of frames) void self.receive(f);
        },
        drain(s) {
          if (self.socket === s) self.flush();
        },
        close() {
          self.disconnect(new Error("disconnected"));
        },
        error() {
          self.disconnect(new Error("socket error"));
        },
        connectError() {
          self.disconnect(new Error("connect error"));
        },
      },
    });
  }
  async request(
    method: string,
    body: Record<string, unknown>,
    timeout = 3000,
    killOnTimeout = true,
  ) {
    if (!this.socket)
      throw Object.assign(new Error("host unavailable"), {
        code: "CONNECTOR_HOST_UNAVAILABLE",
      });
    const id = `kernel-${crypto.randomUUID()}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error("host timeout"), {
            code: "CONNECTOR_HOST_TIMEOUT",
          }),
        );
        if (killOnTimeout) this.kill();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({
          version: 1,
          type: "request",
          id,
          capability: this.cap,
          method,
          body,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }
  private async receive(env: HostEnvelope) {
    const a = Buffer.from(env.capability),
      b = Buffer.from(this.cap);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.kill();
      return;
    }
    if (env.type === "response") {
      const p = this.pending.get(env.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(env.id);
      env.ok
        ? p.resolve(env.body)
        : p.reject(
            Object.assign(new Error("host rejected"), { code: env.errorCode }),
          );
      return;
    }
    try {
      let body: any = {};
      if (env.method.startsWith("storage.")) {
        if (env.body.leaseId !== this.storageLease || !this.storage)
          throw Object.assign(new Error("storage lease revoked"), {
            code: "CONNECTOR_CAPABILITY_REVOKED",
          });
        const key = String(env.body.key || "");
        if (!/^[A-Za-z0-9._/-]{1,200}$/.test(key))
          throw Object.assign(new Error("storage key invalid"), {
            code: "CONNECTOR_KERNEL_REQUEST_INVALID",
          });
        if (env.method === "storage.read")
          body = { value: await this.storage.readJson(key) };
        else if (env.method === "storage.write")
          await this.storage.writeJson(key, env.body.value);
        else if (env.method === "storage.remove")
          await this.storage.remove(key);
        else
          throw Object.assign(new Error("storage method denied"), {
            code: "CONNECTOR_KERNEL_METHOD_DENIED",
          });
      } else if (env.method === "checkpoint") {
        if (!this.manifest.capabilities.includes("checkpoint"))
          throw Object.assign(new Error(), {
            code: "CONNECTOR_CAPABILITY_DENIED",
          });
        body = { value: await this.ctx.checkpoint() };
      } else if (env.method === "publish") {
        if (!this.manifest.capabilities.includes("events"))
          throw Object.assign(new Error(), {
            code: "CONNECTOR_CAPABILITY_DENIED",
          });
        body = await this.ctx.publish(
          env.body.events as any[],
          env.body.nextCheckpoint as any,
        );
      } else if (env.method === "secret") {
        if (!this.manifest.capabilities.includes("secrets"))
          throw Object.assign(new Error(), {
            code: "CONNECTOR_CAPABILITY_DENIED",
          });
        body = { value: await this.ctx.secret(String(env.body.ref || "")) };
      } else if (env.method === "report-health") {
        await this.ctx.reportHealth(env.body.report as any);
      } else if (env.method === "log") {
        this.ctx.log(
          String(env.body.operation || ""),
          String(env.body.message || ""),
        );
      } else
        throw Object.assign(new Error(), {
          code: "CONNECTOR_KERNEL_METHOD_DENIED",
        });
      this.reply(env, true, body);
    } catch (e: any) {
      this.reply(env, false, {}, String(e?.code || "CONNECTOR_KERNEL_ERROR"));
    }
  }
  private reply(
    env: HostEnvelope,
    ok: boolean,
    body: Record<string, unknown>,
    errorCode?: string,
  ) {
    try {
      this.send({
        version: 1,
        type: "response",
        id: env.id,
        capability: this.cap,
        method: env.method,
        ok,
        body,
        errorCode,
      });
    } catch {
      this.kill();
    }
  }
  private send(env: HostEnvelope) {
    const frame = encodeHostFrame(env);
    if (this.queuedBytes + frame.byteLength > MAX_OUTGOING_BYTES) {
      const error = Object.assign(
          new Error("Connector Host outgoing queue overflow"),
          { code: "CONNECTOR_HOST_BACKPRESSURE" },
        ),
        socket = this.socket;
      this.disconnect(error);
      socket?.close();
      throw error;
    }
    this.outgoing.push(frame);
    this.queuedBytes += frame.byteLength;
    this.flush();
  }
  private flush() {
    const socket = this.socket;
    if (!socket) return;
    while (this.outgoing.length) {
      const frame = this.outgoing[0]!,
        written = socket.write(
          frame,
          this.outgoingOffset,
          frame.byteLength - this.outgoingOffset,
        );
      if (written < 0) {
        this.disconnect(
          Object.assign(new Error("Connector Host write failed"), {
            code: "CONNECTOR_HOST_WRITE_FAILED",
          }),
        );
        socket.close();
        return;
      }
      if (written === 0) return;
      this.outgoingOffset += written;
      this.queuedBytes -= written;
      if (this.outgoingOffset < frame.byteLength) return;
      this.outgoing.shift();
      this.outgoingOffset = 0;
    }
  }
  async health(timeout = 2000) {
    return this.request("health", {}, timeout, false);
  }
  async stop() {
    if (this.terminating) return this.termination;
    try {
      await this.request("stop", {}, 1000);
    } catch {}
    return this.terminate();
  }
  kill() {
    void this.terminate();
  }
  private terminate() {
    if (this.termination) return this.termination;
    this.terminating = true;
    this.termination = (async () => {
      const proc = this.proc,
        pid = proc?.pid;
      if (pid && !this.exited) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {}
        try {
          proc.kill("SIGTERM");
        } catch {}
        const exited = await Promise.race([
          proc.exited.then(() => true),
          Bun.sleep(500).then(() => false),
        ]);
        if (!exited) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
          try {
            proc.kill("SIGKILL");
          } catch {}
          await Promise.race([proc.exited, Bun.sleep(500)]);
        }
      }
      this.disconnect(new Error("host terminated"));
      if (this.dir) rmSync(this.dir, { recursive: true, force: true });
      this.dir = "";
    })();
    return this.termination;
  }
  private disconnect(e: Error) {
    this.outgoing.length = 0;
    this.outgoingOffset = 0;
    this.queuedBytes = 0;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = undefined;
  }
}
