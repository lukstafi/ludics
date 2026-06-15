// Shared cause/remedy metadata + latest-event reader for outbound
// staging→upstream push failures (task-35e74651).
//
// Neutral module: imports only `fs` + the pure `isPlainObject` helper. It
// deliberately does NOT import `./events.ts` (and is not imported by it) or
// `./briefing-lag.ts` (which `./staging-ff.ts` already imports — a cycle).
// Both the event emitter (`src/staging-ff.ts`) and the annotator
// (`src/briefing-lag.ts`) import the cause/remedy map from here so the
// strings stay in sync, keyed by event type.

import { existsSync, readFileSync } from "fs";
import { isPlainObject } from "./json.ts";

// Shared prefix that all outbound staging→upstream event types carry.
// Used by `outboundActivitySince` to detect any push-tick activity without
// enumerating every outcome type.
const OUTBOUND_EVENT_PREFIX = "staging_outbound_";

export interface OutboundCauseRemedy {
  cause: string;
  remedy: string;
}

/**
 * Cause + remedy strings for the two surfaced outbound push-auth failure
 * classes, keyed by the persisted event type. The emitter builds its event
 * message from these (so the remedy is copy-pasteable in the events log) and
 * the briefing-lag stale-sentinel annotation reads the same strings — a
 * single source of truth keeps the two surfaces in sync.
 */
export const OUTBOUND_EVENT_CAUSE_REMEDY: Record<string, OutboundCauseRemedy> = {
  staging_outbound_workflow_scope_missing: {
    cause: "push token lacks `workflow` scope",
    remedy: "gh auth refresh -h github.com -s workflow",
  },
  staging_outbound_credentials_missing: {
    cause: "missing/invalid push credentials",
    remedy: "refresh the push credentials (gh auth login / update the stored token)",
  },
};

/**
 * Remedy string for the "no push attempts" case: the outbound sentinel is
 * stale but there are zero `staging_outbound_*` events in the window, meaning
 * the once-daily outbound tick never ran (controller/keepalive downtime) rather
 * than an auth failure. Single-sourced here beside `OUTBOUND_EVENT_CAUSE_REMEDY`
 * so all remedy strings live in one module (task-c4aedd6b).
 */
export const NO_ATTEMPTS_REMEDY =
  "no outbound push attempts since <sentinel time> — the once-daily outbound tick is not running; verify the controller/keepalive is alive";

/**
 * Remedy string for the "blocked worktree" case: the tick ran but the staging
 * worktree was dirty, so the push was skipped. Single-sourced here beside
 * `NO_ATTEMPTS_REMEDY` / `OUTBOUND_EVENT_CAUSE_REMEDY` (task-cabf6402).
 */
export const BLOCKED_WORKTREE_REMEDY =
  "the outbound tick is skipping because `~/<repo>` has a dirty worktree — commit, stash, or clean `~/<repo>` so the push can run";

/** Discriminated union returned by `classifyOutboundStaleness`. */
export type OutboundStaleClassification =
  | { kind: "auth"; cause: string; remedy: string }
  | { kind: "no-attempts"; remedy: string }
  | { kind: "blocked-worktree"; remedy: string }
  | { kind: "unknown" };

/**
 * Return the cause/remedy for the most recent outbound push-auth event for
 * `project` in the JSONL events file at `eventsFile`, or `null` when none
 * matches.
 *
 * Matching: an event qualifies when its `event_type` is one of the keys of
 * `OUTBOUND_EVENT_CAUSE_REMEDY` AND it belongs to `project`. Project match
 * prefers the structured `project` field (persisted by the Mag adapter in
 * `runStagingOutboundPushTick`); it falls back to a `"<project>:"` message
 * prefix so events emitted before the structured field existed still resolve.
 * The newest qualifying event wins (max numeric `epoch`; later line breaks
 * ties / missing epochs).
 *
 * `opts.sinceEpoch`: when set, events with `epoch < sinceEpoch` are ignored.
 * Callers pass the outbound sentinel mtime here so a stale sentinel is only
 * annotated with an auth failure that occurred *after* the last successful /
 * error tick — an obsolete failure that predates a later success (and a
 * sentinel that went stale for an unrelated reason, e.g. missed keepalive
 * ticks) must not surface a no-longer-applicable remedy. An event with no
 * usable `epoch` (treated as 0) is dropped under a positive `sinceEpoch`,
 * since it cannot be proven newer than the boundary.
 *
 * Best-effort: a missing/empty/unparseable file yields `null` rather than
 * throwing — this feeds an informational briefing annotation, never a gate.
 */
export function latestOutboundCauseRemedy(
  eventsFile: string,
  project: string,
  opts?: { sinceEpoch?: number },
): OutboundCauseRemedy | null {
  const sinceEpoch = opts?.sinceEpoch;
  let content: string;
  try {
    if (!existsSync(eventsFile)) return null;
    content = readFileSync(eventsFile, "utf-8");
  } catch {
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) return null;

  let best: { epoch: number; order: number; type: string } | null = null;
  let order = 0;
  for (const line of trimmed.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const type = typeof parsed.event_type === "string" ? parsed.event_type : "";
    if (!(type in OUTBOUND_EVENT_CAUSE_REMEDY)) continue;
    // Project match: structured field first, message-prefix fallback.
    const structured = typeof parsed.project === "string" ? parsed.project : null;
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const matches = structured === project || message.startsWith(`${project}:`);
    if (!matches) continue;
    const epoch = typeof parsed.epoch === "number" && Number.isFinite(parsed.epoch) ? parsed.epoch : 0;
    // Drop failures that predate the sentinel boundary (last successful/error
    // tick) — they're obsolete once a later success or unrelated staleness
    // occurred. `order++` still advances so tie-break ordering is unaffected.
    if (sinceEpoch !== undefined && epoch < sinceEpoch) { order++; continue; }
    const cur = { epoch, order: order++, type };
    if (
      best === null ||
      cur.epoch > best.epoch ||
      (cur.epoch === best.epoch && cur.order > best.order)
    ) {
      best = cur;
    }
  }
  if (!best) return null;
  return OUTBOUND_EVENT_CAUSE_REMEDY[best.type] ?? null;
}

