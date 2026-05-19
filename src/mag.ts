// Mag session management — start/stop/status/attach/logs/doctor/briefing/queue

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { harnessDir, loadConfigSync, startSessionsAutonomy, slotsCount, effectivePriorityValue, milestonesEnabledProjects, resolveProjectPath, postponedProjectSet, findProjectConfigByName, type LudicsFullConfig } from "./config.ts";
import { formatUpstreamLagSection } from "./briefing-lag.ts";
import { defaultRunGit, type RunGit } from "./git-runner.ts";
import { clearSentinel, readSentinelEpoch, sentinelExists, sentinelFresh, touchSentinel } from "./sentinel.ts";
import { syncStagingMainWithUpstream, syncUpstreamMainFromStaging, type OutboundPushProjectResult } from "./staging-ff.ts";
import { atomicWriteFileSync, isPlainObject, writeJsonFile, writeJsonFileCompact } from "./json.ts";
import { listStashes } from "./slots/preempt.ts";
import { readAllSlotJson, readSlotJson } from "./slots/json.ts";
import type { SlotData } from "./slots/types.ts";
import { queueRequest, queuePending, queueHasPendingAction, queueHasPendingActionForTask, queueHasPendingFeedbackDigest, queueReinsertHead, queuePopExpected, queueList, recentResults } from "./queue.ts";
import { getUrl } from "./network.ts";
import { clusterShouldRunMag, clusterIsController, selectMachineForSlot, clusterCurrentMachineName } from "./cluster.ts";
// cluster-http imports are lazy to avoid import cycles
import { isRemoteMachine } from "./remote.ts";
// slot-intents.ts deleted — intents use in-memory store via cluster-http.ts
import { stateMarkDirty } from "./state.ts";
import { journalAppend } from "./journal.ts";
import { emitEvent } from "./events.ts";
import { readOrchestrationState } from "./orchestration/state.ts";
import { isElaborated } from "./tasks/elaboration.ts";
import { tasksAbandon } from "./tasks/index.ts";
import { buildAffinityLookup, type AffinityInput } from "./tasks/affinity.ts";
import {
  notifyOutgoing,
  expirePendingRevises,
  expirePendingFollowupRevises,
} from "./notify.ts";
import { updateFrontmatterField, removeFrontmatterField, parseTaskFrontmatter, priorityValue, TERMINAL_STATUSES } from "./tasks/markdown.ts";
import { slotAssign, slotClear, slotResume, slotStart, slotStop, taskCompleteDirectly, markSlotSetupFailed, findSlotForTask } from "./slots/index.ts";
import { expandDuoSlots } from "./slots/duo-expand.ts";
import { readSlotState } from "./t3code/server.ts";
import { captureLastMessage, captureLastMessageHash, readTmuxSlotState } from "./adapters/tmux-adapter.ts";
import { resolveSkillCommand, hasRegisteredAction } from "./skill-queue-registry.ts";
import { selectOrchestrationFlagsForTask } from "./adapters/t3code.ts";
import YAML from "yaml";
import {
  tmuxAvailable,
  tmuxHasSession,
  tmuxNewSession,
  tmuxKillSession,
  tmuxSendKeys,
  tmuxSendCommand,
  tmuxCapture,
  tmuxPanePid,
  tmuxPaneInMode,
  tmuxCancelMode,
  tmuxSwitchClient,
  tmuxRunShell,
} from "./adapters/tmux.ts";
import { safeSyncOutput } from "./spawn.ts";
import { ludicsSelfCommand } from "./orchestration/util.ts";

const MAG_SESSION_NAME = process.env.LUDICS_MAG_SESSION ?? "ludics-mag";
const MAG_DEFAULT_PORT = process.env.LUDICS_MAG_PORT ?? "7679";
const FEEDBACK_DIGEST_COOLDOWN_SECONDS = 120;
const BRIEFING_AUTO_COOLDOWN_SECONDS = 90 * 60;

function magStateDir(): string {
  return join(harnessDir(), "mag");
}

function magStateFile(): string {
  return join(magStateDir(), "session.state");
}

function magStatusFile(): string {
  return join(magStateDir(), "session.status");
}

function magIsRunning(): boolean {
  return tmuxHasSession(MAG_SESSION_NAME);
}

function claudeLaunchCommand(): string {
  // Default to continue mode (-c) for persistent Mag sessions.
  // Set LUDICS_MAG_CLAUDE_CONTINUE=0/false/no to force plain mode.
  const continueEnv = (process.env.LUDICS_MAG_CLAUDE_CONTINUE ?? "")
    .trim()
    .toLowerCase();
  if (continueEnv === "0" || continueEnv === "false" || continueEnv === "no") {
    return "claude --dangerously-skip-permissions";
  }
  return "claude -c --dangerously-skip-permissions || claude --dangerously-skip-permissions";
}

function triggerSkill(session: string, cmd: string): boolean {
  if (tmuxPaneInMode(session)) {
    tmuxCancelMode(session);
  }
  const sent = tmuxSendKeys(session, cmd, true);
  if (!sent) return false;
  // Small delay before Enter
  safeSyncOutput(["sleep", "0.5"]);
  return tmuxSendKeys(session, "Enter");
}

const DEFAULT_STALL_THRESHOLD_MS = 120_000; // 2 minutes
const DEFAULT_STALL_NUDGE_COOLDOWN_MS = 120_000; // 2 minutes between stall nudges
const DEFAULT_READY_THRESHOLD_MS = 5_000; // pane must be stable this long to count as ready
const DEFAULT_STARTUP_WATCHDOG_SECONDS = 60;
const DEFAULT_STARTUP_HELPER_STUCK_SECONDS = 45;
const STARTUP_ALERT_TITLE = "Mag alert";

function stopHookTimestampFile(): string {
  return join(magStateDir(), "last-stop-hook.epoch");
}

function startupWatchdogEpochFile(): string {
  return join(magStateDir(), "startup-watchdog.epoch");
}

// --- Settled state helpers ---

function settledSentinelFile(): string {
  return join(magStateDir(), "settled");
}

function markMagSettled(): void {
  touchSentinel(settledSentinelFile());
}

function clearMagSettled(): void {
  clearSentinel(settledSentinelFile());
}

function isMagSettled(): boolean {
  return sentinelExists(settledSentinelFile());
}

/**
 * Check whether the Mag pane has been quiet long enough to be considered
 * ready for a new skill. Uses the last-message hash (footer excluded), so
 * Claude Code's cosmetic footer updates don't reset the clock. Returns
 * true iff the hash has been stable for >= DEFAULT_READY_THRESHOLD_MS.
 *
 * Shares state with the stall-detection path (last-pane.hash and
 * last-pane-change.epoch): both track the same "how long has the last
 * message been static" signal, just with different thresholds. Calling
 * isMagReady() also updates that state — safe to call from either the
 * keepalive tick or from magStart's cold-boot poll before keepalive is
 * running.
 */
function isMagReady(): boolean {
  const currentHash = captureLastMessageHash(MAG_SESSION_NAME);
  if (currentHash === null) return false;

  const previousHash = readPaneHash();
  if (previousHash !== currentHash) {
    writePaneHash(currentHash);
    writePaneChangeEpoch();
    return false;
  }

  const lastChangeMs = readPaneChangeEpoch();
  return (Date.now() - lastChangeMs) >= DEFAULT_READY_THRESHOLD_MS;
}

/**
 * If pane output has advanced since the settled sentinel was written,
 * Mag has resumed running (e.g. a manual turn) — clear the stale sentinel.
 *
 * Grace window: a freshly written sentinel is protected for
 * `keepalive_interval * 1.5` seconds. The stop hook's own response text keeps
 * rendering into the pane after markMagSettled(), so without this guard the
 * next keepalive tick would see a hash change and clear the sentinel before
 * maybeFeedMagQueue could claim it for instant delivery (gh-ludics-308).
 *
 * @internal Exported for direct testing. Production callers use the zero-arg form.
 * @param opts.nowMs Override `Date.now()` for deterministic age comparisons.
 * @param opts.graceMs Override `keepaliveIntervalMs() * 1.5` for the sentinel grace window.
 * @param opts.currentHash Override `captureLastMessageHash(MAG_SESSION_NAME)` to bypass tmux.
 *   When the property is present (even as `null`), the override is used instead of capturing.
 */
export function clearStaleSettled(
  opts: { nowMs?: number; graceMs?: number; currentHash?: string | null } = {},
): void {
  if (!isMagSettled()) return;

  const nowMs = opts.nowMs ?? Date.now();
  const graceMs = opts.graceMs ?? keepaliveIntervalMs() * 1.5;

  const settledEpoch = readSentinelEpoch(settledSentinelFile());
  if (settledEpoch !== null) {
    const ageMs = nowMs - settledEpoch * 1000;
    if (ageMs < graceMs) return;
  }

  const currentHash = "currentHash" in opts
    ? opts.currentHash ?? null
    : captureLastMessageHash(MAG_SESSION_NAME);
  if (currentHash === null) return;
  const previousHash = readPaneHash();
  if (previousHash !== null && currentHash !== previousHash) {
    // Pane output changed since last observation — Mag is active, sentinel is stale
    clearMagSettled();
    writePaneHash(currentHash);
    writePaneChangeEpoch();
  } else if (previousHash === null) {
    // First observation — record baseline but don't clear settled
    writePaneHash(currentHash);
    writePaneChangeEpoch();
  }
}

// --- Stall detection helpers (file-persisted, keepalive is per-tick) ---

/**
 * Read a `mag.<key>` config value, treat it as a number of seconds, and
 * return milliseconds. Falls back to `defaultMs` if the value is missing,
 * non-finite, or not strictly positive.
 */
function magSecondsConfig(key: string, defaultMs: number): number {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.[key]);
  if (Number.isFinite(configured) && configured > 0) return configured * 1000;
  return defaultMs;
}

function stallThresholdMs(): number {
  return magSecondsConfig("stall_threshold_seconds", DEFAULT_STALL_THRESHOLD_MS);
}

function keepaliveIntervalMs(): number {
  // Key is `keepalive_interval` (no `_seconds`) — shared with launchd/systemd
  // templates expanded by src/triggers.ts.
  return magSecondsConfig("keepalive_interval", 60_000);
}

function stallNudgeCooldownMs(): number {
  return magSecondsConfig("stall_nudge_cooldown_seconds", DEFAULT_STALL_NUDGE_COOLDOWN_MS);
}

function paneHashFile(): string {
  return join(magStateDir(), "last-pane.hash");
}

function paneChangeEpochFile(): string {
  return join(magStateDir(), "last-pane-change.epoch");
}

function stallNudgeEpochFile(): string {
  return join(magStateDir(), "last-stall-nudge.epoch");
}

function readPaneHash(): string | null {
  try { return readFileSync(paneHashFile(), "utf-8").trim() || null; } catch { return null; }
}

function writePaneHash(hash: string): void {
  writeFileSync(paneHashFile(), hash);
}

function readPaneChangeEpoch(): number {
  const epoch = readSentinelEpoch(paneChangeEpochFile());
  return epoch ? epoch * 1000 : Date.now();
}

function writePaneChangeEpoch(): void {
  touchSentinel(paneChangeEpochFile());
}

function stallNudgeCoolingDown(): boolean {
  const lastNudge = readSentinelEpoch(stallNudgeEpochFile());
  if (lastNudge === null) return false;
  return (Date.now() - lastNudge * 1000) < stallNudgeCooldownMs();
}

function writeStallNudgeEpoch(): void {
  touchSentinel(stallNudgeEpochFile());
}

function clearStallState(): void {
  try { unlinkSync(paneHashFile()); } catch { /* ignore */ }
  clearSentinel(paneChangeEpochFile());
  clearSentinel(stallNudgeEpochFile());
}

// --- Queue feed and stall nudge helpers ---

/**
 * Decide whether a queue-fed command should carry the `Ludics: ` prefix.
 * Structural rule: if the raw queue record has a string `content` field
 * (the `{ action: "message", content: string }` shape — user-typed messages
 * and content-bearing automated entries like `/compact`), feed verbatim so
 * Claude Code's slash-command parser still dispatches it. Otherwise (every
 * automated skill invocation, which carries `task` or no payload) prefix
 * with `Ludics: ` so Mag sees a normal user prompt and decides whether to
 * act. Parse failure defaults to prefixing (treat as automated).
 *
 * Exported for testing.
 */
export function applyQueueFeedPrefix(rawLine: string, command: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return `Ludics: ${command}`;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const content = (parsed as Record<string, unknown>).content;
    if (typeof content === "string") return command;
  }
  return `Ludics: ${command}`;
}

// --- In-flight delivery directory (gh-ludics-535; supersedes gh-ludics-526
// single-file sentinel + timeout + retry-cap loop) ---
//
// Each outstanding Tier-2 delivery is recorded as one file under
// `mag/in-flight/<requestId>.json`. Reconciliation is passive: a record is
// deleted iff its matching `mag/results/<requestId>.json` exists. There is
// no timeout, no auto-retry, no claim file — the gate just stays blocked
// until the user resolves the record via the dashboard's "Unresolved
// deliveries" panel (Re-fire / Discard) or the briefing-prep step absorbs
// it as an orphan.

/** Shape of one `mag/in-flight/<requestId>.json` record. */
export interface InFlightDelivery {
  requestId: string;
  command: string;
  line: string;
  deliveredAt: string;
}

export function inFlightDir(): string {
  return join(magStateDir(), "in-flight");
}

function inFlightFile(requestId: string): string {
  return join(inFlightDir(), `${requestId}.json`);
}

/** Legacy single-file sentinel path (gh-ludics-526). Used only by the
 *  one-shot migrator below; not read by any production path. */
function legacyLastDeliveredFile(): string {
  return join(magStateDir(), "last-delivered.json");
}

/** Path of the result JSON a completed skill writes (matches queue.ts
 *  writeResult). Exported for the dashboard Re-fire handler's
 *  "already-completed" short-circuit. */
export function magResultFile(requestId: string): string {
  return join(harnessDir(), "mag", "results", `${requestId}.json`);
}

/** One-shot, idempotent migrator (gh-ludics-535 A11). If a legacy
 *  `mag/last-delivered.json` exists, parse it and write the record under
 *  `mag/in-flight/<requestId>.json`, then unlink the old path. ENOENT /
 *  malformed → no-op (no directory created — A11 negative control).
 *
 *  Migrator-site target for `lint:state-migration` (A12). */
export function migrateLastDeliveredFile(): void {
  const legacy = legacyLastDeliveredFile();
  if (!existsSync(legacy)) return;
  let parsed: InFlightDelivery | null = null;
  try {
    const raw: unknown = JSON.parse(readFileSync(legacy, "utf-8"));
    if (isPlainObject(raw)) {
      const requestId = String(raw.requestId ?? "");
      const command = String(raw.command ?? "");
      const line = String(raw.line ?? "");
      const deliveredAt = String(raw.deliveredAt ?? "");
      if (requestId && line) parsed = { requestId, command, line, deliveredAt };
    }
  } catch { /* fall through to unlink-only */ }
  if (parsed) {
    writeInFlight(parsed);
  }
  try { unlinkSync(legacy); } catch { /* already gone */ }
}

/** Write one in-flight record (gh-ludics-535 A1). Refuses to overwrite
 *  an existing `<requestId>.json` — the gate guarantees this is
 *  unreachable, but a programming bug that violates the gate should
 *  surface loud (`mag_in_flight_duplicate_write` event) rather than
 *  silently trample the prior record. */
export function writeInFlight(record: InFlightDelivery): void {
  mkdirSync(inFlightDir(), { recursive: true });
  const path = inFlightFile(record.requestId);
  if (existsSync(path)) {
    emitEvent({
      event_type: "mag_in_flight_duplicate_write",
      source: "keepalive",
      scope: "mag",
      status: "warning",
      message: `refused overwrite for ${record.requestId} (${record.command})`,
    });
    return;
  }
  writeJsonFile(path, record);
}

/** Parse one `mag/in-flight/<id>.json` file. Returns null on missing /
 *  malformed / required-field-absent. */
export function readInFlight(requestId: string): InFlightDelivery | null {
  return parseInFlightFile(inFlightFile(requestId));
}

function parseInFlightFile(path: string): InFlightDelivery | null {
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(raw)) return null;
    const requestId = String(raw.requestId ?? "");
    const command = String(raw.command ?? "");
    const line = String(raw.line ?? "");
    const deliveredAt = String(raw.deliveredAt ?? "");
    if (!requestId || !line) return null;
    return { requestId, command, line, deliveredAt };
  } catch {
    return null;
  }
}

/** Enumerate every valid in-flight record on disk, sorted by `deliveredAt`
 *  ascending (oldest first — predictable order for the dashboard's per-row
 *  Re-fire / Discard choice). Returns `[]` when the directory is absent.
 *
 *  Runs `migrateLastDeliveredFile()` first so any legacy
 *  `mag/last-delivered.json` left over from gh-ludics-526 is absorbed on
 *  the first read from any caller (keepalive, dashboard, briefing). */
export function listInFlight(): InFlightDelivery[] {
  migrateLastDeliveredFile();
  const dir = inFlightDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: InFlightDelivery[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const rec = parseInFlightFile(join(dir, name));
    if (rec) out.push(rec);
  }
  out.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt));
  return out;
}

/** Dashboard helper (gh-ludics-535 A8): every in-flight record whose result
 *  JSON has not yet appeared, sorted by `deliveredAt` ascending. */
export function listInFlightDeliveries(): InFlightDelivery[] {
  return listInFlight().filter(r => !existsSync(magResultFile(r.requestId)));
}

/** Unlink a single in-flight record. ENOENT is a no-op (idempotent —
 *  concurrent callers can safely double-clear). */
export function clearInFlight(requestId: string): void {
  try { unlinkSync(inFlightFile(requestId)); } catch { /* already gone */ }
}

/** Passive reconciliation (gh-ludics-535 A2): for each in-flight record,
 *  delete it iff `mag/results/<requestId>.json` exists. Never re-queues,
 *  never times out, no `.reconciling` claim file — passive deletion is
 *  idempotent across concurrent callers (the keepalive loop AND the
 *  dashboard server can both run this without coordination). */
export function reconcileInFlight(): void {
  for (const record of listInFlight()) {
    if (existsSync(magResultFile(record.requestId))) {
      clearInFlight(record.requestId);
    }
  }
}

/** True when at least one in-flight record exists with no matching result
 *  JSON — i.e. a Tier-2 delivery is still genuinely in flight. While this
 *  holds, `maybeFeedMagQueue` must not deliver the next skill (gh-ludics-535
 *  A3 — same serialization invariant as gh-ludics-526's gate, minus the
 *  age check that fed the now-removed auto-retry loop). */
