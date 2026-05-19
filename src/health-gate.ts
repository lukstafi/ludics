// Activity-volume gate for periodic Mag skills.
//
// Originally a single-purpose gate for the morning health check; now a
// generalized gate that handles four signal modes:
//   - "count":            health-check (lines appended to events.jsonl).
//   - "fingerprint":      adopt-sessions (unclassified-sessions hash).
//   - "activity-window":  briefing (last-user-action epoch within 18h window).
//   - "epoch-unchanged":  verify-completion (per-task last-activity epoch).
//
// gh-ludics-538 generalized the gate. shouldSkipHealthCheck is preserved as a
// thin wrapper over shouldSkipPeriodic so existing callers/tests see no diff.

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { harnessDir } from "./config.ts";

export const HEALTH_GATE_THRESHOLD = 300;

// Periodic actions Mag self-enqueues. Excluded from the user-action signal so
// the gate's own follow-ups (briefing → feedback-digest, health-check → /compact,
// hourly keepalive nags) cannot reset the briefing clock.
export const MAG_AUTO_ACTIONS: readonly string[] = [
  "briefing",
  "feedback-digest",
  "health-check",
  "adopt-sessions",
  "verify-completion",
  "sync-learnings",
];

// For action="message" enqueues, the content distinguishes Mag-auto (e.g.
// "/compact" after a checkpoint) from user-initiated messages. Compared
// against the additive `messageContent` field on `queue_request` events
// (see src/queue.ts buildQueueRequestEvent).
export const MAG_AUTO_MESSAGE_CONTENTS: readonly string[] = ["/compact"];

// Legacy substring fallback for excluding gate-self-telemetry from the
// count signal. Retained alongside the unified `meta.gateSkip` JSON marker
// so events written before the v2 upgrade continue to be excluded.
const GATE_INTERNAL_EVENT_MARKERS: readonly string[] = [
  '"event_type":"health_check_skipped"',
  '"event_type":"briefing_skipped"',
  '"event_type":"feedback_digest_skipped"',
  '"event_type":"adopt_sessions_skipped"',
  '"event_type":"verify_completion_skipped"',
];

/** True if the parsed event record is one of Mag's own enqueues. For
 *  action="message" records, requires a known auto-content match — a missing
 *  `messageContent` field (pre-upgrade events) fails open to "user action"
 *  so the gate never false-skips on uncertain provenance. */
export function isMagAutoAction(eventRecord: Record<string, unknown>): boolean {
  const action = typeof eventRecord.action === "string" ? eventRecord.action : "";
  if (!action) return false;
  if (MAG_AUTO_ACTIONS.includes(action)) return true;
  if (action === "message") {
    const content = eventRecord.messageContent;
    if (typeof content !== "string") return false;
    return MAG_AUTO_MESSAGE_CONTENTS.includes(content);
  }
  return false;
}

function lineIsGateSkip(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const meta = (parsed as Record<string, unknown>).meta;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>).gateSkip === true) {
    return true;
  }
  return false;
}

/** Count event lines eligible for the gate signal.
 *  Primary path: parse each line as JSON, exclude records with
 *  `meta.gateSkip === true`. Falls back to GATE_INTERNAL_EVENT_MARKERS
 *  substring match for pre-upgrade lines lacking the marker. Returns null
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
          // Primary JSON-aware exclusion via meta.gateSkip.
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (lineIsGateSkip(parsed)) excluded = true;
          } catch { /* not JSON — fall through to substring fallback */ }
          if (!excluded) {
            for (const marker of GATE_INTERNAL_EVENT_MARKERS) {
              if (line.includes(marker)) { excluded = true; break; }
            }
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

// --- Snapshot envelope (shared across modes) -----------------------------

interface GateSnapshot<T = unknown> {
  hadFile: boolean;
  hadSignal: boolean;
  signal: T | null;
}

function readSnapshot<T>(snapshotPath: string): GateSnapshot<T> {
  if (!existsSync(snapshotPath)) return { hadFile: false, hadSignal: false, signal: null };
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return { hadFile: true, hadSignal: false, signal: null };
    if ("signal" in parsed && parsed.signal !== undefined && parsed.signal !== null) {
      return { hadFile: true, hadSignal: true, signal: parsed.signal as T };
    }
    // Legacy back-compat: mag/health-last.json with `eventsJsonlLines` and
    // no top-level `signal` field. The wrapper paths it through.
    if (typeof parsed.eventsJsonlLines === "number" && Number.isFinite(parsed.eventsJsonlLines)) {
      return { hadFile: true, hadSignal: true, signal: parsed.eventsJsonlLines as unknown as T };
    }
    return { hadFile: true, hadSignal: false, signal: null };
  } catch {
    return { hadFile: true, hadSignal: false, signal: null };
  }
}

