// Activity-volume gate for the periodic health check.
//
// Counts lines appended to journal/events.jsonl since the last executed
// health check (recorded as eventsJsonlLines in mag/health-last.json). Skips
// the check when fewer than HEALTH_GATE_THRESHOLD new lines have accumulated.

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { harnessDir } from "./config.ts";

export const HEALTH_GATE_THRESHOLD = 50;

// Event types emitted by the gate itself — excluded from the line-delta
// signal so self-generated telemetry cannot push future ticks over the
// threshold on an otherwise-idle system.
const GATE_INTERNAL_EVENT_MARKERS: readonly string[] = [
  '"event_type":"health_check_skipped"',
];

export interface HealthGateDecision {
  skip: boolean;
  reason: string;
  currentLines: number;
  priorLines: number;
}

export interface HealthGateOptions {
  now?: Date;
  stateDir?: string;
}

/** Count event lines eligible for the gate signal.
 *  Excludes lines containing any GATE_INTERNAL_EVENT_MARKERS so the gate's
 *  own skip telemetry cannot influence its future decisions. Returns null
 *  on read error, 0 on empty/missing file. */
export function countGateEligibleLines(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return 0;
    const buf = readFileSync(path, "utf8");
    if (buf.length === 0) return 0;

    let count = 0;
    let lineStart = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf.charCodeAt(i) === 10) {
        if (i > lineStart) {
          const line = buf.slice(lineStart, i);
          let excluded = false;
          for (const marker of GATE_INTERNAL_EVENT_MARKERS) {
            if (line.includes(marker)) { excluded = true; break; }
          }
          if (!excluded) count++;
        }
        lineStart = i + 1;
      }
    }
    return count;
  } catch {
    return null;
  }
}

function readPriorLines(stateDir: string): { value: number | null; hadFile: boolean; hadField: boolean } {
  const snapPath = join(stateDir, "mag", "health-last.json");
  if (!existsSync(snapPath)) return { value: null, hadFile: false, hadField: false };
  try {
    const raw = readFileSync(snapPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { value: null, hadFile: true, hadField: false };
    const v = (parsed as Record<string, unknown>).eventsJsonlLines;
    if (typeof v !== "number" || !Number.isFinite(v)) return { value: null, hadFile: true, hadField: false };
    return { value: v, hadFile: true, hadField: true };
  } catch {
    return { value: null, hadFile: true, hadField: false };
  }
}

export function shouldSkipHealthCheck(opts: HealthGateOptions = {}): HealthGateDecision {
  const stateDir = opts.stateDir ?? harnessDir();
  const eventsFile = join(stateDir, "journal", "events.jsonl");

  const count = countGateEligibleLines(eventsFile);
  if (count === null) {
    return {
      skip: false,
      reason: "events.jsonl missing — fail open",
      currentLines: 0,
      priorLines: 0,
    };
  }
  if (count === 0) {
    return {
      skip: false,
      reason: "events.jsonl empty — fail open",
      currentLines: 0,
      priorLines: 0,
    };
  }

  const prior = readPriorLines(stateDir);
  if (!prior.hadFile) {
    return {
      skip: false,
      reason: "first run — no prior snapshot",
      currentLines: count,
      priorLines: 0,
    };
  }
  if (!prior.hadField || prior.value === null) {
    return {
      skip: false,
      reason: "prior snapshot missing eventsJsonlLines field",
      currentLines: count,
      priorLines: 0,
    };
  }

  const delta = count - prior.value;
  if (delta < 0) {
    // events.jsonl shrank vs the stored anchor (rotation, compaction, restore).
    // The anchor is no longer trustworthy — fail open so a real run resets it.
    return {
      skip: false,
      reason: `events.jsonl line count went backward (delta ${delta}) — anchor stale, fail open`,
      currentLines: count,
      priorLines: prior.value,
    };
  }
  if (delta < HEALTH_GATE_THRESHOLD) {
    return {
      skip: true,
      reason: `delta ${delta} < ${HEALTH_GATE_THRESHOLD} threshold`,
      currentLines: count,
      priorLines: prior.value,
    };
  }
  return {
    skip: false,
    reason: `delta ${delta} >= ${HEALTH_GATE_THRESHOLD} threshold`,
    currentLines: count,
    priorLines: prior.value,
  };
}
