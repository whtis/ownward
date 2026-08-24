export type ModuleType = "kernel" | "provider" | "connector" | "vertical" | "runner";
export type CoreLogRecord = { event: string; moduleType: ModuleType; moduleId: string; operation: string; taskId: string | null; runId: string | null; sessionId: string | null; eventId: string | null; msg: string; errorClass?: string };

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_MESSAGE = 500;
const SECRET_KEY_WORDS = new Set(["authorization", "cookie", "password", "token", "secret", "credential"]);
const SECRET_KEY_SUFFIXES = new Set(["key", "password", "token", "secret", "credential"]);

/** Split camelCase/PascalCase and separator-delimited keys before applying a conservative suffix rule. */
const keyWords = (key: string) => key
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

const isSecretKey = (key: string) => {
  const words = keyWords(key);
  if (words.some((word) => SECRET_KEY_WORDS.has(word))) return true;
  return words.length > 0 && SECRET_KEY_SUFFIXES.has(words.at(-1)!);
};
const field = (value: unknown) => typeof value === "string" && SAFE.test(value) ? value : null;

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, isSecretKey(key) ? "[REDACTED]" : redactValue(item, seen)]));
  }
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
  return value;
}

function redactString(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.stringify(redactValue(JSON.parse(trimmed))); } catch { /* malformed text is sanitized below */ }
  }
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, "[REDACTED]")
    // Authorization values and bearer credentials are not restricted to token68 in the wild.
    .replace(/(\bauthorization\s*[:=]\s*)(?:[^\r\n]+)/gi, "$1[REDACTED]")
    .replace(/\bBearer(?:\s+[^\r\n]*)?/gi, "Bearer [REDACTED]")
    .replace(/(["']?)([A-Za-z][A-Za-z0-9_-]*(?:[ ][A-Za-z0-9_-]+){0,3})\1(\s*[:=]\s*)(["'][^"'\n]*["']|[^\n,;}&]+)/g,
      (match, quote: string, key: string, separator: string) => isSecretKey(key) ? `${quote}${key}${quote}${separator}[REDACTED]` : match)
    .replace(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){2,}/g, "[PATH]");
}

/** Recursively redacts structured data, then bounds it for a human diagnostic field. */
export function cleanMessage(value: unknown): string {
  const rendered = typeof value === "string" ? redactString(value) : JSON.stringify(redactValue(value));
  return String(rendered ?? "").slice(0, MAX_MESSAGE);
}

/** Fixed-shape metadata only; correlations are allowlisted and the message is bounded/redacted. */
export function coreLog(input: { event: string; moduleType: ModuleType; moduleId: string; operation: string; taskId?: unknown; runId?: unknown; sessionId?: unknown; eventId?: unknown; errorClass?: unknown; msg?: unknown }): CoreLogRecord {
  return { event: String(input.event).slice(0, 128), moduleType: input.moduleType, moduleId: field(input.moduleId) ?? "unknown", operation: field(input.operation) ?? "unknown", taskId: field(input.taskId), runId: field(input.runId), sessionId: field(input.sessionId), eventId: field(input.eventId), msg: cleanMessage(input.msg), ...(field(input.errorClass) ? { errorClass: field(input.errorClass)! } : {}) };
}

export function emitCoreLog(input: Parameters<typeof coreLog>[0], sink: (line: string) => void = console.error): void { sink(JSON.stringify(coreLog(input))); }
