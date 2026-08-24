type Candidate = {
  id: string;
  type: "candidate";
  displayName: string;
  stage: string;
  stageLabel: string;
  headline: string;
  updatedAt: string;
};

let context: any;
let candidates: Candidate[] = [];

function validCandidate(value: unknown): value is Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  return JSON.stringify(keys) === JSON.stringify(["displayName", "headline", "id", "stage", "stageLabel", "type", "updatedAt"])
    && item.type === "candidate"
    && ["id", "displayName", "stage", "stageLabel", "headline", "updatedAt"].every((key) => typeof item[key] === "string")
    && /^candidate-[a-z0-9-]+$/.test(item.id as string)
    && !Number.isNaN(Date.parse(item.updatedAt as string));
}

export default {
  async activate(ctx: any) {
    context = ctx;
    const stored = await ctx.storage.readJson("candidates.json");
    if (stored !== null && (!Array.isArray(stored) || !stored.every(validCandidate))) {
      throw Object.assign(new Error("invalid candidate fixture"), { code: "SAMPLE_READONLY_SCHEMA_INVALID" });
    }
    candidates = stored ?? [];
  },

  route({ request, url }: { request: Request; url: URL }) {
    if (url.pathname !== "/api/verticals/sample-readonly/candidates") return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ ok: false, code: "READ_ONLY" }), { status: 405 });
    }
    const body = request.method === "HEAD" ? null : JSON.stringify({ schemaVersion: 1, candidates });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  },

  health() {
    return { ok: !!context, mode: "read-only", schemaVersion: 1, candidateCount: candidates.length };
  },
};