export function deliveryGateBlocked(): boolean {
  return listInFlight().some(r => !existsSync(magResultFile(r.requestId)));
}

/**
 * Deliver one popped skill item into the Mag pane (gh-ludics-535).
 *
 * Path:
 *   1. Compute `delivered = applyQueueFeedPrefix(line, command)`.
 *   2. **Pre-send result-file dedup (A6)** — when `popped.expectsResult !==
 *      false` and `mag/results/<requestId>.json` already exists, emit
 *      `mag_queue_already_resolved` and return `true` (the pop is consumed;
 *      no send, no in-flight record). This formalises the manual-bypass
 *      pattern (A10): Mag can pre-write a result with a skip-marker status
 *      (`skipped-duplicate`, `skipped-superseded`, `preempted`) to
 *      suppress a queued request.
 *   3. Call `send`. On success and `expectsResult !== false`, write
 *      `mag/in-flight/<requestId>.json` (A1) and emit `mag_queue_feed`.
 *      Tier-3 items (`expectsResult: false`) skip both the dedup check
 *      and the in-flight write — they have no result-file contract.
 *   4. On send failure, call `queueReinsertHead(popped.line)` verbatim
 *      (A5). No `_retry_count`, no cap, no `mag_queue_requeued` /
 *      `mag_queue_dropped` events. The retry-cap machinery is gone with
 *      gh-ludics-526; the dashboard's pending queue count is the user-
 *      facing signal that the queue isn't draining.
 *
 * Exported for tests; `send` is injectable to exercise each path without
 * tmux, and `nowMs` pins the `deliveredAt` timestamp deterministically.
 */
export function deliverPoppedSkill(
  popped: { requestId: string; command: string; line: string; expectsResult?: boolean },
  opts: { send?: (session: string, cmd: string) => boolean; nowMs?: number } = {},
): boolean {
  const send = opts.send ?? triggerSkill;
  const delivered = applyQueueFeedPrefix(popped.line, popped.command);
  // A6 pre-send dedup: a Tier-2 request whose result file already exists is
  // either a real already-completed item (race) or a manual-bypass skip-marker
  // (A10). Either way, consume the pop without sending.
  if (popped.expectsResult !== false && existsSync(magResultFile(popped.requestId))) {
    emitEvent({
      event_type: "mag_queue_already_resolved",
      source: "keepalive",
      scope: "mag",
      message: `skipped: ${delivered}`,
    });
    return true;
  }
  const sent = send(MAG_SESSION_NAME, delivered);
  if (sent) {
    if (popped.expectsResult !== false) {
      writeInFlight({
        requestId: popped.requestId,
        command: popped.command,
        line: popped.line,
        deliveredAt: new Date(opts.nowMs ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
    }
    emitEvent({ event_type: "mag_queue_feed", source: "keepalive", scope: "mag", message: `delivered: ${delivered}` });
  } else {
    // A5: roll back the pop — reinsert the verbatim line at queue head.
    // No retry-count, no cap, no drop. tmux unreachable is itself a serial
    // bottleneck the user will notice via the dashboard's pending count.
    queueReinsertHead(popped.line);
  }
  return sent;
}

/**
 * When Mag is ready for input and queue has Mag-turn work, pop one item
 * and deliver. "Ready" means either the settled sentinel is set (stop
 * hook fired at end of last turn) or isMagReady() reports the pane has
 * been quiet long enough (a fallback that doesn't require the stop hook
 * to have fired, e.g. for queue requests arriving during idle periods
 * where clearStaleSettled has cleared the sentinel). Returns true if a
 * command was dispatched.
 */
export async function maybeFeedMagQueue(
  opts: { send?: (session: string, cmd: string) => boolean } = {},
): Promise<boolean> {
  if (!isMagSettled() && !isMagReady()) return false;
  if (!queuePending()) return false;

  // Drain programmatic entries first (they don't need a Mag turn)
  await drainProgrammaticQueueHead();
  if (!queuePending()) return false;

  // Delivery-gate invariant (gh-ludics-526 + gh-ludics-535): passively
  // reconcile every in-flight record before any pop, so every caller of
  // maybeFeedMagQueue — the keepalive tick AND the direct callers
  // (fresh-start ready path, on-stop hook, dashboard /api/queue-deliver
  // and /api/queue) — clears records whose result JSON has appeared before
  // it can deliver the next item. Passive only: nothing auto-times-out,
  // nothing auto-requeues. The dashboard's "Unresolved deliveries" panel
  // is the user's recovery path for records that never resolve.
  reconcileInFlight();
  // Gate: do not deliver the next skill while a delivery is still in flight
  // (any record present without a matching result JSON). reconcileInFlight
  // above has already cleared resolved records, so a block here means a
  // genuinely unresolved delivery.
  if (deliveryGateBlocked()) return false;

  // Atomic claim: if settled, consume the sentinel so concurrent ticks
  // see !settled. In the ready-only path there's no sentinel to consume;
  // we rely on queuePopSkill's atomic dequeue below (and on the harness'
  // single-writer invariant under federation v2).
  if (isMagSettled()) {
    const claimPath = settledSentinelFile() + ".claiming";
    try {
      renameSync(settledSentinelFile(), claimPath);
    } catch {
      return false; // another tick already claimed
    }
    try { unlinkSync(claimPath); } catch { /* ignore */ }
  }

  const popped = await queuePopSkill();
  if (!popped) return false;

  return deliverPoppedSkill(popped, { send: opts.send });
}

/**
 * When Mag is NOT settled and queue has Mag-turn work, check for terminal stall
 * and nudge only if pane output hasn't advanced for the configured threshold.
 */
function maybeNudgeStalledMag(): void {
  if (isMagSettled()) return;
  if (!queuePending()) return;

  const currentHash = captureLastMessageHash(MAG_SESSION_NAME);
  if (currentHash === null) return; // tmux capture failed — don't treat as stall

  const previousHash = readPaneHash();
  if (currentHash !== previousHash) {
    // Pane output advanced — update state, no nudge
    writePaneHash(currentHash);
    writePaneChangeEpoch();
    return;
  }

  // Pane unchanged — check if stall threshold exceeded
  const lastChangeMs = readPaneChangeEpoch();
  const stallMs = Date.now() - lastChangeMs;
  if (stallMs < stallThresholdMs()) return;

  // Cooldown: don't spam nudges while Mag remains stalled
  if (stallNudgeCoolingDown()) return;

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nudged = triggerSkill(MAG_SESSION_NAME, `Continue previous work if any. (ludics, ${now})`);
  if (nudged) {
    writeStallNudgeEpoch();
    emitEvent({ event_type: "mag_nudge", source: "keepalive", scope: "mag", message: "nudged Mag (stall detected)" });
  }
}

function writeStopHookTimestamp(): void {
  touchSentinel(stopHookTimestampFile());
}

function startupWatchdogSeconds(): number {
  const envVal = process.env.LUDICS_STARTUP_WATCHDOG_SECONDS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.startup_watchdog_seconds);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_STARTUP_WATCHDOG_SECONDS;
}

function startupHelperStuckSeconds(): number {
  const envVal = process.env.LUDICS_STARTUP_HELPER_STUCK_SECONDS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.startup_helper_stuck_seconds);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_STARTUP_HELPER_STUCK_SECONDS;
}

function writeStartupWatchdogEpoch(): void {
  touchSentinel(startupWatchdogEpochFile());
}

function clearStartupWatchdogEpoch(): void {
  clearSentinel(startupWatchdogEpochFile());
}

function startupAlertStateFile(): string {
  return join(magStateDir(), "startup-alerts.json");
}

function loadStartupAlertState(): Record<string, number> {
  const file = startupAlertStateFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!isPlainObject(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

function saveStartupAlertState(state: Record<string, number>): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeJsonFile(startupAlertStateFile(), state);
}

function clearStartupAlertsForEpoch(startupEpoch: number): void {
  const state = loadStartupAlertState();
  let changed = false;
  const suffix = `|${startupEpoch}`;
  for (const key of Object.keys(state)) {
    if (!key.endsWith(suffix)) continue;
    delete state[key];
    changed = true;
  }
  if (changed) saveStartupAlertState(state);
}

function notifyStartupAlertOnce(kind: string, startupEpoch: number, message: string): void {
  const key = `${kind}|${startupEpoch}`;
  const state = loadStartupAlertState();
  if (state[key]) return;

  state[key] = Math.floor(Date.now() / 1000);
  saveStartupAlertState(state);

  notifyOutgoing(message, 5, STARTUP_ALERT_TITLE);
  emitEvent({
    event_type: "mag_startup_alert",
    source: "keepalive",
    scope: "mag",
    status: "warning",
    message,
  });
}

function latestResultEpoch(): number | null {
  const dir = join(harnessDir(), "mag", "results");
  if (!existsSync(dir)) return null;
  let newest = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const mtime = Math.floor(statSync(join(dir, f)).mtimeMs / 1000);
      if (mtime > newest) newest = mtime;
    } catch {
      continue;
    }
  }
  return newest > 0 ? newest : null;
}

function readPsCommand(pid: number): string {
  const out = safeSyncOutput(["ps", "-p", String(pid), "-o", "command="]);
  return out.ok ? out.stdout : "";
}

