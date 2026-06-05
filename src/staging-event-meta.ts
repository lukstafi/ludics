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
