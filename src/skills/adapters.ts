import { createHash } from "crypto";
import { join, resolve } from "path";
import type { SkillAdapterStatus, SkillEngine, SkillRoot, SkillScanOptions } from "./contracts.ts";

const commands: Record<SkillEngine, string> = { claude: "claude", codex: "codex", codebuddy: "codebuddy" };
const ranges: Record<SkillEngine, { label: string; supports: (version: string) => boolean }> = {
  claude: { label: ">=1.0.0 <3.0.0", supports: (v) => { const major = Number(v.split(".")[0]); return major >= 1 && major < 3; } },
  codex: { label: ">=0.1.0 <1.0.0", supports: (v) => { const [major, minor] = v.split(".").map(Number); return major === 0 && minor >= 1; } },
  codebuddy: { label: ">=1.0.0 <3.0.0", supports: (v) => { const major = Number(v.split(".")[0]); return major >= 1 && major < 3; } },
};
export function skillEngineVersionStatus(engine: SkillEngine, version: string | null): { range: string; status: "supported" | "unsupported" | "unknown" } { const matrix = ranges[engine]; return { range: matrix.label, status: !version ? "unknown" : matrix.supports(version) ? "supported" : "unsupported" }; }

export function probeSkillAdapters(options: SkillScanOptions): SkillAdapterStatus[] {
  const platform = options.platform || process.platform;
  return (["claude", "codex", "codebuddy"] as SkillEngine[]).map((engine) => {
    const injected = options.adapterStatus?.[engine];
    if (injected) return { ...injected, engine, matrixVersion: 1, platform };
    let version: string | null = null;
    try {
      const result = Bun.spawnSync([commands[engine], "--version"], { stdout: "pipe", stderr: "pipe" });
      const text = `${result.stdout.toString()} ${result.stderr.toString()}`.trim();
      version = /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0] || null;
      if (result.exitCode !== 0) version = null;
    } catch { version = null; }
    const matrix = ranges[engine], versionCheck = skillEngineVersionStatus(engine, version), supported = versionCheck.status === "supported";
    if (platform !== "darwin") return { engine, matrixVersion: 1, platform, detectedVersion: version, capability: "read-only", verification: version ? "disk-only" : "unavailable", reason: "v1 仅允许 macOS Skill 写操作", supportedVersionRange: matrix.label, versionStatus: version ? (supported ? "supported" : "unsupported") : "unknown" };
    if (!version) return { engine, matrixVersion: 1, platform, detectedVersion: null, capability: "unknown", verification: "unavailable", reason: "无法确认引擎版本，已降级为只读", supportedVersionRange: matrix.label, versionStatus: "unknown" };
    if (!supported) return { engine, matrixVersion: 1, platform, detectedVersion: version, capability: "read-only", verification: "disk-only", reason: `引擎版本超出兼容范围 ${matrix.label}`, supportedVersionRange: matrix.label, versionStatus: "unsupported" };
    return { engine, matrixVersion: 1, platform, detectedVersion: version, capability: "read-write", verification: "disk-only", reason: null, supportedVersionRange: matrix.label, versionStatus: "supported" };
  });
}

const root = (value: Omit<SkillRoot, "id" | "mutationCapability" | "capabilityReason"> & Partial<Pick<SkillRoot, "mutationCapability" | "capabilityReason">>): SkillRoot => ({ id: createHash("sha256").update(`${value.engine}\0${value.scope}\0${resolve(value.path)}`).digest("hex").slice(0, 24), mutationCapability: value.protected ? "read-only" : "read-write", capabilityReason: value.protected ? "engine-owned protected root" : null, ...value });

export function skillRoots(options: SkillScanOptions): SkillRoot[] {
  const home = resolve(options.home);
  const codexHome = resolve(options.codexHome || join(home, ".codex"));
  const roots: SkillRoot[] = [
    root({ engine: "claude", path: join(home, ".claude", "skills"), scope: "user", protected: false, precedence: 0, precedenceStatus: "declared" }),
    root({ engine: "codex", path: join(home, ".agents", "skills"), scope: "user", protected: false, precedence: null, precedenceStatus: "unknown", mutationCapability: "explicit-only", capabilityReason: "Codex user root precedence is unknown; select this root explicitly" }),
    root({ engine: "codex", path: join(codexHome, "skills"), scope: "user", protected: false, precedence: null, precedenceStatus: "unknown", mutationCapability: "explicit-only", capabilityReason: "Codex user root precedence is unknown; select this root explicitly" }),
    root({ engine: "codex", path: join(codexHome, "skills", ".system"), scope: "system", protected: true, precedence: 0, precedenceStatus: "declared" }),
    root({ engine: "codex", path: join(codexHome, "plugins", "cache"), scope: "plugin", protected: true, precedence: 0, precedenceStatus: "declared" }),
    root({ engine: "codebuddy", path: join(home, ".codebuddy", "skills"), scope: "user", protected: false, precedence: 0, precedenceStatus: "declared" }),
  ];
  for (const project of options.projectRoots || []) {
    const base = resolve(project);
    roots.push(
      root({ engine: "claude", path: join(base, ".claude", "skills"), scope: "project", protected: false, precedence: 0, precedenceStatus: "declared" }),
      root({ engine: "codex", path: join(base, ".agents", "skills"), scope: "project", protected: false, precedence: 0, precedenceStatus: "declared" }),
      root({ engine: "codebuddy", path: join(base, ".codebuddy", "skills"), scope: "project", protected: false, precedence: 0, precedenceStatus: "declared" }),
    );
  }
  return roots;
}
