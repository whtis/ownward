import { chmodSync, existsSync, lstatSync, unlinkSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { timingSafeEqual } from "crypto";
import {
  encodeHostFrame,
  HostFrameDecoder,
  type HostEnvelope,
} from "../extensions/host-protocol.ts";

const socketPath = process.env.OWNWARD_CONNECTOR_SOCKET || "",
  capability = process.env.OWNWARD_CONNECTOR_CAPABILITY || "",
  entry = process.env.OWNWARD_CONNECTOR_ENTRY || "";
if (!socketPath || !/^[a-f0-9]{64}$/.test(capability) || !entry)
  throw new Error("Connector Host args invalid");
type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const MAX_OUTGOING_BYTES = 2 * 1024 * 1024;
type Conn = {
  socket: Bun.Socket<Conn>;
  decoder: HostFrameDecoder;
  pending: Map<string, Pending>;
  outgoing: Uint8Array[];
  outgoingOffset: number;
  queuedBytes: number;
  module?: any;
  controller?: AbortController;
};
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function flush(c: Conn) {
  while (c.outgoing.length) {
    const frame = c.outgoing[0]!,
      written = c.socket.write(
        frame,
        c.outgoingOffset,
        frame.byteLength - c.outgoingOffset,
      );
    if (written < 0) {
      c.socket.close();
      return;
    }
    if (written === 0) return;
    c.outgoingOffset += written;
    c.queuedBytes -= written;
    if (c.outgoingOffset < frame.byteLength) return;
    c.outgoing.shift();
    c.outgoingOffset = 0;
  }
}
function send(c: Conn, env: HostEnvelope) {
  const frame = encodeHostFrame(env);
  if (c.queuedBytes + frame.byteLength > MAX_OUTGOING_BYTES) {
    c.socket.close();
    throw Object.assign(new Error("host outgoing queue overflow"), {
      code: "CONNECTOR_HOST_BACKPRESSURE",
    });
  }
  c.outgoing.push(frame);
  c.queuedBytes += frame.byteLength;
  flush(c);
}
function request(
  c: Conn,
  method: string,
  body: Record<string, unknown>,
  timeout = 5000,
) {
  const id = `host-${crypto.randomUUID()}`;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(
        Object.assign(new Error("Kernel timeout"), {
          code: "CONNECTOR_KERNEL_TIMEOUT",
        }),
      );
    }, timeout);
    c.pending.set(id, { resolve, reject, timer });
    send(c, { version: 1, type: "request", id, capability, method, body });
  });
}
async function handle(c: Conn, env: HostEnvelope) {
  if (!equal(env.capability, capability)) throw new Error("unauthorized");
  if (env.type === "response") {
    const p = c.pending.get(env.id);
    if (!p) return;
    clearTimeout(p.timer);
    c.pending.delete(env.id);
    env.ok
      ? p.resolve(env.body)
      : p.reject(
          Object.assign(new Error("Kernel rejected"), { code: env.errorCode }),
        );
    return;
  }
  try {
    let body: Record<string, unknown> = {};
    if (env.method === "describe") {
      if (!c.module)
        c.module = (await import(pathToFileURL(entry).href)).default;
      body = { hasMigration: typeof c.module?.migrate === "function" };
    } else if (env.method === "migrate") {
      if (!c.module)
        c.module = (await import(pathToFileURL(entry).href)).default;
      const grants = env.body.grants as Record<string, unknown>;
      const leaseId = String(grants?.leaseId || "");
      const storage = grants?.storage
        ? Object.freeze({
            readJson: async (key: string) =>
              (await request(c, "storage.read", { key, leaseId })).value ??
              null,
            writeJson: async (key: string, value: unknown) =>
              void (await request(c, "storage.write", { key, value, leaseId })),
            remove: async (key: string) =>
              void (await request(c, "storage.remove", { key, leaseId })),
          })
        : undefined;
      await c.module?.migrate?.(
        Object.freeze({
          migrationId: String(env.body.migrationId || ""),
          config: Object.freeze(structuredClone(env.body.config || {})),
          storage,
          log: (operation: string, message: string) =>
            void request(c, "log", {
              operation,
              message: String(message).slice(0, 500),
            }).catch(() => {}),
        }),
      );
      body = { migrated: true };
    } else if (env.method === "activate") {
      if (!c.module)
        c.module = (await import(pathToFileURL(entry).href)).default;
      c.controller = new AbortController();
      if (!c.module || typeof c.module.start !== "function")
        throw Object.assign(new Error("module invalid"), {
          code: "CONNECTOR_MODULE_INVALID",
        });
      const config = Object.freeze(structuredClone(env.body.config || {}));
      const ctx = Object.freeze({
        id: env.body.id,
        generation: String(env.body.generation || ""),
        config,
        signal: c.controller.signal,
        checkpoint: async () =>
          (await request(c, "checkpoint", {})).value ?? null,
        publish: async (events: any[], nextCheckpoint?: any) =>
          request(c, "publish", { events, nextCheckpoint }),
        secret: async (ref: string) =>
          (await request(c, "secret", { ref })).value,
        reportHealth: async (report: any) =>
          void (await request(c, "report-health", { report })),
        log: (operation: string, message: string) =>
          void request(c, "log", {
            operation,
            message: String(message).slice(0, 500),
          }).catch(() => {}),
      });
      await c.module.start(ctx);
      body = { ready: true, manifest: c.module.manifest ?? null };
    } else if (env.method === "health")
      body = c.module?.health
        ? await c.module.health()
        : { status: "unknown", reason: "health probe not implemented" };
    else if (env.method === "stop") {
      c.controller?.abort();
      await c.module?.stop?.();
      body = { stopped: true };
      setTimeout(() => {
        listener.stop(true);
        process.exit(0);
      }, 0);
    } else
      throw Object.assign(new Error("denied"), {
        code: "CONNECTOR_HOST_METHOD_DENIED",
      });
    send(c, {
      version: 1,
      type: "response",
      id: env.id,
      capability,
      method: env.method,
      ok: true,
      body,
    });
  } catch (e: any) {
    send(c, {
      version: 1,
      type: "response",
      id: env.id,
      capability,
      method: env.method,
      ok: false,
      errorCode: String(e?.code || "CONNECTOR_HOST_ERROR"),
      body: {},
    });
  }
}
if (existsSync(socketPath)) {
  if (!lstatSync(socketPath).isSocket()) throw new Error("socket occupied");
  unlinkSync(socketPath);
}
const active = new Set<Conn>();
const listener = Bun.listen<Conn>({
  unix: socketPath,
  socket: {
    binaryType: "buffer",
    open(socket) {
      socket.data = {
        socket,
        decoder: new HostFrameDecoder(),
        pending: new Map(),
        outgoing: [],
        outgoingOffset: 0,
        queuedBytes: 0,
      };
      active.add(socket.data);
    },
    data(socket, bytes) {
      let frames;
      try {
        frames = socket.data.decoder.push(bytes);
      } catch {
        socket.close();
        return;
      }
      for (const env of frames)
        void handle(socket.data, env).catch(() => socket.close());
    },
    drain(socket) {
      flush(socket.data);
    },
    close(socket) {
      active.delete(socket.data);
      for (const p of socket.data.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("disconnected"));
      }
      socket.data.pending.clear();
      socket.data.outgoing.length = 0;
      socket.data.outgoingOffset = 0;
      socket.data.queuedBytes = 0;
      listener.stop(true);
      setTimeout(() => process.exit(0), 0);
    },
    error(socket) {
      socket.close();
    },
  },
});
chmodSync(socketPath, 0o600);
// Windows：Bun 把 unix socket 映射成命名管道，socketPath 上不会出现文件实体，
// Kernel 那边的 stat 就绪门永远不会亮。显式落一个 ready 标记（与 Vertical Host 同解）。
if (process.platform === "win32") writeFileSync(socketPath + ".ready", "1");
// 自检 socket 权限。Windows 上命名管道在路径上没有文件实体，lstat 直接 EACCES，
// 这一句会把刚起来的 Host 自己抛死（表现是 CONNECTOR_HOST_EXITED → CONNECTOR_START_FAILED）。
// 该平台上没有可检查的对应物，归属由私有 mkdtemp 目录 + capability 握手保证。
if (process.platform !== "win32") {
  const socketStat = lstatSync(socketPath);
  if (!socketStat.isSocket() || (socketStat.mode & 0o077) !== 0)
    throw new Error("Connector Host socket permissions invalid");
}
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  for (const c of active) c.controller?.abort();
  listener.stop(true);
  setTimeout(() => process.exit(0), 500);
});
