import { RunnerCommandJournal } from "../../runner/journals.ts";
import { readRunnerAttachment, type RunnerAttachmentRef } from "../../runner/attachments.ts";
import { statSync } from "fs";
import { join } from "path";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type StoredImage = { mediaType: string; blob: RunnerAttachmentRef };
type IndexedImage = { image: StoredImage; command: ReturnType<RunnerCommandJournal["readStrict"]>[number] };
type SessionImageIndex = { signature: string; entries: Map<string, IndexedImage> };
const indexes = new Map<string, SessionImageIndex>();
const INDEX_ROOT_LIMIT = 4;
let indexBuilds = 0;

function journalSignature(dataRoot: string): string {
  try { const stat = statSync(join(dataRoot, "runner", "commands.jsonl")); return `${stat.size}:${stat.mtimeMs}`; }
  catch { return "missing"; }
}

function imageIndex(dataRoot: string): SessionImageIndex {
  const signature = journalSignature(dataRoot), cached = indexes.get(dataRoot);
  if (cached?.signature === signature) { indexes.delete(dataRoot); indexes.set(dataRoot, cached); return cached; }
  const journal = new RunnerCommandJournal(dataRoot), entries = new Map<string, IndexedImage>();
  for (const command of journal.readStrict()) {
    if (!["start-run", "resume-run", "send-input"].includes(command.kind)) continue;
    const images = storedImages(journal.readInput(command));
    for (const image of images) entries.set(`${command.sessionId}\0${image.blob.sha256}`, { image, command });
  }
  const built = { signature, entries }; indexes.delete(dataRoot); indexes.set(dataRoot, built); indexBuilds++;
  while (indexes.size > INDEX_ROOT_LIMIT) indexes.delete(indexes.keys().next().value!);
  return built;
}

export function sessionImageIndexStatsForTest(reset = false): { builds: number; roots: number } {
  if (reset) { indexes.clear(); indexBuilds = 0; }
  return { builds: indexBuilds, roots: indexes.size };
}

function storedImages(raw: string | undefined): StoredImage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw), images = parsed?.images;
    if (!Array.isArray(images)) return [];
    return images.filter((image: any): image is StoredImage => image && MIME.has(image.mediaType)
      && image.blob && typeof image.blob.ref === "string" && typeof image.blob.sha256 === "string"
      && Number.isSafeInteger(image.blob.bytes));
  } catch { return []; }
}

export function sessionImageUrls(sessionId: string, images: readonly StoredImage[]): string[] {
  if (!SESSION_ID_RE.test(sessionId)) return [];
  return images.filter((image) => MIME.has(image.mediaType) && SHA_RE.test(image.blob.sha256))
    .slice(0, 20).map((image) => `/api/session-image/${sessionId}/${image.blob.sha256}`);
}

function sniffMime(bin: Buffer): string | null {
  if (bin.length >= 8 && bin.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (bin.length >= 3 && bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff) return "image/jpeg";
  if (bin.length >= 12 && bin.toString("latin1", 0, 4) === "RIFF" && bin.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bin.length >= 6 && /^GIF8[79]a$/.test(bin.toString("latin1", 0, 6))) return "image/gif";
  return null;
}

/** Only an attachment referenced by this exact session's durable command journal may be read. */
export function readSessionImage(dataRoot: string, sessionId: string, sha256: string): { bin: Buffer; mime: string } | null {
  if (!SESSION_ID_RE.test(sessionId) || !SHA_RE.test(sha256)) return null;
  try {
    const indexed = imageIndex(dataRoot).entries.get(`${sessionId}\0${sha256}`); if (!indexed) return null;
    // 命中才重读其 input blob：随机 miss 不扫描 journal；命中仍证明 membership 未被篡改。
    const journal = new RunnerCommandJournal(dataRoot), current = storedImages(journal.readInput(indexed.command))
      .find((candidate) => candidate.mediaType === indexed.image.mediaType && candidate.blob.sha256 === sha256
        && candidate.blob.ref === indexed.image.blob.ref && candidate.blob.bytes === indexed.image.blob.bytes);
    if (!current) return null;
    const encoded = readRunnerAttachment(dataRoot, current.blob), bin = Buffer.from(encoded, "base64"), mime = sniffMime(bin);
    return mime === current.mediaType ? { bin, mime } : null;
  } catch { return null; }
}

export function commandSessionImages(sessionId: string, raw: string): string[] {
  return sessionImageUrls(sessionId, storedImages(raw));
}
