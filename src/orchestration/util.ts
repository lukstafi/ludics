import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

const SCRIPT_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "task";
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function ludicsSelfCommand(args: string[]): string[] {
  const entry = process.argv[1];
  if (entry && SCRIPT_EXT_RE.test(entry) && existsSync(entry)) {
    if (process.execPath.toLowerCase().endsWith("bun")) {
      return [process.execPath, "run", entry, ...args];
    }
    return [process.execPath, entry, ...args];
  }
  return [process.execPath, ...args];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when `completedAt` represents a point in time that is at or
 * after `dispatchedAt`, comparing the two ISO 8601 strings as Date values.
 *
 * String comparison is intentionally avoided: ISO variants with milliseconds
 * (e.g. "2026-03-21T17:22:43.500Z") sort *before* the same second without
 * milliseconds ("2026-03-21T17:22:43Z") lexicographically, which would
 * incorrectly classify a freshly-completed turn as stale.
 *
 * Returns true when `dispatchedAt` is null/undefined (no constraint) and
 * false when `completedAt` is null/undefined (no completion recorded yet).
 */
export function isTurnFresh(
  dispatchedAt: string | null | undefined,
  completedAt: string | null | undefined,
): boolean {
  if (!dispatchedAt) return true;
  if (!completedAt) return false;
  return Date.parse(completedAt) >= Date.parse(dispatchedAt);
}
