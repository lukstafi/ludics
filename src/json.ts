// Shared JSON file helpers — atomic write with retry on transient ENOENT.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  const data = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${path}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, data);
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