/**
 * Return true when any `staging_outbound_*` event for `project` exists in the
 * events file with `epoch >= sinceEpoch`. Used by `classifyOutboundStaleness`
 * to distinguish "tick ran but produced no auth failure" from "tick never ran".
 *
 * Matches all `staging_outbound_` event types (not just auth failures) so new
 * outcome types added to `src/staging-ff.ts` are covered automatically.
 * Best-effort: missing/empty/unparseable file → false.
 */
export function outboundActivitySince(
  eventsFile: string,
  project: string,
  sinceEpoch: number,
): boolean {
  let content: string;
  try {
    if (!existsSync(eventsFile)) return false;
    content = readFileSync(eventsFile, "utf-8");
  } catch {
    return false;
  }
  const trimmed = content.trim();
  if (!trimmed) return false;

  for (const line of trimmed.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const type = typeof parsed.event_type === "string" ? parsed.event_type : "";
    if (!type.startsWith(OUTBOUND_EVENT_PREFIX)) continue;
    const structured = typeof parsed.project === "string" ? parsed.project : null;
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const matches = structured === project || message.startsWith(`${project}:`);
    if (!matches) continue;
    const epoch = typeof parsed.epoch === "number" && Number.isFinite(parsed.epoch) ? parsed.epoch : 0;
    if (epoch >= sinceEpoch) return true;
  }
  return false;
}

/**
 * Return true when ALL in-window `staging_outbound_*` events for `project`
 * are of type `staging_outbound_skipped_dirty` (and at least one exists).
 * Used by `classifyOutboundStaleness` to distinguish a persistently dirty
 * worktree (tick ran but was blocked) from a real push attempt or error.
 * Best-effort: missing/empty/unparseable file → false.
 */
function isExclusivelyDirtySkipActivity(
  eventsFile: string,
  project: string,
  sinceEpoch: number,
): boolean {
  let content: string;
  try {
    if (!existsSync(eventsFile)) return false;
    content = readFileSync(eventsFile, "utf-8");
  } catch {
    return false;
  }
  const trimmed = content.trim();
  if (!trimmed) return false;

  let hasAny = false;
  for (const line of trimmed.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const type = typeof parsed.event_type === "string" ? parsed.event_type : "";
    if (!type.startsWith(OUTBOUND_EVENT_PREFIX)) continue;
    const structured = typeof parsed.project === "string" ? parsed.project : null;
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const matches = structured === project || message.startsWith(`${project}:`);
    if (!matches) continue;
    const epoch = typeof parsed.epoch === "number" && Number.isFinite(parsed.epoch) ? parsed.epoch : 0;
    // Use strict > so the sentinel-creating event (success/error, epoch === sinceEpoch)
    // is excluded. Only post-sentinel dirty-skip events count for blocked-worktree.
    if (epoch <= sinceEpoch) continue;
    hasAny = true;
    if (type !== "staging_outbound_skipped_dirty") return false;
  }
  return hasAny;
}

/**
 * Classify why the outbound staging→upstream sentinel is stale, given the
 * events file, project name, and the `sinceEpoch` boundary (floor of sentinel
 * mtime / 1000; pass 0 to scan the whole file when the sentinel is missing).
 *
 * Returns:
 *   - `{ kind: "auth", cause, remedy }` when a recent outbound auth failure
 *     event exists in the window (workflow-scope or credentials gap).
 *   - `{ kind: "no-attempts", remedy }` when no `staging_outbound_*` events
 *     exist for the project in the window — the tick never ran (downtime).
 *   - `{ kind: "blocked-worktree", remedy }` when the only in-window activity
 *     is `staging_outbound_skipped_dirty` — the tick ran but the staging
 *     worktree was dirty; the operator should commit / stash / clean it.
 *   - `{ kind: "unknown" }` when outbound events exist but none are auth
 *     failures and not all are dirty-skip — stay conservative, emit no
 *     annotation.
 *
 * Pure given (eventsFile contents, project, sinceEpoch): no harness paths
 * resolved here. The caller (`ludics mag outbound-cause-remedy`) resolves
 * paths and computes sinceEpoch from the sentinel mtime.
 */
export function classifyOutboundStaleness(
  eventsFile: string,
  project: string,
  sinceEpoch: number,
): OutboundStaleClassification {
  const auth = latestOutboundCauseRemedy(eventsFile, project, { sinceEpoch });
  if (auth !== null) {
    return { kind: "auth", cause: auth.cause, remedy: auth.remedy };
  }
  const hasActivity = outboundActivitySince(eventsFile, project, sinceEpoch);
  if (!hasActivity) {
    return { kind: "no-attempts", remedy: NO_ATTEMPTS_REMEDY };
  }
  if (isExclusivelyDirtySkipActivity(eventsFile, project, sinceEpoch)) {
    return { kind: "blocked-worktree", remedy: BLOCKED_WORKTREE_REMEDY };
  }
  return { kind: "unknown" };
}