function readPsElapsedSeconds(pid: number): number | null {
  const out = safeSyncOutput(["ps", "-p", String(pid), "-o", "etimes="]);
  if (!out.ok) return null;
  const parsed = parseInt(out.stdout, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function childPids(parentPid: number): number[] {
  const out = safeSyncOutput(["pgrep", "-P", String(parentPid)]);
  if (!out.ok) return [];
  return out.stdout
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function findClaudePidForPane(session: string): number | null {
  const panePid = tmuxPanePid(session);
  if (!panePid) return null;
  const children = childPids(panePid);
  for (const pid of children) {
    const cmd = readPsCommand(pid);
    if (!cmd) continue;
    if (cmd.startsWith("claude ") || cmd.includes("/claude ")) return pid;
  }
  return null;
}

function claudeStartupHelperMaxAgeSeconds(claudePid: number): number {
  let maxAge = 0;
  for (const pid of childPids(claudePid)) {
    const cmd = readPsCommand(pid);
    if (!cmd.includes("--ripgrep --files --hidden")) continue;
    const age = readPsElapsedSeconds(pid);
    if (age !== null && age > maxAge) maxAge = age;
  }
  return maxAge;
}

function restartClaudeInMag(reason: string): boolean {
  const claudePid = findClaudePidForPane(MAG_SESSION_NAME);
  if (claudePid) {
    const descendants = childPids(claudePid);
    if (descendants.length > 0) {
      safeSyncOutput(["kill", "-9", ...descendants.map((pid) => String(pid))]);
    }
    safeSyncOutput(["kill", "-9", String(claudePid)]);
  }

  const launched = tmuxSendCommand(MAG_SESSION_NAME, claudeLaunchCommand());
  if (!launched) {
    console.error(`ludics: startup watchdog: failed to relaunch Claude (${reason})`);
    emitEvent({
      event_type: "mag_startup_recover",
      source: "keepalive",
      scope: "mag",
      status: "failed",
      message: `failed relaunch (${reason})`,
    });
    return false;
  }

  writeStartupWatchdogEpoch();
  emitEvent({
    event_type: "mag_startup_recover",
    source: "keepalive",
    scope: "mag",
    status: "ok",
    message: `restarted Claude (${reason})`,
  });
  return true;
}

function maybeRecoverStuckStartup(): void {
  const startupEpoch = readSentinelEpoch(startupWatchdogEpochFile());
  if (!startupEpoch) return;

  const lastStopHook = readSentinelEpoch(stopHookTimestampFile());
  if (lastStopHook && lastStopHook >= startupEpoch) {
    clearStartupAlertsForEpoch(startupEpoch);
    clearStartupWatchdogEpoch();
    return;
  }

  const lastResult = latestResultEpoch();
  if (lastResult && lastResult >= startupEpoch) {
    clearStartupAlertsForEpoch(startupEpoch);
    clearStartupWatchdogEpoch();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if ((now - startupEpoch) < startupWatchdogSeconds()) return;

  const claudePid = findClaudePidForPane(MAG_SESSION_NAME);
  if (!claudePid) {
    console.error("ludics: startup watchdog: Claude process missing; attempting relaunch");
    restartClaudeInMag("process missing");
    return;
  }

  const helperAge = claudeStartupHelperMaxAgeSeconds(claudePid);
  if (helperAge >= startupHelperStuckSeconds()) {
    const message = `Mag startup degraded: Claude appears stuck in upstream helper (--ripgrep --files --hidden) for ${helperAge}s. Manual intervention likely required.`;
    console.error(`ludics: ${message}`);
    notifyStartupAlertOnce("claude-helper-stuck", startupEpoch, message);
  }
}

function feedbackDigestStateFile(): string {
  return join(magStateDir(), "feedback-digest-last-queued.json");
}

function readFeedbackDigestQueueState(): Record<string, number> {
  const file = feedbackDigestStateFile();
  if (!existsSync(file)) return {};

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!isPlainObject(parsed)) return {};

    const state: Record<string, number> = {};
    for (const [repo, epoch] of Object.entries(parsed)) {
      if (typeof epoch === "number" && Number.isFinite(epoch)) {
        state[repo] = epoch;
      }
    }
    return state;
  } catch {
    return {};
  }
}

function feedbackDigestCooldownRemaining(repo: string): number {
  const lastQueued = readFeedbackDigestQueueState()[repo];
  if (typeof lastQueued !== "number") return 0;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - lastQueued;
  if (elapsed >= FEEDBACK_DIGEST_COOLDOWN_SECONDS) return 0;
  return FEEDBACK_DIGEST_COOLDOWN_SECONDS - Math.max(0, elapsed);
}

function markFeedbackDigestQueued(repo: string): void {
  const state = readFeedbackDigestQueueState();
  state[repo] = Math.floor(Date.now() / 1000);
  mkdirSync(magStateDir(), { recursive: true });
  writeJsonFileCompact(feedbackDigestStateFile(), state);
}

function tryQueueFeedbackDigest(repo: string): { queued: boolean; reason?: string } {
  if (queueHasPendingFeedbackDigest(repo)) {
    return { queued: false, reason: "already pending in queue" };
  }
  const remaining = feedbackDigestCooldownRemaining(repo);
  if (remaining > 0) {
    return { queued: false, reason: `cooldown active (${remaining}s remaining)` };
  }
  queueRequest({ action: "feedback-digest", repo });
  markFeedbackDigestQueued(repo);
  return { queued: true };
}

function lastCaptureHashFile(): string {
  return join(magStateDir(), "last-capture.hash");
}

function adoptSessionsFingerprintFile(): string {
  return join(magStateDir(), "adopt-sessions-unclassified.hash");
}

interface AdoptFingerprintSession {
  cwd: string;
  cwdNormalized: string;
  agents: string[];
  ids: string[];
  orchestration: { type: string; taskId: string; phase: string; round: string } | null;
  meta: {
    tmux_session?: string;
    git_branch?: string;
    port?: string;
  };
}

function adoptSessionsFingerprintData(
  sessionsJsonPath: string,
): { hash: string; unclassifiedCount: number } | null {
  if (!existsSync(sessionsJsonPath)) return null;

  try {
    const data = JSON.parse(readFileSync(sessionsJsonPath, "utf-8")) as { unclassified?: Array<Record<string, unknown>> };
    const raw = Array.isArray(data.unclassified) ? data.unclassified : [];
    const normalized: AdoptFingerprintSession[] = raw.map((session) => {
      const metaObj = session.meta && typeof session.meta === "object"
        ? (session.meta as Record<string, unknown>)
        : {};
      const orchObj = session.orchestration && typeof session.orchestration === "object"
        ? (session.orchestration as Record<string, unknown>)
        : null;
      const orchestration = orchObj
        ? {
          type: String(orchObj.type ?? ""),
          taskId: String(orchObj.feature ?? orchObj.taskId ?? ""),
          phase: String(orchObj.phase ?? ""),
          round: String(orchObj.round ?? ""),
        }
        : null;

      return {
        cwd: String(session.cwd ?? "unknown"),
        cwdNormalized: String(session.cwdNormalized ?? "unknown"),
        agents: Array.isArray(session.agents) ? session.agents.map((v) => String(v)).sort() : [],
        ids: Array.isArray(session.ids) ? session.ids.map((v) => String(v)).sort() : [],
        orchestration,
        meta: {
          tmux_session: typeof metaObj.tmux_session === "string" ? metaObj.tmux_session : undefined,
          git_branch: typeof metaObj.git_branch === "string" ? metaObj.git_branch : undefined,
          port: typeof metaObj.port === "string" ? metaObj.port : undefined,
        },
      };
    });

    normalized.sort((a, b) => {
      const pathCmp = a.cwdNormalized.localeCompare(b.cwdNormalized);
      if (pathCmp !== 0) return pathCmp;
      return a.ids.join(",").localeCompare(b.ids.join(","));
    });

    const payload = {
      version: 1,
      unclassified: normalized,
    };
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify(payload));
    return {
      hash: hasher.digest("hex"),
      unclassifiedCount: normalized.length,
    };
  } catch {
    return null;
  }
}

function publishTerminalState(): void {
  const snippet = captureLastMessage(MAG_SESSION_NAME, 50);
  if (!snippet) return;

  // Dedup: hash and compare to previous
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(snippet);
  const hash = hasher.digest("hex");

  const hashFile = lastCaptureHashFile();
  if (existsSync(hashFile)) {
    const prev = readFileSync(hashFile, "utf-8").trim();
    if (prev === hash) return; // unchanged
  }

  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(hashFile, hash);

  notifyOutgoing(snippet, 2, "Mag terminal");
}

function magSignal(status: string, message: string = ""): void {
  const dir = magStateDir();
  mkdirSync(dir, { recursive: true });
  const epoch = Math.floor(Date.now() / 1000);
  writeFileSync(magStatusFile(), `${status}|${epoch}|${message}\n`);
}

function getTtydPort(): string {
  const config = loadConfigSync();
  const mag =config.mag as Record<string, unknown> | undefined;
  return String(mag?.ttyd_port ?? MAG_DEFAULT_PORT);
}

function ensureTtyd(): void {
  const ttydWhich = safeSyncOutput(["which", "ttyd"]);
  if (!ttydWhich.ok) {
    console.error("ludics: ttyd not installed; skipping web access");
    return;
  }

  // Check if already running
  if (safeSyncOutput(["pgrep", "-f", `ttyd.*${MAG_SESSION_NAME}`]).ok) return;

  const port = getTtydPort();
  const ttydBin = ttydWhich.stdout;

  console.error(`ludics: Starting ttyd on port ${port}...`);

  const logDir = existsSync(join(process.env.HOME!, "Library/Logs"))
    ? join(process.env.HOME!, "Library/Logs")
    : "/tmp";
  const logFile = join(logDir, "ludics-ttyd.log");

  tmuxRunShell(MAG_SESSION_NAME, `${ttydBin} -W -p ${port} tmux attach -t ${MAG_SESSION_NAME} >>${logFile} 2>&1`);

  console.log(`Web access available at: ${getUrl(port)}`);
}

// --- Queue pop for skills ---

function isTaskDeferred(taskId: string): boolean {
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return false;
  const content = readFileSync(taskFile, "utf-8");
  const fm = parseTaskFrontmatter(content);
  if (fm.status === "deferred") return true;
  // Legacy shim: treat deferred_launch: true as deferred, opportunistically migrate in-place
  if (fm.deferred_launch === "true") {
    updateFrontmatterField(taskFile, "status", "deferred");
    removeFrontmatterField(taskFile, "deferred_launch");
    removeFrontmatterField(taskFile, "approved");
    return true;
  }
  return false;
}

async function abandonTaskFromNotification(taskId: string): Promise<void> {
  try {
    const slotNum = findSlotForTask(taskId);
    await tasksAbandon(taskId, { source: "notify", scope: "mag" });
    // Preserve the notification-specific success event for existing event consumers
    emitEvent({
      event_type: "notify_abandon",
      source: "notify",
      scope: "mag",
      ...(slotNum !== null ? { slot: slotNum } : {}),
      task: taskId,
      status: "abandoned",
      message: slotNum !== null
        ? "abandoned via notification button"
        : "abandoned deferred task via notification (no slot)",
    });
    console.error(`ludics: abandoned ${taskId} via notification button`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("task not found")) {
      console.error(`ludics: abandon request ignored: task ${taskId} not found`);
      emitEvent({
        event_type: "notify_abandon_ignored",
        source: "notify",
        scope: "mag",
        task: taskId,
        message: "task not found",
      });
    } else {
      console.error(`ludics: failed to abandon ${taskId}: ${msg}`);
      emitEvent({
        event_type: "notify_abandon_error",
        source: "notify",
        scope: "mag",
        task: taskId,
        status: "error",
        message: msg,
      });
    }
  }
}

async function completeTaskFromNotification(taskId: string): Promise<void> {
  const slotNum = findSlotForTask(taskId);
  try {
    if (slotNum !== null) {
      await slotClear(slotNum, "done");
      emitEvent({
        event_type: "notify_done",
        source: "notify",
        scope: "mag",
        slot: slotNum,
        task: taskId,
        status: "done",
        message: "completed via notification button",
      });
      console.error(`ludics: completed ${taskId} from slot ${slotNum} via notification button`);
      return;
    }

    const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
    if (!existsSync(taskFile)) {
      console.error(`ludics: done request ignored: task ${taskId} not found`);
      emitEvent({
        event_type: "notify_done_ignored",
        source: "notify",
        scope: "mag",
        task: taskId,
        message: "task not found",
      });
      return;
    }

    taskCompleteDirectly(taskId);
    emitEvent({
      event_type: "notify_done",
      source: "notify",
      scope: "mag",
      task: taskId,
      status: "done",
      message: "completed via notification button (direct)",
    });
    console.error(`ludics: completed ${taskId} via notification button (direct)`);
  } catch (err) {
    console.error(`ludics: failed to complete ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    emitEvent({
      event_type: "notify_done_error",
      source: "notify",
      scope: "mag",
      slot: slotNum ?? undefined,
      task: taskId,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Map any adapter name from notification bodies to t3code.
 *  Legacy notifications may carry "agent-claude", "agent-codex", etc.
 *  With the t3code-only workflow, all launches use t3code.
 *
 *  @deprecated Internal callers no longer pass rawAdapter to launchSessionFromNotification.
 *  This function is kept for backward-compat with legacy notification regex matchers
 *  until those notification formats are fully retired. */
export function normalizeLaunchAdapter(rawAdapter: string): string {
  const adapter = rawAdapter.trim();
  if (adapter === "t3code") return adapter;
  if (adapter) {
    console.error(`ludics: legacy launch adapter "${adapter}" → t3code`);
  }
  return "t3code";
}

function quoteShellToken(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildFollowupAdapterArgs(followupMsg: string): string {
  const sanitizedMsg = followupMsg
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (sanitizedMsg) {
    return `--followup --followup-msg ${quoteShellToken(sanitizedMsg)}`;
  }
  return "--followup";
}

function readTaskProject(taskId: string): string {
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return "";
  const content = readFileSync(taskFile, "utf-8");
  return parseTaskFrontmatter(content).project ?? "";
}

function resolveTaskProjectPath(taskId: string): string {
  const project = readTaskProject(taskId);
  if (!project) return "";

  const home = process.env.HOME ?? "";
  if (!home) return "";

  const config = loadConfigSync();
  const candidates: string[] = [];
  const addProjectCandidates = (name: string): void => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    for (const candidate of [join(home, trimmed), join(home, "repos", trimmed)]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  };

  const configured = (config.projects ?? []).find((p) => {
    const repoTail = p.repo.split("/").pop() ?? "";
    return p.name === project || repoTail === project;
  });

  if (configured) {
    const repoTail = configured.repo.split("/").pop() ?? "";
    addProjectCandidates(repoTail);
    addProjectCandidates(configured.name);
  }

  addProjectCandidates(project);

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return "";
}

interface SlotSelection {
  taskSlot: number | null;
  existingPath: string;
  previousMode: string;
  previousSession: string;
  previousAdapterArgs: string;
  emptySlot: number | null;
}

function selectSlotForLaunch(taskId: string): SlotSelection {
  const count = slotsCount();
  const slots = readAllSlotJson(count);

  let taskSlot: number | null = null;
  let existingPath = "";
  let previousMode = "";
  let previousSession = "";
  let previousAdapterArgs = "";
  let emptySlot: number | null = null;

  for (let i = 1; i <= count; i++) {
    const data = slots.get(i);
    const process = data ? data.process : "(empty)";

    if ((!process || process === "(empty)") && emptySlot === null) {
      emptySlot = i;
    }

    if (!data) continue;
    if ((data.task ?? "") !== taskId) continue;

    taskSlot = i;
    const slotMode = data.mode ?? "";
    previousMode = slotMode || "";
    const slotSession = data.session ?? "";
    previousSession = slotSession || "";
    const slotAdapterArgs = data.adapterArgs ?? "";
    previousAdapterArgs = slotAdapterArgs || "";
    const slotPath = data.path ?? "";
    if (slotPath) existingPath = slotPath;
  }

  return { taskSlot, existingPath, previousMode, previousSession, previousAdapterArgs, emptySlot };
}

// --- Auto-start decision support ---

export interface AutoStartDecision {
  decision: "auto-start" | "defer-to-user";
  reason: string;
}

/** Pure decision function — no filesystem or config side effects.
 *  Callers must supply autonomy and slotAssigned explicitly (read from config/slots). */
export function evaluateAutoStartDecisionPure(
  workerConfidence: "high" | "low" | undefined,
  rationale: string,
  autonomy: "auto" | "suggest" | "manual",
  slotAssigned: boolean,
): AutoStartDecision {
  if (autonomy === "manual") return { decision: "defer-to-user", reason: "autonomy=manual" };
  if (autonomy === "suggest") return { decision: "defer-to-user", reason: "autonomy=suggest" };
  // autonomy === "auto"
  if (workerConfidence === "low" || !workerConfidence) {
    return { decision: "defer-to-user", reason: `worker confidence: ${workerConfidence ?? "missing"}` };
  }
  // Safety net: scan rationale for ambiguity signals contradicting "high"
  // Patterns match the signal word/phrase only when NOT preceded by a negation prefix.
  // Uses negative lookbehind to exclude e.g. "unambiguous", "no open question", "not unclear".
  const AMBIGUITY_PATTERNS: [RegExp, string][] = [
    [/(?<!\bun)ambiguous/i, "ambiguous"],
    [/(?<!\bnot\s)(?<!\bno\s)unclear/i, "unclear"],
    [/(?<!\bno\s)open question/i, "open question"],
    [/(?<!\bnot\s)(?<!\bnon-)speculative/i, "speculative"],
    [/(?<!\bno\s)(?<!\bnot\s)uncertain scope/i, "uncertain scope"],
  ];
  const ambiguityHit = AMBIGUITY_PATTERNS.find(([re]) => re.test(rationale))?.[1];
  if (ambiguityHit) {
    return { decision: "defer-to-user", reason: `rationale contains "${ambiguityHit}" despite high confidence` };
  }
  if (!slotAssigned) return { decision: "defer-to-user", reason: "no slot assigned" };
  return { decision: "auto-start", reason: "high confidence, slot ready" };
}


async function launchSessionFromNotification(taskId: string, adapterArgs: string = ""): Promise<void> {
  const adapter = "t3code";
  const launchArgs = adapterArgs.trim();
  const selection = selectSlotForLaunch(taskId);

  // Guard: if the task's slot already has an active session, skip re-start
  if (selection.taskSlot !== null) {
    const data = readSlotJson(selection.taskSlot);
    const sessionStarted = data.sessionStarted ?? "";
    if (sessionStarted) {
      const msg = `Session already active for ${taskId} in slot ${selection.taskSlot} — ignoring duplicate launch`;
      console.error(`ludics: ${msg}`);
      notifyOutgoing(msg, 2, "ludics");
      return;
    }
  }

  if (selection.taskSlot === null && selection.emptySlot === null) {
    const msg = `Cannot launch ${taskId}: all slots occupied. Run: ludics slot N preempt ${taskId} -a t3code`;
    notifyOutgoing(msg, 3, "ludics");
    emitEvent({
      event_type: "notify_launch_no_slot",
      source: "notify",
      scope: "mag",
      task: taskId,
      adapter: "t3code",
      message: "all slots occupied",
    });
    console.error(`ludics: launch request for ${taskId} failed: no empty slots`);
    return;
  }

  const slotNum = selection.taskSlot ?? selection.emptySlot!;
  const path = selection.existingPath || resolveTaskProjectPath(taskId);

  // Resolve merged requirements for machine selection
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  let launchMachine = "";
  if (existsSync(taskFile)) {
    const taskContent = readFileSync(taskFile, "utf-8");
    try {
      const taskFm = parseTaskFrontmatter(taskContent);
      const cfgLaunch = loadConfigSync();
      const projectName = taskFm.project ?? "";
      const projectReqs = findProjectConfigByName(projectName, cfgLaunch)?.requirements;
      const launchReqs = mergeRequirements(taskFm.requirements, projectReqs);
      const machine = selectMachineForSlot({
        project: projectName,
        effort: taskFm.effort ?? "small",
        requirements: launchReqs,
      });
      if (machine === null) {
        const msg = `Cannot launch ${taskId}: no machine meets requirements`;
        notifyOutgoing(msg, 3, "ludics");
        console.error(`ludics: ${msg}`);
        return;
      }
      launchMachine = machine;
    } catch {
      // Malformed task file — proceed without requirements (graceful degradation)
    }
  }

  try {
    // Notification button actions are always treated as fresh starts.
    await slotAssign(slotNum, taskId, adapter, "", path, launchArgs, launchMachine);
    await slotStart(slotNum);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    let rollbackStatus = "rollback skipped";
    try {
      if (selection.taskSlot === null) {
        // Mark slot as interrupted instead of clearing — prevents maybeFillEmptySlots
        // from overwriting with a different task before the user can investigate.
        markSlotSetupFailed(slotNum, detail);
        rollbackStatus = "slot marked interrupted";
      } else {
        await slotAssign(
          slotNum,
          taskId,
          selection.previousMode || "manual",
          selection.previousSession,
          selection.existingPath,
          selection.previousAdapterArgs,
        );
        rollbackStatus = "restored prior slot assignment";
      }
    } catch (rollbackErr) {
      const rollbackDetail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      rollbackStatus = `rollback failed: ${rollbackDetail}`;
      console.error(`ludics: launch rollback failed for ${taskId} in slot ${slotNum}: ${rollbackDetail}`);
    }

    console.error(`ludics: failed to launch t3code for ${taskId} in slot ${slotNum}: ${detail}`);
    notifyOutgoing(
      `Failed to launch t3code for ${taskId} in slot ${slotNum}: ${detail} (${rollbackStatus})`,
      3,
      "ludics",
    );
    emitEvent({
      event_type: "notify_launch_error",
      source: "notify",
      scope: "mag",
      slot: slotNum,
      task: taskId,
      adapter: "t3code",
      status: "error",
      message: `${detail} (${rollbackStatus})`,
    });
    return;
  }

  const actionLabel = selection.taskSlot !== null ? "reassigned+started" : "assigned+started";
  emitEvent({
    event_type: "notify_launch",
    source: "notify",
    scope: "mag",
    slot: slotNum,
    task: taskId,
    adapter: "t3code",
    message: actionLabel,
  });
  console.error(`ludics: launched t3code for ${taskId} in slot ${slotNum} (${actionLabel})`);
}

/** @internal Exported for tests — pops the queue head, resolves it to a skill
 *  command, and exposes the request id captured at pop time (gh-ludics-526). */
export async function queuePopSkill(): Promise<{ requestId: string; command: string; line: string; expectsResult: boolean } | null> {
  const popped = queuePopExpected();
  if (popped.status !== "popped") return null;

  if (!popped.request) {
    console.error("ludics: mag queue-pop: invalid request in queue");
    return null;
  }
  const request = popped.request;

  // Write request ID to file so skills can read it (env vars can't be set mid-session)
  const requestId = String(request.id ?? "");
  if (requestId) {
    const requestIdFile = join(harnessDir(), "mag", "current-request-id");
    writeFileSync(requestIdFile, requestId);
  }

  const command = await resolveQueueRequestCommand(request, true);
  if (!command) return null;
  // Tier-2 skill actions write a result JSON; Tier-3 programmatic actions
  // (message, /compact, ...) do not. Only the former participate in
  // delivery confirmation — see deliverPoppedSkill.
  const expectsResult = hasRegisteredAction(String(request.action ?? ""));
  // requestId is captured here at delivery time — never re-read from
  // mag/current-request-id later, since the next queuePopSkill overwrites it
  // (gh-ludics-526).
  return { requestId, command, line: popped.line, expectsResult };
}

/** Resolve a queue request to a skill command or execute it programmatically.
 *  Exported for testing — call with `executeProgrammatic: false` for pure parsing.
 *
 *  Three-tier dispatch:
 *  1. Pre-hooks for briefing/adopt-sessions (imperative side-effects before skill command).
 *  2. Auto-discovered skill commands read from skills/*.md frontmatter via the registry.
 *  3. Programmatic-only actions (message, adapter-followup, complete-task) that never
 *     return a slash command, handled by the reduced switch below.
 */
export async function resolveQueueRequestCommand(request: Record<string, unknown>, executeProgrammatic: boolean): Promise<string | null> {
  const action = String(request.action ?? "");

  // Tier 1: Pre-hooks for skill actions that require context pre-computation.
  // Only precompute when actually dispatching, not during a peek.
  if (executeProgrammatic) {
    if (action === "briefing") {
      await briefingPrecomputeContext();
    } else if (action === "adopt-sessions") {
      adoptSessionsPrecomputeContext();
    } else if (action === "health-check") {
      const { shouldSkipHealthCheck } = await import("./health-gate.ts");
      const gate = shouldSkipHealthCheck();
      if (gate.skip) {
        emitEvent({
          event_type: "health_check_skipped",
          source: "keepalive",
          scope: "mag",
          message: gate.reason,
          currentLines: gate.currentLines,
          priorLines: gate.priorLines,
          delta: gate.currentLines - gate.priorLines,
        });
        return null;
      }
      try {
        const { runAllTestHealth } = await import("./health.ts");
        runAllTestHealth();
      } catch (err) {
        console.error("ludics: test health check failed:", err);
      }
    }
  }

  // Tier 2: Auto-discovered skill commands from skills/*.md frontmatter.
  const skillCommand = resolveSkillCommand(action, request);
  if (skillCommand !== null) {
    return skillCommand;
  }

  // Tier 3: Programmatic-only actions that never yield a skill command.
  switch (action) {
    case "message": {
      const content = String(request.content ?? "");
      if (!content) return null;

      // Approve a deferred task for auto-start (does not launch immediately)
      const approveMatch = content.match(/^Approve task ([\w.-]+)$/);
      if (approveMatch) {
        if (executeProgrammatic) {
          const tid = approveMatch[1]!;
          const tf = join(harnessDir(), "tasks", `${tid}.md`);
          if (existsSync(tf)) {
            const tfContent = readFileSync(tf, "utf-8");
            const tfStatus = parseTaskFrontmatter(tfContent).status;
            if (tfStatus === "deferred") {
              updateFrontmatterField(tf, "status", "ready");
              console.error(`ludics: approved deferred task ${tid} for auto-start`);
            } else {
              console.error(`ludics: ignoring approve for ${tid} — status is ${tfStatus}, not deferred`);
            }
          }
        }
        return null;
      }

      // Intercept button-tap launch messages from ntfy notifications
      // Legacy format: "Launch task <id>" — kept for backward compat
      const launchNewMatch = content.match(/^Launch task ([\w.-]+)$/);
      if (launchNewMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(launchNewMatch[1]!);
        }
        return null;
      }

      // Backward compat: old ntfy buttons may still carry this format.
      // New notifications emit "Launch task <id>" only.
      // The captured adapter group is intentionally ignored — all launches use t3code.
      const launchLegacyMatch = content.match(/^Launch ([\w-]+) for ([\w.-]+) in project .+$/);
      if (launchLegacyMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(launchLegacyMatch[2]!);
        }
        return null;
      }

      const abandonMatch = content.match(/^Abandon task ([\w.-]+)$/);
      if (abandonMatch) {
        if (executeProgrammatic) {
          await abandonTaskFromNotification(abandonMatch[1]!);
        }
        return null;
      }

      // New format: "Followup task <id>"
      const followupNewMatch = content.match(/^Followup task ([\w.-]+)$/);
      if (followupNewMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(followupNewMatch[1]!, buildFollowupAdapterArgs(""));
        }
        return null;
      }

      // Backward compat: old ntfy buttons may still carry this format.
      // New notifications emit "Followup task <id>" only.
      // The captured adapter group is intentionally ignored — all launches use t3code.
      const followupLegacyMatch = content.match(/^Followup ([\w-]+) for ([\w.-]+)$/);
      if (followupLegacyMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(followupLegacyMatch[2]!, buildFollowupAdapterArgs(""));
        }
        return null;
      }

      const doneMatch = content.match(/^Done task ([\w.-]+)$/);
      if (doneMatch) {
        if (executeProgrammatic) {
          await completeTaskFromNotification(doneMatch[1]!);
        }
        return null;
      }

      return content; // send directly as user turn
    }
    case "adapter-followup": {
      const task = String(request.task ?? "");
      // `adapter` field is accepted for backward compat but ignored — all launches use t3code.
      const followupMsg = String(request.followup_msg ?? "");
      if (!task) {
        if (executeProgrammatic) {
          console.error("ludics: mag queue-pop: adapter-followup missing task");
        }
        return null;
      }
      if (executeProgrammatic) {
        await launchSessionFromNotification(task, buildFollowupAdapterArgs(followupMsg));
      }
      return null;
    }
    case "complete-task": {
      const task = String(request.task ?? "");
      if (!task) {
        if (executeProgrammatic) {
          console.error("ludics: mag queue-pop: complete-task missing task");
        }
        return null;
      }
      if (executeProgrammatic) {
        await completeTaskFromNotification(task);
      }
      return null;
    }
    default:
      // Log only for truly unknown actions; registered skills that returned null
      // (e.g. missing a required arg) are not unknown.
      if (executeProgrammatic && !hasRegisteredAction(action)) {
        console.error(`ludics: mag queue-pop: unknown action: ${action}`);
      }
      return null;
  }
}

async function drainProgrammaticQueueHead(): Promise<boolean> {
  const queueFile = join(harnessDir(), "mag", "queue.jsonl");

  while (true) {
    if (!existsSync(queueFile)) return false;

    const content = readFileSync(queueFile, "utf-8").trim();
    if (!content) return false;

    const first = content.split("\n")[0]!;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(first) as Record<string, unknown>;
    } catch {
      const dropped = queuePopExpected(first);
      if (dropped.status === "mismatch") continue;
      if (dropped.status === "popped") {
        console.error("ludics: mag queue-pop: invalid request in queue");
      }
      continue;
    }

    const command = await resolveQueueRequestCommand(request, false);
    if (command) return true;

    const popped = queuePopExpected(first);
    if (popped.status === "mismatch") continue;
    if (popped.status !== "popped" || !popped.request) continue;
    await resolveQueueRequestCommand(popped.request, true);
  }
}

// --- Briefing context pre-computation ---

/**
 * Delete t3code threads for tasks marked as done/abandoned that have stored
 * thread IDs in their `t3code_threads` frontmatter field.
 * This is idempotent: threads already absent from the server are skipped.
 */
async function cleanupDoneTaskThreads(): Promise<void> {
  const harness = harnessDir();
  const tasksDir = join(harness, "tasks");
  if (!existsSync(tasksDir)) return;

  // Collect thread IDs from completed tasks, and queue retrospective fallback
  // for any done/abandoned task that does not yet have one. Both loops read the
  // same files and test the same `status in {done, abandoned}` predicate, so we
  // fold them into a single pass.
  const threadIdsToDelete: string[] = [];
  const retroDir = join(harness, "retrospectives");
  const retroFallbacks: string[] = [];
  try {
    const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
    for (const f of files) {
      const content = readFileSync(join(tasksDir, f), "utf-8");
      const fm = parseTaskFrontmatter(content);
      const status = fm.status ?? "";
      if (status !== "done" && status !== "abandoned") continue;

      if (fm.t3code_threads && fm.t3code_threads.length > 0) {
        threadIdsToDelete.push(...fm.t3code_threads);
      }

      const taskId = f.replace(/\.md$/, "");
      const retroFile = join(retroDir, `${taskId}.json`);
      if (!existsSync(retroFile)) retroFallbacks.push(taskId);
    }
  } catch {
    return;
  }

  if (retroFallbacks.length > 0) {
    try {
      const { collectRetrospectiveFallback } = await import("./retrospective.ts");
      for (const taskId of retroFallbacks) {
        try { await collectRetrospectiveFallback(taskId); } catch { /* best effort — ignore */ }
      }
    } catch { /* ignore module load failure */ }
  }

  if (threadIdsToDelete.length === 0) return;

  // Delete threads from t3code server (idempotent — skip if not on server)
  try {
    const { serverStatus } = await import("./t3code/server.ts");
    const { T3CodeClient } = await import("./t3code/client.ts");
    const { makeId, isoNow } = await import("./orchestration/util.ts");
    const status = await serverStatus({ harnessDir: harness });
    if (!status.running || !status.record || !status.snapshot) return;

    const snapshot = status.snapshot;
    const record = status.record;
    const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
    try {
      for (const threadId of threadIdsToDelete) {
        if (!snapshot.threads.find((t) => t.id === threadId)) continue; // already gone
        try {
          await client.dispatchCommand({
            type: "thread.session.stop",
            commandId: makeId("cmd"),
            threadId,
            createdAt: isoNow(),
          });
        } catch {
          // ignore
        }
        try {
          await client.dispatchCommand({
            type: "thread.delete",
            commandId: makeId("cmd"),
            threadId,
          });
        } catch {
          // ignore
        }
        console.error(`ludics: briefing cleanup: deleted t3code thread ${threadId}`);
      }
    } finally {
      client.close();
    }
  } catch {
    // t3code not available or other error — skip silently
  }
}

/**
 * Ensure the t3code server is running if `mag.ensure_t3code` is not false.
 * Encapsulates config check, dynamic import, try/catch, and logging so that
 * the three call-sites (keepalive, fresh start, briefing) share a single
 * implementation.  Pass a short `context` string (e.g. "keepalive") that
 * appears in log messages to aid debugging.
 */
/**
 * Wrapper around syncStagingMainWithUpstream that wires up config,
 * sentinel directory, and event emission. Guarded by clusterIsController so
 * only one machine runs git operations. Sentinel files throttle to once per
 * 24 hours per project. See src/staging-ff.ts for the core logic.
 */
function runStagingFastForwardTick(): void {
  try {
    if (!clusterIsController()) return;
    const cfg = loadConfigSync();
    if ((cfg.mag as { enable_staging_fast_forward?: boolean } | undefined)?.enable_staging_fast_forward === false) return;
    const projects = cfg.projects ?? [];
    if (projects.every((p) => !p.upstream_repo)) return;
    const sentinelDir = join(harnessDir(), "mag");
    mkdirSync(sentinelDir, { recursive: true });
    const results = syncStagingMainWithUpstream(projects, {
      now: new Date(),
      runGit: defaultRunGit,
      sentinelDir,
      emitEvent: (ev) => {
        emitEvent({
          event_type: ev.type,
          source: "mag",
          scope: "project",
          message: ev.message,
        });
      },
    });
    for (const r of results) {
      if (r.outcome === "fast-forwarded" || r.outcome === "diverged" || r.outcome === "error") {
        console.error(`ludics: staging-ff ${r.project}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`);
      }
    }
  } catch (err) {
    console.error(`ludics: staging-ff tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * gh-ludics-540: outbound staging→upstream fast-forward push tick.
 *
 * Sibling of `runStagingFastForwardTick`. Gated by:
 *   1. `clusterIsController()` — federation invariant; controller-only writes.
 *   2. `cfg.mag.enable_staging_fast_forward !== false` — same operator
 *      escape hatch as inbound (kills both directions in one switch).
 *   3. Per-project `outbound_sync_enabled === true` filter — the
 *      proposal's conservative opt-in. Absent / `false` → off.
 *
 * Optional injectable deps make this testable from `src/mag.test.ts`
 * without writing config to disk or being on a real controller node.
 */
export function runStagingOutboundPushTick(opts?: {
  runGit?: RunGit;
  isController?: () => boolean;
  config?: LudicsFullConfig;
  sentinelDir?: string;
  now?: Date;
}): OutboundPushProjectResult[] {
  try {
    const isCtrl = opts?.isController ?? clusterIsController;
    if (!isCtrl()) return [];
    const cfg = opts?.config ?? loadConfigSync();
    if ((cfg.mag as { enable_staging_fast_forward?: boolean } | undefined)?.enable_staging_fast_forward === false) return [];
    const projects = (cfg.projects ?? []).filter(
      (p) => !!p.upstream_repo && p.outbound_sync_enabled === true,
    );
    if (projects.length === 0) return [];
    const sentinelDir = opts?.sentinelDir ?? join(harnessDir(), "mag");
    mkdirSync(sentinelDir, { recursive: true });
    const results = syncUpstreamMainFromStaging(projects, {
      now: opts?.now ?? new Date(),
      runGit: opts?.runGit ?? defaultRunGit,
      sentinelDir,
      emitEvent: (ev) => {
        emitEvent({
          event_type: ev.type,
          source: "mag",
          scope: "project",
          message: ev.message,
        });
      },
    });
    for (const r of results) {
      if (
        r.outcome === "pushed" ||
        r.outcome === "skipped-not-fast-forward" ||
        r.outcome === "skipped-no-push-credentials" ||
        r.outcome === "skipped-local-staging-behind" ||
        r.outcome === "error"
      ) {
        console.error(
          `ludics: outbound-staging-ff ${r.project}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`,
        );
      }
    }
    return results;
  } catch (err) {
    console.error(
      `ludics: outbound-staging-ff tick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function ensureT3codeIfEnabled(context: string): Promise<void> {
  const magConfig = loadConfigSync().mag as Record<string, unknown> | undefined;
  if (magConfig?.ensure_t3code === false) return;
  console.error(`ludics: ensureServer (${context}): ensuring t3code server...`);
  try {
    const { ensureServer } = await import("./t3code/server.ts");
    await ensureServer({ harnessDir: harnessDir() });
    console.error(`ludics: ensureServer (${context}): t3code server ready`);
  } catch (err) {
    console.error(`ludics: ensureServer (${context}): failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function briefingPrecomputeContext(opts?: { runGit?: RunGit }): Promise<void> {
  // Ensure t3code server is running before briefing (it dies on overnight shutdown)
  await ensureT3codeIfEnabled("briefing");

  // Clean up t3code threads for completed tasks before building the context
  await cleanupDoneTaskThreads();

  // Process deferred artifact cleanup (worktrees, branches, tmux sessions, peer-sync)
  try {
    const { processDeferredCleanups } = await import("./orchestration/deferred-cleanup.ts");
    await processDeferredCleanups();
  } catch (err) {
    console.error("ludics: deferred cleanup failed:", err);
  }

  const harness = harnessDir();
  const contextFile = join(harness, "mag", "briefing-context.md");
  mkdirSync(join(harness, "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Capture slots
  const slotsR = safeSyncOutput(ludicsSelfCommand(["slots"]));
  const slotsOutput = slotsR.ok ? slotsR.stdout : "(unavailable)";

  // Capture sessions
  let sessionsContent = "(no sessions report available)";
  const sessionsFile = join(harness, "sessions.md");
  if (existsSync(sessionsFile)) {
    sessionsContent = readFileSync(sessionsFile, "utf-8");
  }

  // Flow ready
  const flowReadyR = safeSyncOutput(ludicsSelfCommand(["flow", "ready"]));
  const flowReadyOutput = flowReadyR.ok ? flowReadyR.stdout : "(unavailable)";

  // Flow critical
  const flowCriticalR = safeSyncOutput(ludicsSelfCommand(["flow", "critical"]));
  const flowCriticalOutput = flowCriticalR.ok ? flowCriticalR.stdout : "(unavailable)";

  // Tasks needing elaboration
  const needsElabR = safeSyncOutput(ludicsSelfCommand(["tasks", "needs-elaboration"]));
  const needsElabOutput = needsElabR.ok && needsElabR.stdout ? needsElabR.stdout : "None";

  // Recent journal
  const journalR = safeSyncOutput(ludicsSelfCommand(["journal", "recent", "20"]));
  const journalOutput = journalR.ok ? journalR.stdout : "(no journal entries)";

  // Same-day check
  let samedayStatus = "new";
  let existingDate = "none";
  const briefingFile = join(harness, "briefing.md");
  if (existsSync(briefingFile)) {
    const first = readFileSync(briefingFile, "utf-8").split("\n").slice(0, 5).join("\n");
    const dateMatch = first.match(/^# Briefing - (\d{4}-\d{2}-\d{2})/m);
    if (dateMatch) {
      existingDate = dateMatch[1]!;
      const today = new Date().toISOString().slice(0, 10);
      if (existingDate === today) samedayStatus = "amend";
    }
  }

  // Preempted slots
  let preemptedOutput = "(none)";
  const stashes = listStashes();
  if (stashes.length > 0) {
    preemptedOutput = stashes.map((s) =>
      `Slot ${s.slotNum}: preempted "${s.previousProcess}" (task=${s.previousTask}) at ${s.preemptedAt} for ${s.preemptingTask}`
    ).join("\n");
  }

  // Upstream vs staging lag — rendered per-project for projects with upstream_repo.
  // Empty string when no qualifying projects; in that case the section is omitted.
  const configForLag = loadConfigSync();
  const upstreamLag = formatUpstreamLagSection(configForLag.projects ?? [], {
    now: new Date(),
    runGit: opts?.runGit ?? defaultRunGit,
    // gh-ludics-540: lets formatUpstreamLagSection emit an
    // "outbound sentinel stale > 48h" annotation alongside the
    // existing FETCH_HEAD freshness note.
    sentinelDir: join(harnessDir(), "mag"),
  });
  const upstreamLagSection = upstreamLag
    ? `## Upstream vs Staging Lag\n\n${upstreamLag.trimEnd()}\n\n`
    : "";

  // gh-ludics-535 A9: orphan absorption. First passively reconcile so any
  // record whose result file has appeared is cleared (without this step, a
  // record that resolved between the last keepalive tick and the briefing
  // would still be on disk and the orphan filter would correctly skip it,
  // but the in-flight directory wouldn't be cleaned up). Then surface every
  // remaining in-flight record whose id is no longer in queue.jsonl AND
  // whose result file is still absent — that's the post-boot-race / lost-
  // delivery shape. Briefing context absorbs the orphan (paper trail) and
  // unlinks the record so the panel signal stays high.
  //
  // Exclude the currently-active delivery (the request whose id sits in
  // `mag/current-request-id`) from the orphan set. queuePopSkill removes
  // the entry from queue.jsonl BEFORE deliverPoppedSkill writes the
  // in-flight record, so during a Mag-turn delivery (including this
  // briefing's own delivery when it was popped as action: "briefing") the
  // record's id is absent from queue.jsonl but the delivery is still
  // genuinely active. Without this exclusion, briefing-prep would
  // unlink its own in-flight record and unblock deliveryGateBlocked(),
  // letting the next pop dispatch before the current delivery completes —
  // a load-bearing violation of the A3 gate invariant.
  reconcileInFlight();
  const queueIds = new Set(
    queueList().map(r => String(r.id ?? "")).filter(Boolean),
  );
  let activeRequestId = "";
  try {
    activeRequestId = readFileSync(join(harnessDir(), "mag", "current-request-id"), "utf-8").trim();
  } catch { /* file absent on fresh boot — no active delivery to exclude */ }
  const orphans = listInFlight().filter(
    r => r.requestId !== activeRequestId
      && !queueIds.has(r.requestId)
      && !existsSync(magResultFile(r.requestId)),
  );
  const orphanLines = orphans.length === 0
    ? "(none)"
    : orphans.map(o =>
        `- ${o.requestId} (${o.command}) — delivered ${o.deliveredAt}\n  line: ${o.line}`
      ).join("\n");
  const orphanSection = `## Unresolved Deliveries (orphans)\n\n${orphanLines}\n\n`;

  const contextContent = `# Briefing Context

Generated: ${timestamp}

## Same-Day Status

Status: ${samedayStatus}
Existing briefing date: ${existingDate}

## Slots State

${slotsOutput}

## Preempted Slots

${preemptedOutput}

${upstreamLagSection}## Sessions Report

${sessionsContent}

${computeSessionProjectMatches()}

## Flow: Ready Queue

${flowReadyOutput}

## Flow: Critical Items

${flowCriticalOutput}

## Tasks Needing Elaboration

${needsElabOutput}

## Recent Journal

${journalOutput}

${orphanSection}`;

  writeFileSync(contextFile + ".tmp", contextContent);
  renameSync(contextFile + ".tmp", contextFile);
  // After the section is written, unlink each orphan so the next briefing
  // doesn't re-surface a stanza for the same id. (Idempotent — ENOENT swallow.)
  for (const o of orphans) {
    clearInFlight(o.requestId);
  }
  console.error(`ludics: briefing context written to ${contextFile}`);
}

// --- Session-project matching for adopt-sessions ---

interface ProjectMatch {
  projectName: string;
  repo: string;
}

function matchCwdToProject(
  cwdNormalized: string,
  repoTailMap: Map<string, ProjectMatch>,
): ProjectMatch | null {
  const components = cwdNormalized.split("/").filter(Boolean);

  // Exact match: walk from rightmost component leftward
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i]!;
    if (repoTailMap.has(component)) {
      return repoTailMap.get(component)!;
    }
  }

  // Prefix match for worktree dirs (e.g., "ocannl-fix-xyz" matches "ocannl")
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i]!;
    for (const [tail, project] of repoTailMap) {
      if (component.startsWith(tail + "-") || component.startsWith(tail + ".")) {
        return project;
      }
    }
  }

  return null;
}

function computeSessionProjectMatches(): string {
  const harness = harnessDir();
  const sessionsFile = join(harness, "sessions.json");

  if (!existsSync(sessionsFile)) return "(no sessions data — run `ludics sessions report` first)";

  // Check freshness: skip if older than 15 minutes
  try {
    const mtime = statSync(sessionsFile).mtimeMs;
    if (Date.now() - mtime > 900_000) return "(stale session data — sessions.json older than 15 minutes)";
  } catch { return "(cannot read sessions.json)"; }

  // Parse sessions.json
  interface StrippedSession {
    cwd: string;
    cwdNormalized: string;
    agents: string[];
    ids: string[];
    lastActivityEpoch: number;
    lastActivity: string;
    stale: boolean;
    slot: number | null;
    slotPath: string | null;
    orchestration: { type: string; taskId: string; phase: string; round: string } | null;
    meta?: { tmux_session?: string; git_branch?: string; summary?: string; message_count?: number; port?: string };
  }

  let unclassified: StrippedSession[];
  try {
    const data = JSON.parse(readFileSync(sessionsFile, "utf-8")) as { unclassified?: StrippedSession[] };
    unclassified = data.unclassified ?? [];
  } catch { return "(invalid sessions.json)"; }

  if (unclassified.length === 0) return "(no unclassified sessions)";

  // Build repo-tail lookup from config
  const config = loadConfigSync();
  const projects = config.projects ?? [];
  const repoTailMap = new Map<string, ProjectMatch>();
  for (const p of projects) {
    const tail = (p.repo ?? "").split("/").pop() ?? "";
    if (!tail) continue;
    if (repoTailMap.has(tail)) {
      console.error(`ludics: adopt-sessions: duplicate repo tail "${tail}", keeping first`);
      continue;
    }
    repoTailMap.set(tail, { projectName: p.name, repo: p.repo });
  }

  if (repoTailMap.size === 0) return "(no projects configured)";

  // Read current slots: track which projects already have a slot and which slots are empty
  const count = slotsCount();
  const slots = readAllSlotJson(count);
  const emptySlots: number[] = [];
  const projectsInSlots = new Map<string, number>(); // project name → slot number

  for (let i = 1; i <= count; i++) {
    const data = slots.get(i);
    const process = data ? data.process : "(empty)";
    if (!process || process === "(empty)") {
      emptySlots.push(i);
    } else if (data) {
      // Infer project from task or path
      const taskId = data.task ?? "";
      if (taskId) {
        const taskFile = join(harness, "tasks", `${taskId}.md`);
        if (existsSync(taskFile)) {
          const content = readFileSync(taskFile, "utf-8");
          const pm = parseTaskFrontmatter(content).project;
          if (pm) projectsInSlots.set(pm, i);
        }
      }
      // Also check path for project match
      const slotPath = data.path ?? "";
      if (slotPath) {
        const pathMatch = matchCwdToProject(slotPath, repoTailMap);
        if (pathMatch && !projectsInSlots.has(pathMatch.projectName)) {
          projectsInSlots.set(pathMatch.projectName, i);
        }
      }
    }
  }

  // Read ready tasks grouped by project
  const tasksDir = join(harness, "tasks");
  const tasksByProject = new Map<string, { id: string; title: string; priority: string; elaborated: boolean }[]>();

  if (existsSync(tasksDir)) {
    const taskFiles = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
    // Collect task IDs already in slots
    const tasksInSlots = new Set<string>();
    for (const [, data] of slots) {
      const tid = data.task ?? "";
      if (tid) tasksInSlots.add(tid);
    }

    for (const f of taskFiles) {
      const content = readFileSync(join(tasksDir, f), "utf-8");
      const fm = parseTaskFrontmatter(content);
      const id = fm.id;
      if (!id) continue;
      if (tasksInSlots.has(id)) continue;

      if (fm.status !== "ready") continue;

      const blockedBy = fm.dependencies?.blocked_by ?? [];
      if (blockedBy.length > 0) continue;

      const project = fm.project ?? "";
      if (!project) continue;

      const title = fm.title || id;
      const priority = fm.priority ?? "B";

      const elaborated = isElaborated(content);

      const arr = tasksByProject.get(project) ?? [];
      arr.push({ id, title, priority, elaborated });
      tasksByProject.set(project, arr);
    }
  }

  // Sort tasks within each project: elaborated first, then by priority
  for (const [, tasks] of tasksByProject) {
    tasks.sort((a, b) => {
      if (a.elaborated !== b.elaborated) return a.elaborated ? -1 : 1;
      return priorityValue(a.priority) - priorityValue(b.priority);
    });
  }

  // Match sessions to projects and format output
  const lines: string[] = [];
  const matchedSessions: string[] = [];
  const unmatchedSessions: string[] = [];

  for (const session of unclassified) {
    const match = matchCwdToProject(session.cwdNormalized, repoTailMap);
    if (match) {
      const agents = session.agents.join(", ");
      const staleTag = session.stale ? "yes" : "no";
      const inSlot = projectsInSlots.has(match.projectName);

      matchedSessions.push(`### ${session.agents[0] ?? "unknown"} — ${session.cwd}`);
      matchedSessions.push(`- **Agents:** ${agents}`);
      matchedSessions.push(`- **Session IDs:** ${session.ids.join(", ")}`);
      matchedSessions.push(`- **Project:** ${match.projectName}`);
      matchedSessions.push(`- **Stale:** ${staleTag}`);
      if (inSlot) {
        matchedSessions.push(`- **Project already in slot:** ${projectsInSlots.get(match.projectName)}`);
      }
      // Session metadata
      const meta = session.meta;
      if (meta) {
        if (meta.tmux_session) matchedSessions.push(`- **tmux session:** ${meta.tmux_session}`);
        if (meta.git_branch) matchedSessions.push(`- **Git branch:** ${meta.git_branch}`);
        if (meta.summary) matchedSessions.push(`- **Summary:** ${meta.summary}`);
      }
      if (session.orchestration) {
        const o = session.orchestration;
        matchedSessions.push(`- **Orchestration:** ${o.type} (task: ${o.taskId || "?"}, phase: ${o.phase || "?"})`);
      }
      // Determine recommended adapter based on what infrastructure exists
      const hasAgentSessions = existsSync(join(session.cwdNormalized, ".agent-sessions"));
      if (session.orchestration) {
        matchedSessions.push(`- **Recommended adapter:** t3code (orchestration detected: ${session.orchestration.type})`);
      } else if (hasAgentSessions) {
        matchedSessions.push(`- **Recommended adapter:** t3code (.agent-sessions/ found)`);
      } else {
        matchedSessions.push(`- **Recommended adapter:** manual (no orchestration metadata)`);
      }

      const tasks = tasksByProject.get(match.projectName);
      if (tasks && tasks.length > 0) {
        matchedSessions.push(`- **Ready tasks for project:**`);
        for (const t of tasks.slice(0, 5)) {
          const elab = t.elaborated ? "elaborated" : "not elaborated";
          matchedSessions.push(`  - ${t.id} (${t.priority}, ${elab}): ${t.title}`);
        }
        if (tasks.length > 5) matchedSessions.push(`  - ... and ${tasks.length - 5} more`);
      } else {
        matchedSessions.push(`- **Ready tasks for project:** (none)`);
      }
      matchedSessions.push("");
    } else {
      const unmatchedMeta: string[] = [];
      if (session.meta?.tmux_session) unmatchedMeta.push(`tmux: ${session.meta.tmux_session}`);
      if (session.meta?.git_branch) unmatchedMeta.push(`branch: ${session.meta.git_branch}`);
      if (session.meta?.summary) unmatchedMeta.push(`summary: ${session.meta.summary}`);
      const metaSuffix = unmatchedMeta.length > 0 ? ` [${unmatchedMeta.join(", ")}]` : "";
      unmatchedSessions.push(`- ${session.agents[0] ?? "unknown"} — ${session.cwd} (no matching project)${metaSuffix}`);
    }
  }

  lines.push("## Session-Project Matches");
  lines.push("");

  if (matchedSessions.length > 0) {
    lines.push(...matchedSessions);
  } else {
    lines.push("(no sessions matched to projects)");
    lines.push("");
  }

  if (unmatchedSessions.length > 0) {
    lines.push("### Unmatched Sessions");
    lines.push("");
    lines.push(...unmatchedSessions);
    lines.push("");
  }

  lines.push("## Slot Availability");
  lines.push("");
  if (emptySlots.length > 0) {
    lines.push(`- **Empty slots:** ${emptySlots.join(", ")}`);
  } else {
    lines.push("- **Empty slots:** (none)");
  }
  if (projectsInSlots.size > 0) {
    const entries = Array.from(projectsInSlots.entries()).map(([p, s]) => `${p} (slot ${s})`);
    lines.push(`- **Projects already in slots:** ${entries.join(", ")}`);
  }

  return lines.join("\n");
}

function adoptSessionsPrecomputeContext(): void {
  const harness = harnessDir();
  const contextFile = join(harness, "mag", "adopt-sessions-context.md");
  mkdirSync(join(harness, "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const matches = computeSessionProjectMatches();

  const content = `# Adopt Sessions Context

Generated: ${timestamp}

${matches}
`;

  writeFileSync(contextFile + ".tmp", content);
  renameSync(contextFile + ".tmp", contextFile);
  console.error(`ludics: adopt-sessions context written to ${contextFile}`);
}

// --- Auto-queue proposals ---

const AUTO_PROPOSAL_DEBOUNCE_SECONDS = 1800;

export function autoProposalDebounceFile(taskId: string): string {
  return join(magStateDir(), "auto-proposal-debounce", `${encodeURIComponent(taskId)}.epoch`);
}

function autoProposalDebounced(taskId: string): boolean {
  return sentinelFresh(autoProposalDebounceFile(taskId), new Date(), AUTO_PROPOSAL_DEBOUNCE_SECONDS);
}

function markAutoProposalQueued(taskId: string): void {
  touchSentinel(autoProposalDebounceFile(taskId));
}

/**
 * Remove the auto-proposal debounce sentinel for a task. Best-effort;
 * absent files are silently ignored. Called from priority-bump and
 * queue-promote seams as the user-driven "act on this now" lever.
 */
export function clearAutoProposalDebounce(taskId: string): void {
  clearSentinel(autoProposalDebounceFile(taskId));
}

// --- Container completion sweep debounce + child-set fingerprint ---
//
// Mirrors the auto-proposal-debounce shape but pairs the freshness sentinel
// with a `.children` sidecar that records the parent's child-set state at
// last enqueue. The sweep clears the sentinel whenever the current child
// set differs (reopen, new child added — even one that is already terminal),
// satisfying the AC7 reset rules without write-time hooks.

const CONTAINER_COMPLETION_DEBOUNCE_SECONDS = 6 * 3600;

function containerCompletionDir(): string {
  return join(magStateDir(), "container-completion-checked");
}

export function containerCompletionDebounceFile(parentId: string): string {
  return join(containerCompletionDir(), `${encodeURIComponent(parentId)}.epoch`);
}

export function containerCompletionChildrenFile(parentId: string): string {
  return join(containerCompletionDir(), `${encodeURIComponent(parentId)}.children`);
}

export function containerCompletionDebounced(parentId: string): boolean {
  return sentinelFresh(containerCompletionDebounceFile(parentId), new Date(), CONTAINER_COMPLETION_DEBOUNCE_SECONDS);
}

export function markContainerCompletionQueued(parentId: string): void {
  touchSentinel(containerCompletionDebounceFile(parentId));
}

export function clearContainerCompletionSentinel(parentId: string): void {
  clearSentinel(containerCompletionDebounceFile(parentId));
  try { unlinkSync(containerCompletionChildrenFile(parentId)); } catch { /* best-effort */ }
}

export function readContainerCompletionFingerprint(parentId: string): string | null {
  const f = containerCompletionChildrenFile(parentId);
  if (!existsSync(f)) return null;
  try { return readFileSync(f, "utf-8"); } catch { return null; }
}

export function writeContainerCompletionFingerprint(parentId: string, fp: string): void {
  const f = containerCompletionChildrenFile(parentId);
  mkdirSync(dirname(f), { recursive: true });
  atomicWriteFileSync(f, fp);
}

/** Auto-start slots that have proposals but no active session. */
async function maybeAutoStartSlots(): Promise<void> {
  if (startSessionsAutonomy() === "manual") return;

  const slots = readAllSlotJson(slotsCount());
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, data] of slots) {
    const process = data.process;
    if (!process || process === "(empty)") continue;

    const taskId = data.task ?? "";
    if (!taskId) continue;

    // Skip slots already marked as interrupted (setup failure) or escalated
    // (agent-initiated halt per task-4cd94043) — both require manual resume.
    // Mag must not silently restart an escalation; only explicit user action
    // (`ludics slot N resume`) clears the marker.
    const slotLiveness = data.liveness ?? "";
    if (slotLiveness === "interrupted" || slotLiveness === "escalated") continue;

    // Skip if the slot has an active session for the CURRENT task
    const orchState = readOrchestrationState(slotNum);
    if (orchState && orchState.taskId !== taskId) {
      // Stale orch state from a different task — delete it (may have been restored by git sync)
      const orchFile = join(harnessDir(), "orchestration", `slot-${slotNum}.json`);
      try { unlinkSync(orchFile); } catch { /* ignore */ }
      console.error(`ludics: deleted stale orchestration state for slot ${slotNum} (was ${orchState.taskId}, now ${taskId})`);
    } else if (orchState && orchState.phase !== "setup") continue;
    const sessionStarted = data.sessionStarted ?? "";
    if (sessionStarted) continue;

    // Skip remote slots that already have a fresh pending start intent —
    // prevents re-recording the intent every keepalive.
    const slotMachine = data.machine ?? "";
    if (slotMachine && isRemoteMachine(slotMachine)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy to avoid import cycle: mag.ts → cluster-http.ts → (journal/events chain back into mag)
        const { getIntentForDashboard } = require("./cluster-http.ts") as typeof import("./cluster-http.ts");
        const existing = getIntentForDashboard(slotNum);
        if (existing && existing.action === "start") continue;
      } catch { /* ignore */ }
    }

    // Read task file — check for proposal
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");
    if (!content.includes("\nproposal:")) continue;

    // Skip deferred tasks
    if (isTaskDeferred(taskId)) continue;

    // Skip tasks from postponed projects
    const projectName = parseTaskFrontmatter(content).project;
    if (projectName && postponedProjectSet().has(projectName.toLowerCase())) continue;

    // Task has a proposal but no session — auto-start
    try {
      await slotStart(slotNum);
      emitEvent({ event_type: "slot_auto_start", source: "keepalive", scope: "slot", slot: slotNum, task: taskId, message: `auto-started slot ${slotNum} for ${taskId} (proposal exists, no session)` });
      console.error(`ludics: auto-started slot ${slotNum} for ${taskId} (proposal exists, no session)`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`ludics: failed to auto-start slot ${slotNum}: ${detail}`);
      markSlotSetupFailed(slotNum, detail);
    }
  }
}

/** Detect slots assigned but stuck: no proposal and no active session.
 *  Re-queues draft-proposal if the task is elaborated and has no unanswered questions.
 *  Logs slot_unstick events for visibility. */
function maybeUnstickAssignedSlots(): void {
  if (startSessionsAutonomy() === "manual") return;

  const slots = readAllSlotJson(slotsCount());
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, data] of slots) {
    const process = data.process;
    if (!process || process === "(empty)") continue;

    const taskId = data.task ?? "";
    if (!taskId) continue;

    // Skip slots marked as interrupted or escalated — both need explicit
    // `ludics slot N resume` (no automatic unstick).
    const slotLiveness = data.liveness ?? "";
    if (slotLiveness === "interrupted" || slotLiveness === "escalated") continue;

    // Skip if session is active
    const sessionStarted = data.sessionStarted ?? "";
    if (sessionStarted) continue;

    // Skip if there's an active orchestration
    const orchState = readOrchestrationState(slotNum);
    if (orchState && orchState.phase !== "done") continue;

    // Read task file
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");

    // Task is terminal (done / abandoned / merged / stale) — nothing to unstick.
    const unstickStatus = parseTaskFrontmatter(content).status ?? "";
    if (TERMINAL_STATUSES.includes(unstickStatus)) continue;

    // Already has proposal — maybeAutoStartSlots handles this
    if (content.includes("\nproposal:")) continue;

    // Has unanswered questions — by design, wait for user
    if (content.includes("\nhas_questions:")) continue;

    // Not elaborated — needs elaboration first
    if (!isElaborated(content)) {
      if (!autoProposalDebounced(taskId) && !queueHasPendingActionForTask("elaborate", taskId)) {
        queueRequest({ action: "elaborate", task: taskId });
        markAutoProposalQueued(taskId);
        emitEvent({ event_type: "slot_unstick", source: "keepalive", scope: "slot", slot: slotNum, task: taskId, message: `queued elaboration for stuck slot ${slotNum}` });
        console.error(`ludics: slot ${slotNum} stuck — queued elaboration for ${taskId}`);
      }
      continue;
    }

    // Elaborated, no questions, no proposal — re-queue draft-proposal
    // Skip if already queued for this specific task (prevents spam when
    // the orchestrator skips in-progress tasks without writing a proposal)
    if (!autoProposalDebounced(taskId) && !queueHasPendingActionForTask("draft-proposal", taskId)) {
      queueRequest({ action: "draft-proposal", task: taskId });
      markAutoProposalQueued(taskId);
      emitEvent({ event_type: "slot_unstick", source: "keepalive", scope: "slot", slot: slotNum, task: taskId, message: `re-queued draft-proposal for stuck slot ${slotNum}` });
      console.error(`ludics: slot ${slotNum} stuck — re-queued draft-proposal for ${taskId}`);
    }
  }
}

/** Queue draft-proposals for the top ready queue tasks that are
 *  elaborated, have no unanswered questions, and have no proposal yet.
 *  Uses the same sorted candidate list as maybeFillEmptySlots. */
function maybeQueueProposals(config?: LudicsFullConfig): void {
  if (startSessionsAutonomy() === "manual") return;
  if (isQueueHeld()) return; // hold suppresses proposals too

  // Check if draft-proposal is already in queue
  const qFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(qFile)) {
    const qContent = readFileSync(qFile, "utf-8");
    if (qContent.includes('"draft-proposal"')) return;
  }

  // Reuse the sorted ready queue from maybeFillEmptySlots logic
  const sorted = getSortedReadyCandidates(config);
  if (sorted.length === 0) return;

  const tasksDir = join(harnessDir(), "tasks");

  // Find the first candidate that needs a proposal
  for (const task of sorted.slice(0, slotsCount())) {
    if (!task.elaborated) continue;

    // Read task content for additional checks
    const taskFile = join(tasksDir, `${task.id}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");

    if (content.includes("\nhas_questions:")) continue;
    if (content.includes("\nproposal:")) continue;
    if (autoProposalDebounced(task.id)) continue;

    queueRequest({ action: "draft-proposal", task: task.id });
    markAutoProposalQueued(task.id);
    console.error(`ludics: auto-queued draft-proposal for ${task.id} (ready queue position)`);
    return; // one per cycle
  }
}


// --- Queue hold state ---

/** Returns the path to the queue-hold sentinel file. */
function queueHoldFilePath(): string {
  return join(harnessDir(), "mag", "queue-hold");
}

/** Returns true when the queue is held (auto-assignment suppressed). */
export function isQueueHeld(): boolean {
  return existsSync(queueHoldFilePath());
}

/** Shared helper: set queue hold state. Returns true if state changed, false if already matched. */
export function setQueueHold(held: boolean, source: string): boolean {
  if (held === isQueueHeld()) return false;
  if (held) {
    mkdirSync(join(harnessDir(), "mag"), { recursive: true });
    writeFileSync(queueHoldFilePath(), "");
  } else {
    unlinkSync(queueHoldFilePath());
  }
  emitEvent({ event_type: "queue_hold", source, scope: "queue", action: held ? "hold" : "resume" });
  try { stateMarkDirty(); } catch { /* best-effort */ }
  return true;
}

/** CLI: hold the queue (suppress auto-assignment). */
export function queueHold(): void {
  if (!setQueueHold(true, "cli")) {
    console.log("Queue is already held — no change.");
    return;
  }
  console.log("Queue held — auto-assignment suppressed.");
}

/** CLI: resume the queue (re-enable auto-assignment). */
export function queueResume(): void {
  if (!setQueueHold(false, "cli")) {
    console.log("Queue is not held — no change.");
    return;
  }
  console.log("Queue resumed — auto-assignment enabled.");
}

/** CLI: print current queue hold status. */
export function queueHoldStatus(): void {
  if (isQueueHeld()) {
    console.log("Queue is currently HELD — auto-assignment suppressed.");
  } else {
    console.log("Queue is ACTIVE — auto-assignment enabled.");
  }
}

// --- Sorted ready queue (shared) ---

/** Look up a ProjectConfig by task project name (matches name or repo tail). */
/** Merge task-level and project-level hardware requirements.
 *  Task values take precedence over project values for the same key. */
export function mergeRequirements(
  task?: { os?: string; gpu?: string },
  project?: { os?: string; gpu?: string },
): { os?: string; gpu?: string } | undefined {
  if (!task && !project) return undefined;
  const merged = {
    os: task?.os ?? project?.os,
    gpu: task?.gpu ?? project?.gpu,
  };
  if (!merged.os && !merged.gpu) return undefined;
  return merged;
}

export interface ReadyCandidate { id: string; priority: string; project: string; milestone?: string; hasDeadline: boolean; deadline: string; effort: string; elaborated: boolean; requirements?: { os?: string; gpu?: string } }

/** Compute the sorted ready queue — single source of truth for task ordering.
 *  Used by maybeFillEmptySlots, maybeQueueProposals, and dashboard generation.
 *  Exported for direct testability (mirrors the mergeRequirements pattern in
 *  this file). Container tasks (frontmatter `leaf: false`) are filtered out
 *  here so every consumer inherits the exclusion. */
export function getSortedReadyCandidates(config?: LudicsFullConfig): ReadyCandidate[] {
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return [];
  const cfg = config ?? loadConfigSync();

  // Determine which tasks are already in slots
  const count = slotsCount();
  const slots = readAllSlotJson(count);
  const tasksInSlots = new Set<string>();
  for (let i = 1; i <= count; i++) {
    const data = slots.get(i);
    const taskId = data ? (data.task ?? "") : "";
    if (taskId) tasksInSlots.add(taskId);
  }

  const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
  const candidates: ReadyCandidate[] = [];
  const allTasksForAffinity: AffinityInput[] = [];

  for (const f of files) {
    const content = readFileSync(join(tasksDir, f), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    let fm: Record<string, unknown>;
    try { fm = YAML.parse(fmMatch[1]!, { uniqueKeys: false }) as Record<string, unknown>; } catch { continue; }

    const id = String(fm.id ?? "").trim();
    if (!id) continue;

    const status = String(fm.status ?? "ready").trim();
    const deps = (fm.dependencies as Record<string, unknown>) ?? {};

    allTasksForAffinity.push({
      id, status,
      completed: fm.completed ? String(fm.completed) : null,
      dependencies: {
        blocks: Array.isArray(deps.blocks) ? deps.blocks as string[] : [],
        blocked_by: Array.isArray(deps.blocked_by) ? deps.blocked_by as string[] : [],
        relates_to: Array.isArray(deps.relates_to) ? deps.relates_to as string[] : [],
      },
    });

    if (tasksInSlots.has(id)) continue;
    // Container tasks (work split into subtasks) are not actionable. The check
    // is `=== false` (not falsy) so legacy tasks without the field are kept.
    // Defensive coercion handles a stringified "false" from malformed input.
    const leafRaw = fm.leaf;
    if (leafRaw === false || leafRaw === "false") continue;
    if (status !== "ready") continue;
    const blockedBy = deps.blocked_by;
    if (Array.isArray(blockedBy) && blockedBy.length > 0) continue;
    const project = String(fm.project ?? "").trim();
    if (postponedProjectSet().has(project.toLowerCase())) continue;

    const priority = String(fm.priority ?? "B").trim();
    const milestone = fm.milestone ? String(fm.milestone).trim() : undefined;
    const deadlineRaw = fm.deadline ? String(fm.deadline).trim() : "";
    const deadline = deadlineRaw && deadlineRaw !== "null" ? deadlineRaw : "";
    const effort = String(fm.effort ?? "small").trim();
    const elaborated = isElaborated(content);
    const taskReqs = fm.requirements ? fm.requirements as { os?: string; gpu?: string } : undefined;
    const projectReqs = findProjectConfigByName(project, cfg)?.requirements;
    const requirements = mergeRequirements(taskReqs, projectReqs);

    candidates.push({ id, priority, project, milestone, hasDeadline: !!deadline, deadline, effort, elaborated, requirements });
  }

  if (candidates.length === 0) return [];

  // Sort by: relative milestone position > effective priority > affinity tier > deadline
  const milestonesProjects = milestonesEnabledProjects();
  const affinity = buildAffinityLookup(allTasksForAffinity, tasksInSlots);

  const milestonePosition = new Map<string, number>();
  if (milestonesProjects.size > 0) {
    const projectMilestones = new Map<string, Set<string>>();
    for (const c of candidates) {
      if (!milestonesProjects.has(c.project) || !c.milestone) continue;
      let ms = projectMilestones.get(c.project);
      if (!ms) { ms = new Set(); projectMilestones.set(c.project, ms); }
      ms.add(c.milestone);
    }
    for (const [project, ms] of projectMilestones) {
      const sorted = [...ms].sort();
      for (let i = 0; i < sorted.length; i++) {
        milestonePosition.set(`${project}\0${sorted[i]}`, i);
      }
    }
  }

  function relMilestonePos(c: ReadyCandidate): number {
    if (!c.milestone || !milestonesProjects.has(c.project)) return 0;
    return milestonePosition.get(`${c.project}\0${c.milestone}`) ?? 0;
  }

  candidates.sort((a, b) => {
    const mp = relMilestonePos(a) - relMilestonePos(b);
    if (mp !== 0) return mp;
    const pd = effectivePriorityValue(a.priority, a.project) - effectivePriorityValue(b.priority, b.project);
    if (pd !== 0) return pd;
    const td = affinity.getTier(a.id) - affinity.getTier(b.id);
    if (td !== 0) return td;
    if (a.hasDeadline !== b.hasDeadline) return a.hasDeadline ? -1 : 1;
    return (a.deadline || "9999").localeCompare(b.deadline || "9999");
  });

  return candidates;
}

// --- Auto-fill empty slots ---

async function maybeFillEmptySlots(config?: LudicsFullConfig): Promise<void> {
  if (startSessionsAutonomy() === "manual") return;
  if (isQueueHeld()) return;

  const count = slotsCount();
  const slots = readAllSlotJson(count);
  const emptySlots: number[] = [];

  for (let i = 1; i <= count; i++) {
    const data = slots.get(i);
    const process = data ? data.process : "(empty)";
    if (!process || process === "(empty)") {
      emptySlots.push(i);
    }
  }

  if (emptySlots.length === 0) return;

  const candidates = getSortedReadyCandidates(config);
  if (candidates.length > 0) {
    const top5 = candidates.slice(0, 5).map((c) => `${c.id}(p=${c.priority},ep=${effectivePriorityValue(c.priority, c.project)},elab=${c.elaborated})`);
    console.error(`ludics: auto-fill candidates (top 5): ${top5.join(", ")}`);
  }

  // Fill at most 1 empty slot per keepalive cycle (conservative)
  // If the top candidate isn't elaborated, queue elaboration instead of assigning
  const topCandidate = candidates[0]!;
  if (!topCandidate.elaborated) {
    if (!autoProposalDebounced(topCandidate.id)) {
      queueRequest({ action: "elaborate", task: topCandidate.id });
      markAutoProposalQueued(topCandidate.id); // reuse debounce to avoid re-queuing
      emitEvent({ event_type: "task_elaborate_queued", source: "keepalive", scope: "task", task: topCandidate.id, message: `top candidate needs elaboration` });
      console.error(`ludics: top candidate ${topCandidate.id} needs elaboration — queued`);
    }
    // Skip to the first elaborated candidate for slot assignment
    const elaboratedIdx = candidates.findIndex((c) => c.elaborated);
    if (elaboratedIdx < 0) return; // no elaborated candidates at all
    candidates.splice(0, elaboratedIdx); // remove unelabroated ones from front
  }

  // Similarly, if the top candidate has no proposal, queue draft-proposal
  // and skip to the first candidate that does have one.
  // This prevents assigning tasks that can't be auto-started yet.
  {
    const topTask = candidates[0]!;
    const topTaskFile = join(harnessDir(), "tasks", `${topTask.id}.md`);
    const topContent = existsSync(topTaskFile) ? readFileSync(topTaskFile, "utf-8") : "";
    if (!topContent.includes("\nproposal:")) {
      // Don't assign — queue proposal generation instead
      if (!autoProposalDebounced(topTask.id) && !queueHasPendingActionForTask("draft-proposal", topTask.id)) {
        if (topContent.includes("\nhas_questions:")) {
          // Can't generate proposal yet — skip this candidate entirely
        } else {
          queueRequest({ action: "draft-proposal", task: topTask.id });
          markAutoProposalQueued(topTask.id);
          console.error(`ludics: top candidate ${topTask.id} needs proposal — queued draft-proposal`);
        }
      }
      // Skip to the first candidate with a proposal for slot assignment
      const proposalIdx = candidates.findIndex((c) => {
        const f = join(harnessDir(), "tasks", `${c.id}.md`);
        return existsSync(f) && readFileSync(f, "utf-8").includes("\nproposal:");
      });
      if (proposalIdx < 0) return; // no candidates with proposals
      candidates.splice(0, proposalIdx);
    }
  }

  const task = candidates[0]!;

  // Read task file content for skip_plan detection
  const taskFile = join(harnessDir(), "tasks", `${task.id}.md`);
  const taskContent = existsSync(taskFile) ? readFileSync(taskFile, "utf-8") : "";

  // Auto-select orchestration flags based on task effort and skip_plan
  const { adapter: autoAdapter, args: autoArgs, isDuo } = selectOrchestrationFlagsForTask(taskContent, task.effort, config);

  // Hierarchical duo: need 2 empty slots; assign both with swapped coder/reviewer
  if (isDuo) {
    if (emptySlots.length < 2) {
      console.error(`ludics: duo task ${task.id} needs 2 empty slots but only ${emptySlots.length} available — skipping`);
      // Try next non-duo candidate (if any)
      return;
    }
    // Guard: check task isn't already assigned to any active slot
    for (const [, data] of slots) {
      if (data && (data.task ?? "") === task.id) {
        console.error(`ludics: duo task ${task.id} already assigned — skipping`);
        return;
      }
    }
    const slotA = emptySlots[0]!;
    const slotB = emptySlots[1]!;
    const expansion = expandDuoSlots(slotA, slotB, autoArgs);
    const projectPath = resolveProjectPath(task.project);
    const machine = selectMachineForSlot({ project: task.project, effort: task.effort, requirements: task.requirements });
    if (machine === null) {
      console.error(`ludics: no machine meets requirements for ${task.id} — skipping`);
      return;
    }

    await slotAssign(slotA, task.id, autoAdapter, "", projectPath, expansion.slotA.args, machine);
    await slotAssign(slotB, task.id, autoAdapter, "", projectPath, expansion.slotB.args, machine);
    emitEvent({
      event_type: "slot_auto_fill_duo",
      source: "keepalive",
      scope: "slot",
      slot: slotA,
      task: task.id,
      adapter: autoAdapter,
      effort: task.effort,
      flags: expansion.slotA.args,
      machine: machine || undefined,
      message: `auto-assigned duo ${task.id} to slots ${slotA}+${slotB} with effort=${task.effort}${machine ? ` on ${machine}` : ""}`,
    });
    console.error(`ludics: auto-assigned duo ${task.id} to slots ${slotA}+${slotB} with effort=${task.effort} (${autoAdapter})${machine ? ` on ${machine}` : ""}`);
  } else {
    const slot = emptySlots[0]!;

    // Resolve project path from config
    const projectPath = resolveProjectPath(task.project);

    // Select machine for slot assignment (cluster-aware)
    const machine = selectMachineForSlot({ project: task.project, effort: task.effort, requirements: task.requirements });
    if (machine === null) {
      console.error(`ludics: no machine meets requirements for ${task.id} — skipping`);
      return;
    }

    // Assign task to the empty slot using the auto-selected adapter, path, and flags
    await slotAssign(slot, task.id, autoAdapter, "", projectPath, autoArgs, machine);
    emitEvent({
      event_type: "slot_auto_fill",
      source: "keepalive",
      scope: "slot",
      slot,
      task: task.id,
      adapter: autoAdapter,
      effort: task.effort,
      flags: autoArgs,
      machine: machine || undefined,
      message: `auto-assigned ${task.id} to slot ${slot} with effort=${task.effort}: ${autoArgs}${machine ? ` on ${machine}` : ""}`,
    });
    console.error(`ludics: auto-assigned ${task.id} to slot ${slot} with effort=${task.effort} (${autoAdapter} ${autoArgs})${machine ? ` on ${machine}` : ""}`);
  }

  // No need to queue draft-proposal here — we only assign tasks that
  // already have proposals (checked above).
}

// --- Auto-resume dead orchestrator processes ---

/**
 * Detect dead orchestrator processes and auto-resume via slotResume().
 * Follows the maybeClearDoneSlots() pattern.
 * Rate-limited: at most 1 resume per keepalive invocation.
 */
export function orchPidForSlotMode(
  slotNum: number,
  mode: string,
): number | undefined {
  if (mode === "t3code") {
    return readSlotState(slotNum)?.orchestration?.pid;
  }
  if (mode === "tmux") {
    return readTmuxSlotState(slotNum, harnessDir())?.orchestration?.pid;
  }
  return undefined;
}

async function maybeResumeDeadOrchestrators(freshSlots?: Map<number, SlotData> | null): Promise<void> {
  if (startSessionsAutonomy() === "manual") return;

  // On worker: use in-memory slots from HTTP fetch; otherwise read from JSON files
  const slots: Map<number, SlotData> = freshSlots ?? readAllSlotJson(slotsCount());
  let resumed = 0;

  for (const [slotNum, data] of slots) {
    if (resumed >= 1) break; // rate-limit: at most 1 per invocation

    // IMPORTANT: use `slotProcess` not `process` to avoid shadowing the global
    const slotProcess = data.process;
    if (!slotProcess || slotProcess === "(empty)") continue;

    const mode = data.mode ?? "";
    if (mode !== "t3code" && mode !== "tmux") continue;

    // Skip slots owned by a different machine — their PIDs are meaningless locally
    const slotMachine = data.machine ?? "";
    if (slotMachine && isRemoteMachine(slotMachine)) continue;

    const taskId = data.task ?? "";
    if (!taskId) continue;

    const orchState = readOrchestrationState(slotNum);
    if (!orchState) continue;
    if (orchState.phase === "done") continue;

    // Guard: orchestration state must match slot's current task
    if (orchState.taskId && orchState.taskId !== taskId) continue;

    const orchPid = orchPidForSlotMode(slotNum, mode);
    if (!orchPid || orchPid <= 0) continue;
    const pid = orchPid;
    let alive = true;
    try {
      process.kill(pid, 0); // global process — PID liveness check
    } catch {
      alive = false;
    }
    if (alive) continue;

    console.error(
      `ludics: detected dead orchestrator for slot ${slotNum} ` +
      `(pid ${pid}, task ${taskId}, phase ${orchState.phase}) — auto-resuming`,
    );
    try {
      await slotResume(slotNum);
      resumed += 1;
      emitEvent({
        event_type: "orchestration_auto_resume",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        deadPid: pid,
        message: `auto-resumed dead orchestrator (pid ${pid}, phase=${orchState.phase})`,
      });
    } catch (err) {
      console.error(
        `ludics: failed to auto-resume slot ${slotNum}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      emitEvent({
        event_type: "orchestration_auto_resume_failed",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        status: "failed",
        message: `auto-resume failed for slot ${slotNum}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

// --- Auto-clear slots whose task reached done status ---

async function maybeClearDoneSlots(): Promise<void> {
  if (startSessionsAutonomy() === "manual") return;

  const slots = readAllSlotJson(slotsCount());
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, data] of slots) {
    const process = data.process;
    if (!process || process === "(empty)") continue;

    const taskId = data.task ?? "";
    if (!taskId) continue;

    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;

    const content = readFileSync(taskFile, "utf-8");
    const taskStatus = parseTaskFrontmatter(content).status ?? "";

    if (taskStatus === "done") {
      console.error(`ludics: auto-clearing slot ${slotNum} (task ${taskId} is ${taskStatus})`);
      emitEvent({
        event_type: "slot_auto_clear",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        status: taskStatus,
        message: `auto-cleared slot ${slotNum}: task ${taskId} reached status=${taskStatus}`,
      });
      await slotClear(slotNum, taskStatus);
    }
  }
}

// --- Worker keepalive (machine-local automations, no controller duties) ---

async function workerKeepalive(): Promise<void> {
  console.error("ludics: worker keepalive");

  // Fetch fresh slots state from controller — in-memory only, never written to harness
  let freshSlots: Map<number, SlotData> | null = null;
  try {
    const { clusterGetSlots } = await import("./cluster-http.ts");
    const result = await clusterGetSlots();
    if (result.ok && result.data) {
      freshSlots = result.data;
    }
  } catch { /* null → downstream functions skip worker-specific work */ }

  // Publish terminal state for this machine's sessions
  publishTerminalState();

  // Poll controller for pending intents via HTTP (pure pull model)
  await processSlotIntents(freshSlots);

  // Resume dead orchestrator processes on this machine's slots
  await maybeResumeDeadOrchestrators(freshSlots);
}

/** Poll controller for pending intents and execute them (pure pull model). */
async function processSlotIntents(freshSlots: Map<number, SlotData> | null): Promise<void> {
  const currentMachine = clusterCurrentMachineName();
  if (!currentMachine) return;

  // On worker: poll controller for pending intents via HTTP
  try {
    if (!clusterIsController()) {
      if (!freshSlots) return; // no fresh state — skip
      const { clusterGetIntents, clusterDeleteIntent } = await import("./cluster-http.ts");
      const { setWorkerSlotsOverride } = await import("./slots/index.ts");
      const result = await clusterGetIntents();
      if (!result.ok || !result.data) return;
      // result.data is Record<number, PendingIntent> validated by
      // parsePendingIntent at the HTTP-client boundary — every entry's
      // action is "start" | "stop" | "resume", epoch is a finite integer,
      // and machine is a non-empty string. No re-cast needed.
      for (const [slotStr, intent] of Object.entries(result.data)) {
        const slotNum = Number(slotStr);
        if (intent.machine !== currentMachine) continue;
        if ((Math.floor(Date.now() / 1000) - intent.epoch) > 900) {
          await clusterDeleteIntent(slotNum).catch(() => {});
          continue;
        }
        let shouldAck = true;
        try {
          // Set fresh controller state so slot operations use it instead of stale local harness
          setWorkerSlotsOverride(freshSlots);
          try {
            switch (intent.action) {
              case "start": await slotStart(slotNum); break;
              case "stop": await slotStop(slotNum, false, intent.preserveState ?? false); break;
              case "resume": await slotResume(slotNum); break;
            }
          } finally {
            setWorkerSlotsOverride(null);
          }
          emitEvent({ event_type: `slot_intent_${intent.action}`, source: "keepalive", scope: "slot", slot: slotNum, message: `processed ${intent.action} intent` });
        } catch (err) {
          console.error(`ludics: intent ${intent.action} slot ${slotNum}: ${err instanceof Error ? err.message : String(err)}`);
          shouldAck = false;
        }
        if (shouldAck) {
          await clusterDeleteIntent(slotNum).catch(() => {});
          break; // rate-limit
        }
      }
      return;
    }
  } catch { /* standalone */ }

  // Controller path: no intents to process (controller dispatches directly)
}

// --- Mag CLI commands ---

export async function magStart(args: string[]): Promise<void> {
  let useTtyd = true;
  let skipCluster = false;

  for (const arg of args) {
    if (arg === "--no-ttyd") useTtyd = false;
    if (arg === "--skip-cluster") skipCluster = true;
  }

  if (!tmuxAvailable()) throw new Error("mag start: tmux is required but not installed");

  // Check cluster — on worker nodes, run machine-local automations only
  if (!skipCluster && !clusterShouldRunMag()) {
    if (magIsRunning()) {
      console.error("ludics: mag session exists but this node is no longer controller — stopping mag");
      tmuxKillSession(MAG_SESSION_NAME);
    }
    await workerKeepalive();
    return;
  }

  // Session already exists - keepalive path
  if (magIsRunning()) {
    // Re-check cluster on keepalive — controller may have changed since session started
    if (!skipCluster && !clusterShouldRunMag()) {
      console.error("ludics: mag session exists but this node is no longer controller — stopping mag");
      tmuxKillSession(MAG_SESSION_NAME);
      await workerKeepalive();
      return;
    }
    if (useTtyd) ensureTtyd();

    // Ensure t3code server is running (idempotent)
    await ensureT3codeIfEnabled("keepalive");

    // Publish terminal state to ntfy (dedup'd)
    publishTerminalState();

    // Expire pending-revise flags that timed out (15 min)
    expirePendingRevises();
    expirePendingFollowupRevises();

    // When paused, skip all automation — nothing queues, drains, or nudges
    if (existsSync(join(harnessDir(), "mag", "paused"))) return;

    // Auto-start slots that have proposals but no active session
    await maybeAutoStartSlots();

    // Detect stuck slots (assigned but no proposal/session) and re-queue
    maybeUnstickAssignedSlots();

    // Load config once for the keepalive cycle to avoid redundant file reads
    const keepaliveCfg = loadConfigSync();

    // Auto-queue proposals for top ready queue tasks (not slot-dependent)
    maybeQueueProposals(keepaliveCfg);

    // Auto-clear slots whose task reached done status
    await maybeClearDoneSlots();

    // Auto-resume dead orchestrator processes
    await maybeResumeDeadOrchestrators();

    // Once-daily staging fast-forward from upstream for projects with `upstream_repo`.
    // Never pushes, never touches slot worktrees, aborts on dirty worktree or divergence.
    runStagingFastForwardTick();

    // Once-daily outbound staging→upstream push for projects with
    // `outbound_sync_enabled: true`. Fast-forward-only by construction
    // (ancestry pre-check + git's server-side non-ff rejection; never
    // uses --force / --force-with-lease). gh-ludics-540.
    runStagingOutboundPushTick();

    // Auto-fill empty slots with ready elaborated tasks
    await maybeFillEmptySlots(keepaliveCfg);

    // If startup got stuck (e.g. Claude helper hung), recover automatically.
    maybeRecoverStuckStartup();

    // Drain programmatic queue items first (no Mag turn needed)
    if (queuePending()) await drainProgrammaticQueueHead();

    // If Mag resumed running (e.g. manual turn) since settling, clear stale sentinel
    clearStaleSettled();

    // Passive in-flight reconciliation (gh-ludics-535; supersedes the
    // gh-ludics-526 retry-cap pass). Confirm and clear records whose result
    // JSON has appeared. Kept here in addition to the in-function call in
    // maybeFeedMagQueue, because maybeFeedMagQueue returns early on an empty
    // queue and would otherwise never reconcile while the queue is drained.
    reconcileInFlight();

    // Settled-aware queue feed: deliver one Mag-turn item if settled
    const fed = await maybeFeedMagQueue();

    // Stall detection: nudge only if Mag is running, not settled, and pane is stagnant
    if (!fed) maybeNudgeStalledMag();

    // State is written to disk but NOT committed here — periodic health-check
    // handles git commits at lower frequency to avoid commit spam (task-4179d454).
    return;
  }

  // Create state directory
  const stateDir = magStateDir();
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  mkdirSync(join(stateDir, "memory", "projects"), { recursive: true });

  const workingDir = harnessDir();

  // Write state file
  const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  atomicWriteFileSync(magStateFile(), `session=${MAG_SESSION_NAME}\nstarted=${started}\nworking_dir=${workingDir}\nstatus=starting\n`);

  // Create tmux session
  console.error(`ludics: Creating Mag tmux session '${MAG_SESSION_NAME}' in ${workingDir}`);
  tmuxNewSession(MAG_SESSION_NAME, workingDir);
  // Prevent accidental wheel-scroll copy-mode lockups in web terminals.
  safeSyncOutput(["tmux", "set-option", "-t", MAG_SESSION_NAME, "mouse", "off"]);

  magSignal("running", "session started");
  emitEvent({ event_type: "mag_start", source: "cli", scope: "mag", message: `Mag session ${MAG_SESSION_NAME} started` });

  // Export environment variables for skills
  const statePath = harnessDir();
  const resultsPath = join(statePath, "mag", "results");
  mkdirSync(resultsPath, { recursive: true });
  const envExported = tmuxSendCommand(MAG_SESSION_NAME, `export LUDICS_STATE_PATH="${statePath}" LUDICS_RESULTS_DIR="${resultsPath}"`);
  if (!envExported) {
    console.error("ludics: failed to export environment variables in Mag tmux session");
  }
  safeSyncOutput(["sleep", "0.5"]);

  // Start Claude Code
  const hasClaude = safeSyncOutput(["which", "claude"]).ok;
  if (hasClaude) {
    writeStartupWatchdogEpoch();
    const claudeStarted = tmuxSendCommand(MAG_SESSION_NAME, claudeLaunchCommand());
    if (claudeStarted) {
      console.error("ludics: Started Claude Code in Mag session");
    } else {
      console.error("ludics: failed to send Claude start command to Mag tmux session");
      emitEvent({ event_type: "mag_startup_recover", source: "cli", scope: "mag", status: "failed", message: "tmux send-command failed at startup" });
    }
  } else {
    console.error("ludics: claude CLI not found; session started without Claude Code");
    clearStartupWatchdogEpoch();
  }

  console.log(`Mag session started. Attach with: tmux attach -t ${MAG_SESSION_NAME}`);

  if (useTtyd) ensureTtyd();

  // Ensure t3code server on fresh start
  await ensureT3codeIfEnabled("fresh start");

  // Poll the pane for Claude Code's idle prompt before marking settled.
  // Optimistically marking settled here (the former behavior) races with
  // Claude's splash/init on cold boots: keepalive feeds the queue into a
  // pane that is not yet consuming input, so the skill text vanishes.
  // Skip entirely when Claude isn't installed — isMagReady() could never
  // become true, and there's no point feeding the queue into a bare shell.
  if (hasClaude) {
    // Clear stale stall state from any previous session before the poll —
    // isMagReady() now tracks last-pane.hash and last-pane-change.epoch
    // itself, so the loop builds up fresh state.
    clearStallState();
    const readyDeadlineMs = Date.now() + 60_000;
    let becameReady = false;
    while (Date.now() < readyDeadlineMs) {
      if (isMagReady()) {
        becameReady = true;
        break;
      }
      safeSyncOutput(["sleep", "1"]);
    }
    if (becameReady) {
      markMagSettled();
      const fed = await maybeFeedMagQueue();
      if (fed) {
        console.error("ludics: Mag fresh start, delivered queued request via queue feed");
      }
    } else {
      emitEvent({
        event_type: "mag_startup_not_ready",
        source: "cli",
        scope: "mag",
        message: "readiness timeout at 60s — stall detection will handle",
      });
    }
  }
}

export function magStop(): void {
  if (!tmuxAvailable()) throw new Error("mag stop: tmux is not available");

  if (!magIsRunning()) {
    console.error(`ludics: Mag session '${MAG_SESSION_NAME}' is not running`);
    return;
  }

  magSignal("stopped", "session stopped by user");

  // Kill ttyd
  const pgrep = safeSyncOutput(["pgrep", "-f", `ttyd.*${MAG_SESSION_NAME}`]);
  if (pgrep.ok && pgrep.stdout) {
    console.error("ludics: Stopping ttyd process(es)...");
    safeSyncOutput(["kill", ...pgrep.stdout.split("\n")]);
  }

  console.error(`ludics: Stopping Mag tmux session '${MAG_SESSION_NAME}'...`);
  tmuxKillSession(MAG_SESSION_NAME);
  emitEvent({ event_type: "mag_stop", source: "cli", scope: "mag", message: `Mag session ${MAG_SESSION_NAME} stopped` });

  // Append stopped timestamp
  const stateFile = magStateFile();
  if (existsSync(stateFile)) {
    const stopped = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const content = readFileSync(stateFile, "utf-8");
    atomicWriteFileSync(stateFile, content + `stopped=${stopped}\n`);
  }

  try { stateMarkDirty(); } catch { /* ignore */ }
  console.log("Mag session stopped.");
}

export function magStatusCmd(): void {
  const stateFile = magStateFile();
  const statusFile = magStatusFile();

  console.log("=== Mag Status ===");
  console.log("");

  if (magIsRunning()) {
    console.log(`Session: ${MAG_SESSION_NAME} (running)`);
  } else {
    console.log(`Session: ${MAG_SESSION_NAME} (not running)`);
    if (existsSync(stateFile)) {
      const content = readFileSync(stateFile, "utf-8");
      const stoppedMatch = content.match(/^stopped=(.+)$/m);
      if (stoppedMatch) console.log(`Last stopped: ${stoppedMatch[1]}`);
    }
    console.log("");
    console.log("Start with: ludics mag start");
    return;
  }

  console.log("");

  if (existsSync(stateFile)) {
    const content = readFileSync(stateFile, "utf-8");
    const startedMatch = content.match(/^started=(.+)$/m);
    if (startedMatch) console.log(`Started: ${startedMatch[1]}`);
    const wdMatch = content.match(/^working_dir=(.+)$/m);
    if (wdMatch) console.log(`Working directory: ${wdMatch[1]}`);
  }

  if (existsSync(statusFile)) {
    const line = readFileSync(statusFile, "utf-8").trim();
    const parts = line.split("|");
    const statusText = parts[0] ?? "";
    const statusEpoch = parseInt(parts[1] ?? "0", 10);
    const statusMsg = parts.slice(2).join("|");

    console.log("");
    console.log(`Status: ${statusText}`);
    if (statusMsg) console.log(`Message: ${statusMsg}`);
    if (statusEpoch) {
      const diff = Math.floor(Date.now() / 1000) - statusEpoch;
      const mins = Math.floor(diff / 60);
      if (mins < 60) {
        console.log(`Last activity: ${mins}m ago`);
      } else {
        console.log(`Last activity: ${Math.floor(mins / 60)}h ago`);
      }
    }
  }

  // Queue status
  console.log("");
  const queueFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(queueFile)) {
    const content = readFileSync(queueFile, "utf-8").trim();
    const pending = content ? content.split("\n").length : 0;
    console.log(`Pending requests: ${pending}`);
  } else {
    console.log("Pending requests: 0");
  }

  // Memory status
  console.log("");
  const memDir = join(magStateDir(), "memory");
  if (existsSync(memDir)) {
    console.log("Memory:");
    if (existsSync(join(memDir, "corrections.md"))) {
      const content = readFileSync(join(memDir, "corrections.md"), "utf-8");
      const count = (content.match(/^-/gm) ?? []).length;
      console.log(`  - Corrections: ${count} entries`);
    }
    if (existsSync(join(memDir, "tools.md"))) console.log("  - Tools: present");
    if (existsSync(join(memDir, "workflows.md"))) console.log("  - Workflows: present");

    const projDir = join(memDir, "projects");
    if (existsSync(projDir)) {
      const projCount = readdirSync(projDir).filter((f: string) => f.endsWith(".md")).length;
      if (projCount > 0) console.log(`  - Projects: ${projCount}`);
    }
  }

  // Context file
  if (existsSync(join(magStateDir(), "context.md"))) {
    console.log("");
    console.log("Context file: present");
  }
}

export function magAttach(): void {
  if (!magIsRunning()) {
    throw new Error(`Mag session '${MAG_SESSION_NAME}' is not running. Start with: ludics mag start`);
  }
  if (process.env.TMUX) {
    if (tmuxSwitchClient(MAG_SESSION_NAME)) return;
  }
  // EXCEPTION: inherited-stdio terminal-attach — cannot use safeSyncOutput (output not piped).
  try {
    Bun.spawnSync(["tmux", "attach", "-t", MAG_SESSION_NAME], { stdio: ["inherit", "inherit", "inherit"] });
  } catch {
    // Ignore — tmux session may have ended before attach.
  }
}

export function magLogs(lines: number = 100): void {
  if (!tmuxAvailable()) throw new Error("mag logs: tmux is not available");

  if (!magIsRunning()) {
    console.error(`ludics: Mag session '${MAG_SESSION_NAME}' is not running`);
    const recent = recentResults(5);
    if (recent.length > 0) {
      console.log("Recent results:");
      for (const r of recent) {
        console.log("---");
        console.log(JSON.stringify(r.data, null, 2));
      }
    }
    return;
  }

  console.log(`=== Mag Session Logs (last ${lines} lines) ===`);
  console.log("");
  const captured = tmuxCapture(MAG_SESSION_NAME, lines);
  if (captured !== null) {
    console.log(captured);
  }
}

export function magDoctor(): void {
  let allOk = true;

  console.log("=== Mag Health Check ===");
  console.log("");

  // tmux
  const hasTmux = tmuxAvailable();
  if (hasTmux) {
    const ver = safeSyncOutput(["tmux", "-V"]);
    console.log(`tmux: ${ver.stdout}`);
  } else {
    console.log("tmux: NOT FOUND (required)");
    allOk = false;
  }

  // claude
  const claudeWhich = safeSyncOutput(["which", "claude"]);
  if (claudeWhich.ok) {
    console.log(`claude: found at ${claudeWhich.stdout}`);
  } else {
    console.log("claude: NOT FOUND");
    console.log("  Install: npm install -g @anthropic-ai/claude-code");
    allOk = false;
  }

  // jq
  if (safeSyncOutput(["which", "jq"]).ok) {
    console.log("jq: found");
  } else {
    console.log("jq: NOT FOUND (required for queue processing)");
    allOk = false;
  }

  // ttyd
  const ttydWhich = safeSyncOutput(["which", "ttyd"]);
  if (ttydWhich.ok) {
    console.log(`ttyd: found at ${ttydWhich.stdout}`);
  } else {
    console.log("ttyd: NOT FOUND (optional, for web access)");
    console.log("  Install: brew install ttyd (macOS) or apt install ttyd (Linux)");
  }

  console.log("");

  if (magIsRunning()) {
    console.log("Mag session: running");
  } else {
    console.log("Mag session: not running");
  }

  const stateDir = magStateDir();
  if (existsSync(stateDir)) {
    console.log(`State directory: ${stateDir}`);
  } else {
    console.log(`State directory: ${stateDir} (not created yet)`);
  }

  const queueFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(queueFile)) {
    const content = readFileSync(queueFile, "utf-8").trim();
    const pending = content ? content.split("\n").length : 0;
    console.log(`Queue: ${queueFile} (${pending} pending)`);
  } else {
    console.log("Queue: not initialized");
  }

  console.log("");
  console.log("Stop hook:");
  const hookScript = join(process.env.HOME!, ".local", "bin", "ludics-on-stop");
  if (existsSync(hookScript)) {
    console.log(`  Script: ${hookScript} ✓`);
  } else {
    console.log(`  Script: ${hookScript} — NOT FOUND`);
    console.log("  Install with: ludics init --hooks");
    allOk = false;
  }

  const settingsPath = join(process.env.HOME!, ".claude", "settings.json");
  let hookConfigured = false;
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).hooks) {
        hookConfigured = true;
      }
    } catch { /* ignore parse errors */ }
  }
  if (hookConfigured) {
    console.log(`  Settings: ~/.claude/settings.json hooks ✓`);
  } else {
    console.log(`  Settings: ~/.claude/settings.json hooks — NOT CONFIGURED`);
    console.log("  Install with: ludics init --hooks");
    allOk = false;
  }

  // --- Stall config validation ---
  console.log("Stall detection config:");
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;

  for (const [key, defaultSec] of [
    ["stall_threshold_seconds", DEFAULT_STALL_THRESHOLD_MS / 1000],
    ["stall_nudge_cooldown_seconds", DEFAULT_STALL_NUDGE_COOLDOWN_MS / 1000],
  ] as const) {
    const raw = mag?.[key];
    if (raw !== undefined) {
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) {
        console.log(`  ${key}: ${JSON.stringify(raw)} — WARNING: not a positive number, using default ${defaultSec}s`);
        allOk = false;
      } else if (num < 30) {
        console.log(`  ${key}: ${num}s — WARNING: unusually low (< 30s)`);
      } else if (num > 600) {
        console.log(`  ${key}: ${num}s — WARNING: unusually high (> 600s)`);
      } else {
        console.log(`  ${key}: ${num}s`);
      }
    } else {
      console.log(`  ${key}: not set (default ${defaultSec}s)`);
    }
  }

  console.log("");
  if (allOk) {
    console.log("All checks passed");
  } else {
    console.log("Some checks failed");
    process.exit(1);
  }
}

function briefingLastQueuedFile(): string {
  return join(magStateDir(), "briefing-last-queued.epoch");
}

function readBriefingLastQueuedEpoch(): number | null {
  const file = briefingLastQueuedFile();
  if (!existsSync(file)) return null;
  try {
    const n = Number.parseInt(readFileSync(file, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function markBriefingQueued(): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(briefingLastQueuedFile(), String(Math.floor(Date.now() / 1000)));
}

export function magBriefing(
  wait: boolean = true,
  timeout: number = 300,
  opts: { auto?: boolean } = {},
): void {
  if (!clusterIsController()) {
    console.error("ludics: mag briefing skipped — not the cluster controller");
    return;
  }
  if (opts.auto) {
    const last = readBriefingLastQueuedEpoch();
    if (last !== null) {
      const elapsed = Math.floor(Date.now() / 1000) - last;
      if (elapsed < BRIEFING_AUTO_COOLDOWN_SECONDS) {
        const remaining = BRIEFING_AUTO_COOLDOWN_SECONDS - elapsed;
        console.error(
          `ludics: auto briefing skipped — last sequence queued ${elapsed}s ago (cooldown ${BRIEFING_AUTO_COOLDOWN_SECONDS}s, ${remaining}s remaining)`,
        );
        return;
      }
    }
  }
  const requestId = queueRequest({ action: "briefing" });
  console.log(`Queued briefing request: ${requestId}`);

  // Auto-queue feedback-digest once daily alongside the briefing trigger.
  // Lands before /compact so digest can consume the briefing's in-flight
  // context (task-304a02a6 / docs/proposals/task-304a02a6-reorder-briefing-auto-queue.md).
  // Wrapped so a digest enqueue failure (queue-lock timeout, state-file write
  // error) cannot suppress the unconditional /compact below — the auto-compact
  // contract (task-a00fc0d9) requires /compact after every briefing.
  try {
    const fdResult = tryQueueFeedbackDigest("ludics");
    if (fdResult.queued) {
      console.error("ludics: briefing queued feedback-digest for ludics");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ludics: feedback-digest enqueue failed: ${msg}`);
  }

  // Auto-compact after briefing — checkpoint compaction (task-a00fc0d9 /
  // docs/proposals/auto-compact-after-checkpoints.md). Enqueued unconditionally
  // as the LAST follow-up so the next session starts fresh, after
  // feedback-digest has had a chance to consume the briefing context.
  queueRequest({ action: "message", content: "/compact" });

  markBriefingQueued();

  if (!wait) {
    console.log("Mag will process when ready");
    return;
  }

  if (!magIsRunning()) {
    console.error("ludics: Mag session is not running. Start with: ludics mag start");
    console.error("ludics: Or process manually: the request is queued");
    return;
  }

  console.log(`Waiting for Mag to process (timeout: ${timeout}s)...`);

  // Wait for result
  const resultsDir = join(harnessDir(), "mag", "results");
  const resultFile = join(resultsDir, `${requestId}.json`);
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      const content = readFileSync(resultFile, "utf-8");
      console.log("");
      console.log("=== Briefing Result ===");
      try {
        const result = JSON.parse(content) as Record<string, unknown>;
        console.log(String(result.output ?? "No output"));
      } catch {
        console.log(content);
      }
      return;
    }
    Bun.sleepSync(2000);
  }

  console.error("ludics: Timeout waiting for briefing result");
}

function magMessage(text: string): void {
  queueRequest({ action: "message", content: text });
  console.log("Message queued for Mag");
}

async function magContext(): Promise<void> {
  await briefingPrecomputeContext();
}

async function magCompleted(proposalName: string): Promise<void> {
  const harness = harnessDir();
  const tasksPath = join(harness, "tasks");
  if (!existsSync(tasksPath)) {
    throw new Error("tasks directory not found");
  }

  const files = readdirSync(tasksPath).filter((f: string) => f.endsWith(".md"));

  let matchedTaskId: string | null = null;
  let matchedSlot: number | null = null;

  for (const f of files) {
    const content = readFileSync(join(tasksPath, f), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    let data: Record<string, unknown>;
    try {
      data = YAML.parse(fmMatch[1]!, { uniqueKeys: false }) as Record<string, unknown>;
    } catch { continue; }

    const status = String(data.status ?? "");
    if (status !== "in-progress") continue;

    const proposal = String(data.proposal ?? "").trim();
    if (!proposal || proposal.toLowerCase() === "null") continue;

    // Match proposal field: docs/<name>.md, <name>.md, or path ending in /<name>.md
    const matches =
      proposal === `docs/${proposalName}.md` ||
      proposal === `${proposalName}.md` ||
      proposal.endsWith(`/${proposalName}.md`);
    if (!matches) continue;

    matchedTaskId = String(data.id ?? "");
    const slotVal = data.slot;
    if (slotVal && String(slotVal) !== "null") {
      const parsed = parseInt(String(slotVal), 10);
      if (Number.isFinite(parsed)) matchedSlot = parsed;
    }
    break;
  }

  if (!matchedTaskId) {
    console.error(`ludics: no in-progress task found matching proposal "${proposalName}"`);
    process.exit(1);
  }

  if (matchedSlot !== null) {
    await slotClear(matchedSlot, "done");
    console.log(`Completed task ${matchedTaskId} (slot ${matchedSlot} cleared)`);
  } else {
    taskCompleteDirectly(matchedTaskId);
    console.log(`Completed task ${matchedTaskId} (no slot, direct update)`);
  }

  journalAppend("mag", `Completed task ${matchedTaskId} via proposal signal: ${proposalName}`);
  emitEvent({ event_type: "mag_completed", source: "mag", scope: "mag", task: matchedTaskId, slot: matchedSlot ?? undefined, message: `completed via proposal signal: ${proposalName}` });
}

// First-level subcommand handler. Each handler receives the args after the
// subcommand name (i.e. args.slice(1) from runMag's input).
type MagSubHandler = (args: string[]) => Promise<void> | void;

// Hook entry points / deprecated compat aliases that stay callable but never
// surface in user-facing help. Mirrors INTERNAL_HIDDEN.mag in
// scripts/lint-cli-subcommands.ts — the lint also strips these when
// comparing against src/index.ts USAGE.
const MAG_HIDDEN_SUBCOMMANDS: ReadonlySet<string> = new Set(["on-stop", "queue-pop"]);

// Registry of mag subcommands. Insertion order is the help-listing order.
// Lint enforcement: scripts/lint-cli-subcommands.ts reads the keys via regex
// to validate parity with src/index.ts USAGE and the runMag default error.
//
// `queue-pop` is a DEPRECATED alias of `on-stop`, kept for backward
// compatibility with older hook scripts. The lint allow-list pins this pair.
const magSubcommands: ReadonlyMap<string, MagSubHandler> = new Map<string, MagSubHandler>([
  ["start", async (args) => { await magStart(args); }],
  ["stop", () => { magStop(); }],
  ["status", () => { magStatusCmd(); }],
  ["attach", () => { magAttach(); }],
  ["logs", (args) => {
    const lines = args[0] ? parseInt(args[0], 10) : 100;
    magLogs(lines);
  }],
  ["doctor", () => { magDoctor(); }],
  ["briefing", (args) => { magBriefing(true, 300, { auto: args.includes("--auto") }); }],
  ["suggest", () => {
    queueRequest({ action: "suggest" });
    console.log("Queued suggest request");
  }],
  ["elaborate", (args) => {
    const taskId = args[0];
    if (!taskId) throw new Error("task id required");
    queueRequest({ action: "elaborate", task: taskId });
    console.log(`Queued elaborate request for ${taskId}`);
  }],
  ["sync-learnings", () => {
    queueRequest({ action: "sync-learnings" });
    console.log("Queued sync-learnings request");
  }],
  ["health-check", () => {
    if (!clusterIsController()) {
      console.error("ludics: mag health-check skipped — not the cluster controller");
      return;
    }
    queueRequest({ action: "health-check" });
    // Auto-compact after health-check — checkpoint compaction (task-a00fc0d9 /
    // docs/proposals/auto-compact-after-checkpoints.md). Enqueued unconditionally;
    // a no-op /compact on a small context is acceptable.
    queueRequest({ action: "message", content: "/compact" });
    console.log("Queued health-check request");
  }],
  ["message", (args) => {
    const text = args.join(" ");
    if (!text) throw new Error("message text required");
    magMessage(text);
  }],
  ["queue", async (args) => {
    const sub2 = args[0];
    if (sub2 === "pop") {
      const mode = args[1];
      if (args.length > 2) {
        throw new Error(`unexpected trailing arguments: ${args.slice(2).join(" ")} (usage: mag queue pop one|all)`);
      }
      const { queuePopOne, queuePopAll } = await import("./queue.ts");
      if (mode === "one") {
        const line = queuePopOne();
        if (line === null) {
          process.exitCode = 1;
        } else {
          console.log(line);
        }
      } else if (mode === "all") {
        const lines = queuePopAll();
        if (lines.length === 0) {
          process.exitCode = 1;
        } else {
          for (const l of lines) console.log(l);
        }
      } else {
        throw new Error(`unknown queue pop mode: ${mode ?? "(missing)"} (use: one, all)`);
      }
    } else if (sub2 === "promote") {
      const id = args[1];
      if (!id) throw new Error("id required (usage: mag queue promote <id>)");
      if (args.length > 2) {
        throw new Error(`unexpected trailing arguments: ${args.slice(2).join(" ")} (usage: mag queue promote <id>)`);
      }
      const { queuePromoteToTop } = await import("./queue.ts");
      const result = queuePromoteToTop(id);
      if (result.status === "not-found") process.exitCode = 1;
      console.log(result.status);
    } else if (sub2 === "cancel") {
      const id = args[1];
      if (!id) throw new Error("id required (usage: mag queue cancel <id>)");
      if (args.length > 2) {
        throw new Error(`unexpected trailing arguments: ${args.slice(2).join(" ")} (usage: mag queue cancel <id>)`);
      }
      const { queueCancel } = await import("./queue.ts");
      const result = queueCancel(id);
      if (result.status === "not-found") {
        process.exitCode = 1;
        console.log("not-found");
      } else {
        console.log(result.line);
      }
    } else if (!sub2) {
      const { queueShow } = await import("./queue.ts");
      queueShow();
    } else {
      throw new Error(`unknown queue subcommand: ${sub2} (use: pop one, pop all, promote <id>, cancel <id>)`);
    }
  }],
  ["context", async () => { await magContext(); }],
  ["auto-start-evaluate", async (args) => {
    const taskId = args[0];
    const confidence = args[1];
    const rationale = args[2] ?? "";
    if (!taskId) throw new Error("task id required");
    const result = evaluateAutoStartDecisionPure(
      confidence === "high" || confidence === "low" ? confidence : undefined,
      rationale,
      startSessionsAutonomy(),
      findSlotForTask(taskId) !== null,
    );
    // Side effect: set or clear deferred status in task frontmatter
    const evalTaskFile = join(harnessDir(), "tasks", `${taskId}.md`);
    if (existsSync(evalTaskFile)) {
      if (result.decision === "defer-to-user") {
        // If the task is already in a slot, clear the slot to free it for other work
        const evalSlot = findSlotForTask(taskId);
        if (evalSlot !== null) {
          await slotClear(evalSlot, "deferred");
        } else {
          updateFrontmatterField(evalTaskFile, "status", "deferred");
        }
      } else {
        // Only clear deferred — do not downgrade other statuses
        const evalContent = readFileSync(evalTaskFile, "utf-8");
        const evalStatus = parseTaskFrontmatter(evalContent).status;
        if (evalStatus === "deferred") {
          updateFrontmatterField(evalTaskFile, "status", "ready");
        }
      }
    }
    console.log(JSON.stringify(result));
  }],
  ["draft-proposal", (args) => {
    const taskId = args[0];
    if (!taskId) throw new Error("task id required");
    queueRequest({ action: "draft-proposal", task: taskId });
    console.log(`Queued draft-proposal request for ${taskId}`);
  }],
  ["revise-proposal", async (args) => {
    const taskArg = args[0];
    if (!taskArg) throw new Error("task id required (comma-separated for multiple)");
    const taskIds = taskArg.split(",");
    const feedback = args.slice(1).join(" ");
    for (const taskId of taskIds) {
      // Set status back to deferred so re-evaluation after revision can re-assess
      const reviseTaskFile = join(harnessDir(), "tasks", `${taskId}.md`);
      if (existsSync(reviseTaskFile)) {
        const revContent = readFileSync(reviseTaskFile, "utf-8");
        const revStatus = parseTaskFrontmatter(revContent).status;
        if (revStatus === "ready" || revStatus === "in-progress") {
          const revSlot = findSlotForTask(taskId);
          if (revSlot !== null) {
            await slotClear(revSlot, "deferred");
          } else {
            updateFrontmatterField(reviseTaskFile, "status", "deferred");
          }
        }
      }
      if (feedback) {
        queueRequest({ action: "revise-proposal", task: taskId, feedback });
      } else {
        queueRequest({ action: "revise-proposal", task: taskId });
      }
    }
    console.log(`Queued revise-proposal request for ${taskIds.join(", ")}`);
  }],
  ["split-task", (args) => {
    const taskId = args[0];
    if (!taskId) throw new Error("task id required");
    queueRequest({ action: "split-task", task: taskId });
    console.log(`Queued split-task request for ${taskId}`);
  }],
  ["verify-completion", (args) => {
    const taskId = args[0];
    if (!taskId) throw new Error("task id required");
    queueRequest({ action: "verify-completion", task: taskId });
    console.log(`Queued verify-completion request for ${taskId}`);
  }],
  ["verify-container-completion", (args) => {
    const taskId = args[0];
    if (!taskId) throw new Error("task id required");
    queueRequest({ action: "verify-container-completion", task: taskId });
    console.log(`Queued verify-container-completion request for ${taskId}`);
  }],
  ["feedback-digest", () => {
    const fdResult = tryQueueFeedbackDigest("ludics");
    if (fdResult.queued) {
      console.log("Queued feedback-digest request");
    } else {
      console.log(`Skipped feedback-digest: ${fdResult.reason}`);
    }
  }],
  ["adopt-sessions", (args) => {
    if (!clusterIsController()) {
      console.error("ludics: mag adopt-sessions skipped — not the cluster controller");
      return;
    }
    const force = args.includes("--force");
    const refresh = safeSyncOutput(ludicsSelfCommand(["sessions", "report"]));
    if (!refresh.ok) {
      throw new Error(refresh.stderr ? `adopt-sessions: failed to refresh sessions: ${refresh.stderr}` : "adopt-sessions: failed to refresh sessions");
    }

    const sessionsFile = join(harnessDir(), "sessions.json");
    const fingerprint = adoptSessionsFingerprintData(sessionsFile);
    if (!fingerprint) {
      throw new Error("adopt-sessions: failed to read sessions.json after refresh");
    }

    mkdirSync(magStateDir(), { recursive: true });
    const fingerprintFile = adoptSessionsFingerprintFile();
    const previous = existsSync(fingerprintFile) ? readFileSync(fingerprintFile, "utf-8").trim() : "";
    const changed = previous !== fingerprint.hash;
    writeFileSync(fingerprintFile, fingerprint.hash + "\n");

    if (!force && !changed) {
      console.log("Skipped adopt-sessions: no unclassified session changes");
      return;
    }

    if (!force && fingerprint.unclassifiedCount === 0) {
      console.log("Skipped adopt-sessions: no unclassified sessions");
      return;
    }

    if (queueHasPendingAction("adopt-sessions")) {
      console.log("Skipped adopt-sessions request: already pending in queue");
      return;
    }

    queueRequest({ action: "adopt-sessions" });
    console.log(`Queued adopt-sessions request (${fingerprint.unclassifiedCount} unclassified session(s))`);
  }],
  ["process-suggestions", (args) => {
    const taskId = args[0];
    if (!taskId) throw new Error("task id required");
    queueRequest({ action: "process-suggestions", task: taskId });
    console.log(`Queued process-suggestions request for ${taskId}`);
  }],
  ["completed", async (args) => {
    const proposalName = args[0];
    if (!proposalName) throw new Error("proposal name required (without .md extension)");
    await magCompleted(proposalName);
  }],
  ["on-stop", async (args) => {
    // Called by the stop hook to mark Mag as settled and attempt immediate queue delivery
    const cwd = args[0] ?? "";
    const hookEventName = args[1] ?? "";
    if (hookEventName && hookEventName !== "Stop") return;
    if (cwd) {
      const harness = harnessDir();
      if (!cwd.startsWith(harness)) return;
    }
    writeStopHookTimestamp();
    clearStartupWatchdogEpoch();
    if (existsSync(join(harnessDir(), "mag", "paused"))) return;
    if (!clusterIsController()) return;
    markMagSettled();
    clearStallState();
    // Attempt immediate queue delivery (keepalive is fallback for items queued while idle)
    await maybeFeedMagQueue();
  }],
  // DEPRECATED: kept for backward compatibility with older hook scripts.
  // New hook scripts use "on-stop" instead. Pinned in lint allow-list.
  ["queue-pop", async (args) => {
    const cwd = args[0] ?? "";
    const hookEventName = args[1] ?? "";
    if (hookEventName && hookEventName !== "Stop") {
      return;
    }
    if (cwd) {
      const harness = harnessDir();
      if (!cwd.startsWith(harness)) {
        return;
      }
    }
    writeStopHookTimestamp();
    clearStartupWatchdogEpoch();
    if (existsSync(join(harnessDir(), "mag", "paused"))) return;
    if (!clusterIsController()) return;
    const popped = await queuePopSkill();
    if (popped) {
      console.log(JSON.stringify({ decision: "block", reason: popped.command }));
    }
  }],
]);

export async function runMag(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  const handler = magSubcommands.get(sub);
  if (!handler) {
    const listing = [...magSubcommands.keys()]
      .filter((k) => !MAG_HIDDEN_SUBCOMMANDS.has(k))
      .join(", ");
    throw new Error(`unknown mag command: ${sub} (use: ${listing})`);
  }
  await handler(args.slice(1));
}