/** Write the snapshot envelope. Caller is responsible for refreshing the
 *  snapshot only when the gate has decided to RUN (not skip). */
export function writeGateSnapshot(snapshotPath: string, signal: unknown, now?: Date): void {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const ts = (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const body: Record<string, unknown> = { timestamp: ts, signal };
  // Preserve the legacy field for the health-check arm so out-of-process
  // readers that still expect `eventsJsonlLines` continue to work.
  if (typeof signal === "number") body.eventsJsonlLines = signal;
  writeFileSync(snapshotPath, JSON.stringify(body));
}

// --- Generalized gate ----------------------------------------------------

export type GateMode = "count" | "fingerprint" | "activity-window" | "epoch-unchanged";

export interface PeriodicGateOptions {
  gateName: string;
  snapshotPath: string;        // absolute path to JSON snapshot file
  signal: unknown | (() => unknown);
  threshold: number;           // count: line delta; window: seconds; others: ignored
  mode: GateMode;
  now?: Date;
}

export interface PeriodicGateDecision {
  skip: boolean;
  reason: string;
  current: unknown;
  prior: unknown;
}

/** Generalized gate dispatch. The semantics per mode are documented in
 *  docs/proposals/activity-gate-periodic-skills.md AC 1 (and gh-ludics-538). */
export function shouldSkipPeriodic(opts: PeriodicGateOptions): PeriodicGateDecision {
  const now = opts.now ?? new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const current = typeof opts.signal === "function" ? (opts.signal as () => unknown)() : opts.signal;
  const snap = readSnapshot<unknown>(opts.snapshotPath);

  // Fail-open: signal unreadable.
  if (current === null) {
    return { skip: false, reason: "signal unreadable — fail open", current: null, prior: snap.signal };
  }
  // Fail-open: first run (no snapshot file).
  if (!snap.hadFile) {
    return { skip: false, reason: "first run — no prior snapshot", current, prior: null };
  }
  if (!snap.hadSignal) {
    return { skip: false, reason: "prior snapshot missing signal field — fail open", current, prior: null };
  }

  switch (opts.mode) {
    case "count": {
      const cur = current as number;
      const prior = snap.signal as number;
      const delta = cur - prior;
      if (delta < 0) {
        return { skip: false, reason: `events.jsonl line count went backward (delta ${delta}) — anchor stale, fail open`, current: cur, prior };
      }
      if (delta < opts.threshold) {
        return { skip: true, reason: `delta ${delta} < ${opts.threshold} threshold`, current: cur, prior };
      }
      return { skip: false, reason: `delta ${delta} >= ${opts.threshold} threshold`, current: cur, prior };
    }
    case "fingerprint": {
      const cur = current as string;
      const prior = snap.signal as string;
      if (cur === prior) {
        return { skip: true, reason: "fingerprint unchanged", current: cur, prior };
      }
      return { skip: false, reason: "fingerprint changed", current: cur, prior };
    }
    case "activity-window": {
      // current === 0: clean scan, no qualifying activity in the look-back.
      // With a prior snapshot present, this is the proposal's core skip case.
      if (current === 0) {
        return { skip: true, reason: "no qualifying user activity since prior snapshot", current: 0, prior: snap.signal };
      }
      const cur = current as number;
      const prior = snap.signal as number;
      if (prior > nowEpoch) {
        return { skip: false, reason: "prior snapshot epoch in future — clock skew, fail open", current: cur, prior };
      }
      if (cur > prior) {
        return { skip: false, reason: "new user activity since prior snapshot", current: cur, prior };
      }
      // cur <= prior — no progress. Skip only if also outside the recent-activity window.
      const age = nowEpoch - cur;
      if (age < opts.threshold) {
        return { skip: false, reason: `recent activity (${age}s ago) within ${opts.threshold}s window`, current: cur, prior };
      }
      return { skip: true, reason: `no progress since prior snapshot and latest activity ${age}s ago >= ${opts.threshold}s threshold`, current: cur, prior };
    }
    case "epoch-unchanged": {
      // current === 0 with prior snapshot present: clean sources returned no
      // activity for this target since we last checked — that IS "no advance",
      // so skip. (Read-error returns null, which fails open above.)
      const cur = (current as number) | 0;
      const prior = snap.signal as number;
      if (cur === 0) {
        return { skip: true, reason: "no activity epoch resolvable for this target since prior snapshot", current: 0, prior };
      }
      if (cur <= prior) {
        return { skip: true, reason: `epoch ${cur} <= prior ${prior} — unchanged`, current: cur, prior };
      }
      return { skip: false, reason: `epoch ${cur} > prior ${prior} — advanced`, current: cur, prior };
    }
  }
}

// --- Compatibility wrapper: shouldSkipHealthCheck ------------------------

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

export function shouldSkipHealthCheck(opts: HealthGateOptions = {}): HealthGateDecision {
  const stateDir = opts.stateDir ?? harnessDir();
  const eventsFile = join(stateDir, "journal", "events.jsonl");
  const snapshotPath = join(stateDir, "mag", "health-last.json");

  const count = countGateEligibleLines(eventsFile);
  if (count === null) {
    return { skip: false, reason: "events.jsonl missing — fail open", currentLines: 0, priorLines: 0 };
  }
  if (count === 0) {
    return { skip: false, reason: "events.jsonl empty — fail open", currentLines: 0, priorLines: 0 };
  }

  const decision = shouldSkipPeriodic({
    gateName: "health-check",
    snapshotPath,
    signal: count,
    threshold: HEALTH_GATE_THRESHOLD,
    mode: "count",
    now: opts.now,
  });
  const currentLines = typeof decision.current === "number" ? decision.current : count;
  const priorLines = typeof decision.prior === "number" ? decision.prior : 0;
  return { skip: decision.skip, reason: decision.reason, currentLines, priorLines };
}

// --- User-action signal helper (briefing) --------------------------------

export interface UserActionSignalOptions {
  stateDir: string;
  now: Date;
  lookbackHours: number;
}

/** Compute the max epoch across qualifying user activity sources in the
 *  look-back window. Three-valued return:
 *    number  — Unix epoch of the latest qualifying activity.
 *    0       — clean scan, no qualifying activity found in the window.
 *    null    — at least one input source threw / was unreadable.
 *
 *  Sources: notify_incoming events, queue_request events (excluding
 *  Mag-auto actions), non-Mag-authored commits touching tasks/*.md.
 *  Excludes events bearing meta.gateSkip === true. */
export function latestUserActionEpoch(opts: UserActionSignalOptions): number | null {
  const nowEpoch = Math.floor(opts.now.getTime() / 1000);
  const horizon = nowEpoch - opts.lookbackHours * 3600;
  let best = 0;
  let sawError = false;

  // Source 1+2: events.jsonl (notify_incoming + non-auto queue_request).
  const eventsFile = join(opts.stateDir, "journal", "events.jsonl");
  if (existsSync(eventsFile)) {
    try {
      const buf = readFileSync(eventsFile, "utf8");
      const lines = buf.length > 0 ? buf.split("\n") : [];
      for (const line of lines) {
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          const raw = JSON.parse(line) as unknown;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          parsed = raw as Record<string, unknown>;
        } catch { continue; }
        if (lineIsGateSkip(parsed)) continue;
        const epoch = readEventEpoch(parsed);
        if (epoch === null || epoch < horizon) continue;
        const eventType = typeof parsed.event_type === "string" ? parsed.event_type : "";
        if (eventType === "notify_incoming") {
          if (epoch > best) best = epoch;
        } else if (eventType === "queue_request") {
          if (!isMagAutoAction(parsed) && epoch > best) best = epoch;
        }
      }
    } catch {
      sawError = true;
    }
  }
  // If the events file is absent, treat as "clean empty scan" (not error).

  // Source 3: non-Mag-authored commits to tasks/*.md. Conservative proxy
  // per docs/proposals/activity-gate-periodic-skills.md Gap C — every
  // commit touching tasks/ counts (no author filter), since the state-repo's
  // task frontmatter is user-edited in practice.
  const tasksDir = join(opts.stateDir, "tasks");
  if (existsSync(tasksDir)) {
    try {
      const res = spawnSync("git", [
        "log",
        `--since=${opts.lookbackHours} hours ago`,
        "--format=%at",
        "--",
        "tasks/",
      ], { cwd: opts.stateDir, encoding: "utf8", timeout: 5000 });
      if (res.status === 0 && typeof res.stdout === "string") {
        for (const line of res.stdout.trim().split("\n")) {
          const epoch = Number.parseInt(line, 10);
          if (Number.isFinite(epoch) && epoch >= horizon && epoch > best) {
            best = epoch;
          }
        }
      } else if (res.status !== null && res.status !== 0) {
        // git ran but returned non-zero (not a repo / bad ref) — count as error.
        sawError = true;
      }
    } catch {
      sawError = true;
    }
  }

  if (best > 0) return best;
  if (sawError) return null;
  return 0;
}

function readEventEpoch(parsed: Record<string, unknown>): number | null {
  // Primary canonical field is `epoch: number` (src/events.ts).
  if (typeof parsed.epoch === "number" && Number.isFinite(parsed.epoch)) {
    return parsed.epoch;
  }
  // Defensive fallback: parse ISO `ts` if present.
  if (typeof parsed.ts === "string") {
    const ms = Date.parse(parsed.ts);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}
