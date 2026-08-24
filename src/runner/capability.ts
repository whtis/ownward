import { modeBitsClear, ownedByCurrentUser } from "../posix-owner.ts";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "fs";
import { fsyncSync } from "../fs-durable.ts";
import { join } from "path";
import { timingSafeEqual } from "crypto";

export function runnerPaths(dataRoot: string) { const dir = join(dataRoot, "runner"); return { dir, socket: join(dir, "runner.sock"), token: join(dir, "capability-token") }; }

export function ensureRunnerCapability(dataRoot: string): string {
  const { dir, token } = runnerPaths(dataRoot); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const directory = lstatSync(dir); if (!directory.isDirectory() || !ownedByCurrentUser(directory)) throw new Error("Runner 目录所有权非法");
  if (existsSync(token)) return readRunnerCapability(dataRoot);
  const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), tmp = join(dir, `.capability.${process.pid}.${crypto.randomUUID()}.tmp`), fd = openSync(tmp, "wx", 0o600);
  try { const bytes = Buffer.from(value); let offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written <= 0) throw new Error("Runner capability 短写入"); offset += written; } fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(token)) { unlinkSync(tmp); return readRunnerCapability(dataRoot); }
  renameSync(tmp, token); const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } return value;
}

export function readRunnerCapability(dataRoot: string): string {
  const paths = runnerPaths(dataRoot), directory = lstatSync(paths.dir);
  if (!directory.isDirectory() || !ownedByCurrentUser(directory) || !modeBitsClear(directory, 0o077)) throw new Error("Runner 目录权限或所有权非法");
  const file = paths.token, stat = lstatSync(file);
  if (!stat.isFile() || !ownedByCurrentUser(stat) || !modeBitsClear(stat, 0o077)) throw new Error("Runner capability 权限或所有权非法");
  const value = readFileSync(file, "utf8").trim(); if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Runner capability 文件损坏"); return value;
}
export function capabilityMatches(expected: string, provided: string): boolean { const a = Buffer.from(expected), b = Buffer.from(provided); return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
