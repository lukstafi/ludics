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
 * Build a command array that runs in its own session, immune to SIGHUP
 * when the parent exits.  Accepts an optional resolved setsid path so
 * callers (and tests) can control which branch is taken.
 *
 * - Linux: prepend the setsid binary.
 * - macOS (no setsid binary): use perl POSIX::setsid as a fallback.
 */
export function setsidWrap(
  command: string[],
  resolvedSetsid?: string | null,
): string[] {
  const setsidBin = resolvedSetsid !== undefined
    ? resolvedSetsid
    : (Bun.which("setsid") ?? null);
  if (setsidBin) {
    return [setsidBin, ...command];
  }
  return [
    "perl", "-e",
    "use POSIX qw(setsid); setsid(); exec @ARGV",
    "--",
    ...command,
  ];
}

