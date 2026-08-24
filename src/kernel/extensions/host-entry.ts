import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { clampFrameMax, encodeHostFrame, HostFrameDecoder, type HostEnvelope } from "./host-protocol.ts";
import { timingSafeEqual } from "crypto";

const socketPath = process.env.OWNWARD_EXTENSION_SOCKET || "", capability = process.env.OWNWARD_EXTENSION_CAPABILITY || "", extensionRoot = process.env.OWNWARD_EXTENSION_ROOT || "", entry = process.env.OWNWARD_EXTENSION_ENTRY || "";
if (!socketPath || !/^[a-f0-9]{64}$/.test(capability) || !extensionRoot || !entry) throw new Error("Extension Host 启动参数非法");
const FRAME_MAX = clampFrameMax(process.env.OWNWARD_EXTENSION_FRAME_MAX);
const MAX_OUTGOING_BYTES = Math.max(2 * 1024 * 1024, FRAME_MAX + 1024 * 1024);
type Conn = { socket: Bun.Socket<Conn>; decoder: HostFrameDecoder; pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>; outgoing: Uint8Array[]; outgoingOffset: number; queuedBytes: number; module?: any; context?: any; jobs?: Map<string, { intervalMs: number; fn: (signal: AbortSignal) => Promise<void> | void }>; activated?: boolean };
function flush(c: Conn) { while (c.outgoing.length) { const frame = c.outgoing[0]!, written = c.socket.write(frame, c.outgoingOffset, frame.byteLength - c.outgoingOffset); if (written < 0) { c.socket.close(); return; } if (written === 0) return; c.outgoingOffset += written; c.queuedBytes -= written; if (c.outgoingOffset < frame.byteLength) return; c.outgoing.shift(); c.outgoingOffset = 0; } }
function send(c: Conn, env: HostEnvelope) { const frame = encodeHostFrame(env, FRAME_MAX); if (c.queuedBytes + frame.byteLength > MAX_OUTGOING_BYTES) { c.socket.close(); throw Object.assign(new Error("Host outgoing queue overflow"), { code: "EXTENSION_HOST_BACKPRESSURE" }); } c.outgoing.push(frame); c.queuedBytes += frame.byteLength; flush(c); }
function request(c: Conn, method: string, body: Record<string, unknown>, timeoutMs = 2_000) { const id = `host-${crypto.randomUUID()}`; return new Promise<any>((resolvePromise, reject) => { const timer = setTimeout(() => { c.pending.delete(id); reject(Object.assign(new Error("Kernel RPC timeout"), { code: "EXTENSION_KERNEL_TIMEOUT" })); }, timeoutMs); c.pending.set(id, { resolve: resolvePromise, reject, timer }); send(c, { version: 1, type: "request", id, capability, method, body }); }); }
function deepFreeze<T>(v: T): T { if (v && typeof v === "object") { Object.freeze(v); for (const child of Object.values(v as any)) deepFreeze(child); } return v; }
function capEqual(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function exact(body: Record<string, unknown>, keys: string[]) { if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) throw Object.assign(new Error("body schema invalid"), { code: "EXTENSION_REQUEST_INVALID" }); }
function safeAsset(root: string, file: string): string { const target = resolve(root, file), rel = relative(root, target); if (rel === ".." || rel.startsWith(`..${sep}`)) throw Object.assign(new Error("asset 越界"), { code: "EXTENSION_ASSET_DENIED" }); let cur = root; for (const p of rel.split(sep).filter(Boolean)) { cur = resolve(cur, p); if (lstatSync(cur).isSymbolicLink()) throw Object.assign(new Error("asset symlink"), { code: "EXTENSION_ASSET_DENIED" }); } const real = realpathSync(target), rr = realpathSync(root), realRel = relative(rr, real); if (realRel === ".." || realRel.startsWith(`..${sep}`) || !statSync(real).isFile()) throw Object.assign(new Error("asset 越界"), { code: "EXTENSION_ASSET_DENIED" }); return real; }
async function handle(c: Conn, env: HostEnvelope) {
  if (!capEqual(env.capability, capability)) throw Object.assign(new Error("capability mismatch"), { code: "EXTENSION_UNAUTHORIZED" });
  if (env.type === "response") { const p = c.pending.get(env.id); if (!p) return; clearTimeout(p.timer); c.pending.delete(env.id); env.ok ? p.resolve(env.body) : p.reject(Object.assign(new Error("Kernel RPC rejected"), { code: env.errorCode })); return; }
  try { let body: Record<string, unknown> = {};
    if(env.method==="describe"){exact(env.body,[]);if(!c.module)c.module=(await import(pathToFileURL(entry).href)).default;body={hasMigration:typeof c.module?.migrate==="function"};
    }else if(env.method==="migrate"){
      exact(env.body,["id","config","grants","migrationId"]);const config=deepFreeze(structuredClone(env.body.config||{})),grants=env.body.grants as any,leaseId=String(grants.leaseId||""),storage=grants.storage?Object.freeze({readJson:async(key:string)=>(await request(c,"storage.read",{key,leaseId})).value??null,writeJson:async(key:string,value:unknown)=>{await request(c,"storage.write",{key,value,leaseId})},remove:async(key:string)=>{await request(c,"storage.remove",{key,leaseId})}}):undefined;if(!c.module)c.module=(await import(pathToFileURL(entry).href)).default;if(!c.module||typeof c.module.activate!=="function")throw Object.assign(new Error("module invalid"),{code:"EXTENSION_MODULE_INVALID"});if(c.module.migrate)await c.module.migrate(deepFreeze({migrationId:env.body.migrationId,config,storage,log:(operation:string,message:string)=>request(c,"log",{operation,message:String(message).slice(0,500)}).catch(()=>{})}));body={migrated:true};
    } else if (env.method === "activate") {
      exact(env.body, ["id", "config", "grants"]); if (typeof env.body.id !== "string" || !env.body.config || typeof env.body.config !== "object" || !env.body.grants || typeof env.body.grants !== "object") throw Object.assign(new Error(), { code: "EXTENSION_REQUEST_INVALID" });
      const config = deepFreeze(structuredClone(env.body.config || {})), grants = env.body.grants as any;
      const leaseId=String(grants.leaseId||""),storage = grants.storage ? Object.freeze({ readJson: async (key: string) => (await request(c, "storage.read", { key,leaseId })).value ?? null, writeJson: async (key: string, value: unknown) => { await request(c, "storage.write", { key, value,leaseId }); }, remove: async (key: string) => { await request(c, "storage.remove", { key,leaseId }); } }) : undefined;
      // actions：与 storage 同款 lease 通道；调用方一律 await（契约允许 Promise 版）
      const actionsLeaseId=String(grants.actionsLeaseId||""),actions = grants.actions ? Object.freeze({
        list: async () => (await request(c, "actions.list", { leaseId: actionsLeaseId })).actions ?? [],
        open: async (action: unknown) => !!(await request(c, "actions.open", { action, leaseId: actionsLeaseId })).ok,
        resolve: async (id: string, resolution: string) => !!(await request(c, "actions.resolve", { id, resolution, leaseId: actionsLeaseId })).ok,
        dismiss: async (id: string) => !!(await request(c, "actions.dismiss", { id, leaseId: actionsLeaseId })).ok,
      }) : undefined;
      // scheduler：activate 期间只登记（fn 留在 host 本地），登记表随 activate 响应带回 kernel，由 kernel 侧 SchedulerScope 驱动 job RPC
      c.jobs = new Map(); c.activated = false;
      const scheduler = Object.freeze({ every: (id: string, intervalMs: number, fn: (signal: AbortSignal) => Promise<void> | void) => {
        if (c.activated) throw Object.assign(new Error("scheduler 只能在 activate 期间注册"), { code: "EXTENSION_SCHEDULE_LATE" });
        if (typeof id !== "string" || !Number.isInteger(intervalMs) || typeof fn !== "function" || c.jobs!.has(id)) throw Object.assign(new Error("调度声明非法"), { code: "EXTENSION_SCHEDULE_INVALID" });
        c.jobs!.set(id, { intervalMs, fn });
      } });
      // LLM 一跑几分钟,RPC 超时给足(上限由 Kernel 侧钳制,这里只是别让传输层先超时)
      const llmLeaseId=String(grants.llmLeaseId||""),llm = grants.llm ? Object.freeze({
        complete: async (inp: any) => (await request(c, "llm.complete", { input: inp, leaseId: llmLeaseId }, Math.min(660_000, Number(inp?.timeoutMs) > 0 ? Number(inp.timeoutMs) + 60_000 : 300_000))).value ?? null,
        engines: async () => (await request(c, "llm.engines", { leaseId: llmLeaseId }, 5_000)).value ?? [],
      }) : undefined;
      const mod = c.module?null:await import(pathToFileURL(entry).href); c.module = c.module??mod!.default;
      if (!c.module || typeof c.module.activate !== "function") throw Object.assign(new Error("module invalid"), { code: "EXTENSION_MODULE_INVALID" });
      c.context = deepFreeze({ id: env.body.id, config, storage, actions, scheduler, llm, log: (operation: string, message: string) => request(c, "log", { operation, message: String(message).slice(0, 500) }).catch(() => {}) }); await c.module.activate(c.context); c.activated = true; body = { ready: true, manifest: c.module.manifest ?? null, jobs: [...c.jobs].map(([id, j]) => ({ id, intervalMs: j.intervalMs })) };
    } else if (env.method === "route") {
      exact(env.body, ["method", "url", "headers", "body", "timeoutMs", "maxResponseBytes"]); if (typeof env.body.method !== "string" || typeof env.body.url !== "string" || typeof env.body.body !== "string" || !Number.isInteger(env.body.timeoutMs) || !Number.isInteger(env.body.maxResponseBytes)) throw Object.assign(new Error(), { code: "EXTENSION_REQUEST_INVALID" });
      if (!c.module?.route) body = { handled: false };
      else {
        const b = env.body as any, req = new Request(b.url, { method: b.method, headers: b.headers, body: ["GET", "HEAD"].includes(b.method) ? undefined : Buffer.from(b.body || "", "base64") });
        const response = await c.module.route({ request: req, url: new URL(b.url), signal: AbortSignal.timeout(Number(b.timeoutMs || 2_000)) });
        if (!response) body = { handled: false };
        else { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > Math.max(512 * 1024, Number(env.body.maxResponseBytes) || 0)) throw Object.assign(new Error("route response too large"), { code: "EXTENSION_RESPONSE_TOO_LARGE" }); body = { handled: true, status: response.status, headers: Object.fromEntries(response.headers), body: bytes.toString("base64") }; }
      }
    }
    else if (env.method === "asset") { exact(env.body, ["file"]); if (typeof env.body.file !== "string") throw Object.assign(new Error(), { code: "EXTENSION_REQUEST_INVALID" }); try { const f = safeAsset(extensionRoot, env.body.file), st = statSync(f); if (st.size > 512 * 1024) throw Object.assign(new Error("asset too large"), { code: "EXTENSION_ASSET_TOO_LARGE" }); body = { body: Buffer.from(readFileSync(f)).toString("base64") }; } catch (error: any) { if (error?.code === "ENOENT") throw Object.assign(new Error("asset not found"), { code: "EXTENSION_ASSET_NOT_FOUND" }); throw error; } }
    else if (env.method === "job") { exact(env.body, ["id", "timeoutMs"]); const job = c.jobs?.get(String(env.body.id)); if (!job) throw Object.assign(new Error("job 不存在"), { code: "EXTENSION_JOB_UNKNOWN" }); await job.fn(AbortSignal.timeout(Number(env.body.timeoutMs) || 600_000)); body = { done: true }; }
    else if (env.method === "health") { exact(env.body, []); body = c.module?.health ? await c.module.health() : { ok: true }; }
    else if (env.method === "stop") { exact(env.body, []); await c.module?.deactivate?.(); body = { stopped: true }; setTimeout(() => { listener.stop(true); process.exit(0); }, 0); }
    else throw Object.assign(new Error("method denied"), { code: "EXTENSION_METHOD_DENIED" });
    send(c, { version: 1, type: "response", id: env.id, capability, method: env.method, ok: true, body });
  } catch (e: any) { send(c, { version: 1, type: "response", id: env.id, capability, method: env.method, ok: false, errorCode: String(e?.code || "EXTENSION_HOST_ERROR"), body: {} }); }
}
if (existsSync(socketPath)) { if (!lstatSync(socketPath).isSocket()) throw new Error("socket path occupied"); unlinkSync(socketPath); }
const listener = Bun.listen<Conn>({ unix: socketPath, socket: { binaryType: "buffer", open(socket) { socket.data = { socket, decoder: new HostFrameDecoder(FRAME_MAX), pending: new Map(), outgoing: [], outgoingOffset: 0, queuedBytes: 0 }; }, data(socket, bytes) { let frames: HostEnvelope[]; try { frames = socket.data.decoder.push(bytes); } catch { socket.close(); return; } for (const env of frames) void handle(socket.data, env).catch(() => socket.close()); }, drain(socket) { flush(socket.data); }, close(socket) { for (const p of socket.data.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Kernel disconnected")); } socket.data.pending.clear(); socket.data.outgoing.length = 0; socket.data.queuedBytes = 0; socket.data.outgoingOffset = 0; listener.stop(true); setTimeout(()=>process.exit(0),0); }, error(socket) { socket.close(); } } }); chmodSync(socketPath, 0o600);
// Windows：`unix:` 在 Bun 里落成命名管道，socket 路径上不会出现文件，
// Kernel 那边没有东西可以 stat 来判断「已经在 listen 了」。这里显式落一个 ready 标记。
// 不能让 Kernel 靠「连不上就重试」来探活：连接失败会走 connectError → unexpectedDisconnect，
// 那条路会直接把本 Host 进程杀掉。标记文件写在 Kernel 自己 mkdtemp 出来的私有目录里。
if (process.platform === "win32") writeFileSync(socketPath + ".ready", "1");
process.on("SIGTERM", () => { listener.stop(true); process.exit(0); });
