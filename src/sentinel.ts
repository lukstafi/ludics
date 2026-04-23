// Unified sentinel-file primitives used across mag.ts + staging-ff.ts for
// freshness-windowed throttles (epoch text files) and boolean presence
// markers. All writes are best-effort: a failed sentinel write just means
// the next tick may run again.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * True iff the sentinel file exists and its mtime is within `windowSec`
 * seconds of `now`. Missing / unreadable files return false (fail-open:
 * caller proceeds as if no throttle is active).
 */
export function sentinelFresh(path: string, now: Date, windowSec: number): boolean {
  if (!existsSync(path)) return false;
  try {
    const mtime = statSync(path).mtimeMs;
    const ageSec = (now.getTime() - mtime) / 1000;
    return ageSec < windowSec;
  } catch {
    return false;
  }
}

/**
 * Read the epoch stored in a sentinel file. Returns null when the file is
 * missing, unreadable, or contains a non-positive / non-finite integer
 * (the conservative policy that matches the former readEpochFile site).
 */
export function readSentinelEpoch(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const epoch = parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
  } catch {
    return null;
  }
}

/**
 * Write the current epoch into `path`, creating parent directories as
 * needed. `now` defaults to new Date() for callers that don't already have
 * a Date value in hand. Failures are swallowed — sentinel writes are
 * best-effort.
 */
export function touchSentinel(path: string, now?: Date): void {
  const when = now ?? new Date();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Parent dir may already exist; that's fine.
  }
  try {
    writeFileSync(path, String(Math.floor(when.getTime() / 1000)));
    utimesSync(path, when, when);
  } catch {
    // Best-effort; a missed write means the next tick may run again.
  }
}

/** Unlink the sentinel if present; swallow errors. */
export function clearSentinel(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Absent-or-unremovable: either way, there's nothing more we can do.
  }
}

/** Presence-only check for boolean sentinels (e.g. mag/settled). */
export function sentinelExists(path: string): boolean {
  return existsSync(path);
}
