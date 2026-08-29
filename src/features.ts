// 功能开关：系统设置页可配的后台功能总闸，默认全开。持久化 data/features.json。
// 读侧：daemon 各 sweep 入口（capture/midday）；写侧：POST /api/features。
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir } from "./util.ts";

const FILE = join(DATA, "features.json");

export const FEATURE_DEFAULTS = { capture: true, digest: true } as const;
export type FeatureKey = keyof typeof FEATURE_DEFAULTS;

/** 读全部开关：文件不存在/坏/缺键都回落默认值（默认全开） */
export function featureFlags(file = FILE): Record<FeatureKey, boolean> {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* 不存在/坏了都按默认全开 */ }
  return Object.fromEntries(
    Object.entries(FEATURE_DEFAULTS).map(([k, d]) => [k, typeof saved?.[k] === "boolean" ? saved[k] : d]),
  ) as Record<FeatureKey, boolean>;
}

export function featureEnabled(key: FeatureKey): boolean {
  return featureFlags()[key];
}

export function setFeature(key: FeatureKey, enabled: boolean, file = FILE): Record<FeatureKey, boolean> {
  if (!(key in FEATURE_DEFAULTS)) throw new Error(`unknown feature: ${key}`);
  const flags = { ...featureFlags(file), [key]: enabled };
  ensureDir(DATA);
  writeFileSync(file, JSON.stringify(flags, null, 2));
  return flags;
}
