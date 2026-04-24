// Shared JSON file helpers — atomic write with retry on transient ENOENT.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Atomic write-to-temp + rename. Use for any state file where a crash
 * mid-write must not leave a truncated or corrupt target. Retries once on
 * ENOENT to cover concurrent directory-removal races (e.g., git checkout).
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, content);
    try {
      renameSync(tmp, path);
      return;
    } catch (err: unknown) {
      if (attempt === 0 && err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        // Directory or tmp file disappeared between write and rename
        // (e.g., concurrent git operation). Retry once.
        continue;
      }
      throw err;
    }
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeJsonFileCompact(path: string, value: unknown): void {
  atomicWriteFileSync(path, JSON.stringify(value) + "\n");
}
