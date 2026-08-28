import { createHash } from "crypto";
import type {
  ScopedSources,
  SourceDocumentDescriptor,
  SourceDocumentSnapshot,
  SourceProviderStatus,
} from "../extensions/contracts.ts";

const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const TRUSTED_HOSTS = ["feishu.cn", "larksuite.com"];
const DOCUMENT_TYPES = new Set(["doc", "docx"]);

export interface SourceCommandResult { exitCode: number; stdout: string; stderr: string }
export type SourceCommandRunner = (args: readonly string[], timeoutMs: number) => Promise<SourceCommandResult>;

function sourceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function cleanError(value: string): string {
  return value
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 500);
}

function classifyFailure(result: SourceCommandResult): Error {
  const detail = cleanError(`${result.stderr} ${result.stdout}`);
  if (/auth|login|oauth|user.?token|not logged/i.test(detail)) return sourceError("SOURCE_AUTH_REQUIRED", "飞书账号尚未连接，请先完成用户授权");
  if (/permission|forbidden|access denied|403|no privilege/i.test(detail)) return sourceError("SOURCE_PERMISSION_DENIED", "当前飞书账号没有读取该文档的权限");
  return sourceError("SOURCE_PROVIDER_FAILED", detail || "飞书资料读取失败");
}

export async function runSourceCommand(args: readonly string[], timeoutMs: number): Promise<SourceCommandResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["lark-cli", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw sourceError("SOURCE_PROVIDER_UNAVAILABLE", "本机缺少 lark-cli");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 超时用 SIGKILL 强杀：SIGTERM 可被忽略，lark-cli 若挂在网络请求上会残留进程、占着 fd。
      try { proc.kill("SIGKILL"); } catch {}
      reject(sourceError("SOURCE_TIMEOUT", "飞书资料读取超时"));
    }, timeoutMs);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
      timedOut,
    ]);
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(stderr) > 256 * 1024) throw sourceError("SOURCE_RESPONSE_TOO_LARGE", "飞书文档超过单次读取上限");
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trustedLarkUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw sourceError("SOURCE_URL_INVALID", "请输入完整的飞书文档链接"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !TRUSTED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw sourceError("SOURCE_URL_DENIED", "只允许读取 feishu.cn 或 larksuite.com 的 HTTPS 文档链接");
  }
  if (!/^\/(?:docx|doc|wiki)\//.test(url.pathname)) throw sourceError("SOURCE_TYPE_UNSUPPORTED", "当前支持飞书文档和知识库中的文档");
  url.username = ""; url.password = "";
  return url.toString();
}

function jsonResult(result: SourceCommandResult): any {
  if (result.exitCode !== 0) throw classifyFailure(result);
  let value: any;
  try { value = JSON.parse(result.stdout); } catch { throw sourceError("SOURCE_RESPONSE_INVALID", "飞书返回了无法识别的数据"); }
  if (value?.ok === false) throw classifyFailure({ ...result, stderr: `${result.stderr} ${JSON.stringify(value.error || {})}` });
  return value;
}

function inspectRecord(value: any): any {
  if (value?.type && value?.token) return value;
  if (value?.data?.type && value?.data?.token) return value.data;
  if (value?.data?.document?.type && value?.data?.document?.token) return value.data.document;
  throw sourceError("SOURCE_RESPONSE_INVALID", "飞书链接检视结果缺少文档信息");
}

function documentRecord(value: any): any {
  const record = value?.data?.document ?? value?.document ?? value?.data ?? value;
  if (!record || typeof record.content !== "string") throw sourceError("SOURCE_RESPONSE_INVALID", "飞书文档正文为空或格式无法识别");
  return record;
}

export class LarkDocumentSources implements ScopedSources {
  constructor(private readonly execute: SourceCommandRunner = runSourceCommand) {}

  async status(provider: "lark"): Promise<SourceProviderStatus> {
    if (provider !== "lark") throw sourceError("SOURCE_PROVIDER_UNSUPPORTED", "不支持的数据源");
    try {
      const result = await this.execute(["whoami", "--as", "user"], 10_000);
      if (result.exitCode !== 0) return { provider, available: true, authenticated: false, identity: "user", message: "飞书账号尚未连接" };
      return { provider, available: true, authenticated: true, identity: "user" };
    } catch (error: any) {
      if (error?.code === "SOURCE_PROVIDER_UNAVAILABLE") return { provider, available: false, authenticated: false, identity: "user", message: "本机缺少 lark-cli" };
      return { provider, available: true, authenticated: false, identity: "user", message: cleanError(error?.message || "飞书连接异常") };
    }
  }

  async inspect(input: { provider: "lark"; url: string }): Promise<SourceDocumentDescriptor> {
    if (input?.provider !== "lark") throw sourceError("SOURCE_PROVIDER_UNSUPPORTED", "不支持的数据源");
    const url = trustedLarkUrl(input.url);
    const record = inspectRecord(jsonResult(await this.execute(["drive", "+inspect", "--url", url, "--as", "user", "--format", "json"], 30_000)));
    const type = String(record.type || "");
    if (!DOCUMENT_TYPES.has(type)) throw sourceError("SOURCE_TYPE_UNSUPPORTED", `当前暂不支持飞书 ${type || "未知"} 类型`);
    const canonicalId = String(record.token || "");
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(canonicalId)) throw sourceError("SOURCE_RESPONSE_INVALID", "飞书链接检视结果包含无效文档标识");
    return {
      provider: "lark", identity: "user", canonicalId, type: type as "doc" | "docx",
      title: String(record.title || "未命名飞书文档").trim().slice(0, 300), url: trustedLarkUrl(String(record.url || url)),
    };
  }

  async fetch(input: { provider: "lark"; url: string }): Promise<SourceDocumentSnapshot> {
    const descriptor = await this.inspect(input);
    const value = jsonResult(await this.execute(["docs", "+fetch", "--doc", descriptor.url, "--doc-format", "markdown", "--detail", "with-ids", "--as", "user"], 90_000));
    const record = documentRecord(value), content = String(record.content).replace(/\r\n/g, "\n").trim();
    if (!content) throw sourceError("SOURCE_CONTENT_EMPTY", "飞书文档没有可归档的正文");
    const contentHash = createHash("sha256").update(content).digest("hex");
    return {
      ...descriptor, revision: String(record.revision_id ?? contentHash), contentHash,
      contentType: "text/markdown", content, fetchedAt: new Date().toISOString(),
    };
  }
}
