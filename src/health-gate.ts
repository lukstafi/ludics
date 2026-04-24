// Activity-volume gate for the periodic health check.
//
// Counts lines appended to journal/events.jsonl since the last executed
// health check (recorded as eventsJsonlLines in mag/health-last.json). Skips
// the check when fewer than HEALTH_GATE_THRESHOLD new lines have accumulated.

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { harnessDir } from "./config.ts";

export const HEALTH_GATE_THRESHOLD = 50;

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

function countLines(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return 0;
    const buf = readFileSync(path, "utf8");
    if (buf.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.charCodeAt(i) === 10) n++;
    }
    if (buf.charCodeAt(buf.length - 1) !== 10) n++;
    return n;
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

  const count = countLines(eventsFile);
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
