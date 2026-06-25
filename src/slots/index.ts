// Slot operations — list, show, assign, clear, note, start, stop, refresh

import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { globalAdapter, harnessDir, loadOrchestrationConfig, slotsCount, stateRepoDir, resolveProjectPath, t3codeIntegrationEnabled } from "../config.ts";
import { atomicWriteFileSync } from "../json.ts";
import { mergeAdapterState, addNoteToSlotData } from "./markdown.ts";
import { readSlotJson, writeSlotJson, readAllSlotJson, emptySlotData, slotJsonDir, slotDataToMarkdown, normalizeTaskId } from "./json.ts";
import { migrateMarkdownToSlotData } from "./migration.ts";
import { cleanupStaleItems } from "../t3code/index.ts";
import type { SlotData, SlotLiveness } from "./types.ts";
import { stateMarkDirty } from "../state.ts";
import { journalAppend } from "../journal.ts";
import { emitEvent } from "../events.ts";
import { runAdapterAction, readAdapterState, readAdapterLastActivity } from "../adapters/index.ts";
import type { AdapterContext } from "../adapters/index.ts";
import { addFrontmatterField, updateFrontmatterField, updateDependencyArray, parseTaskFrontmatter, transitionStatus, renderFrontmatterValue } from "../tasks/markdown.ts";
import { hasStash, readStash, writeStash, removeStash } from "./preempt.ts";
import { expandDuoSlots } from "./duo-expand.ts";
import type { PreemptStash } from "./preempt.ts";
import { readSlotState, writeSlotState, processAlive } from "../t3code/server.ts";
import { agentCliCommand, isAgentAlive, readTmuxSlotState, startTtyd, tmuxSessionName, ttydPort, writeTmuxOrchestrationSiblingState, writeTmuxSlotState } from "../adapters/tmux-adapter.ts";
import { tmuxHasSession, tmuxNewSession, tmuxSendCommand, tmuxSendKeys } from "../adapters/tmux.ts";
import { selectOrchestrationFlagsForTask, isT3codeIntegrationPausedError } from "../adapters/t3code.ts";
import { taskFileIntroCommit } from "../adapters/task-launch.ts";
import { readOrchestrationState, persistState, removeOrchestrationState } from "../orchestration/state.ts";
import { startOrchestrationProcess } from "../orchestration/process.ts";
import { isRemoteMachine } from "../remote.ts";
import { heartbeatIsFresh, clusterMachine, clusterEnabled, clusterCurrentMachineName } from "../cluster.ts";
import { safeSyncOutput } from "../spawn.ts";

export const VALID_CLEAR_STATUSES = ["ready", "in-progress", "done", "abandoned"] as const;
export const CLEAR_STATUS_READY = "ready" as const;
export const CLEAR_STATUS_DONE = "done" as const;

/** Canonical public set of adapter modes assignable via `-a` / `slotAssign`.
 *  Distinct from the adapter *registry* (`ADAPTER_NAMES`): legacy/bookmark
 *  adapters may stay registered for state reads without being assignable. */
export const VALID_ASSIGN_ADAPTERS = ["tmux", "t3code", "manual"] as const;

/** Reject any adapter mode outside the canonical assign set. Shared by the
 *  CLI `assign`/`preempt` parsers and the `slotAssign`/`slotPreempt` funnels
 *  so every entry point gets the same atomic, pre-side-effect rejection. */
export function validateAssignAdapter(
  adapter: string,
  opts?: { allowPausedT3code?: boolean },
): void {
  if (!(VALID_ASSIGN_ADAPTERS as readonly string[]).includes(adapter)) {
    throw new Error(
      `invalid adapter: ${adapter} (use: ${VALID_ASSIGN_ADAPTERS.join(", ")})`,
    );
  }
  // gh-ludics-539: t3code stays in VALID_ASSIGN_ADAPTERS (re-enabling is purely
  // runtime), but new assign/preempt of a t3code slot is refused while the
  // integration is paused. Only `t3code` is gated — `tmux`/`manual` validate
  // unchanged. `allowPausedT3code` exempts the preempt-stash restore path
  // (slotRestore): restoring an already-preempted t3code slot must not be
  // blocked — that is option (c), recovery of existing slots continues.
  if (adapter === "t3code" && !opts?.allowPausedT3code && !t3codeIntegrationEnabled()) {
    throw new Error(
      "t3code integration is currently paused; enable mag.t3code_integration_enabled in config.yaml to re-engage",
    );
  }
}

// Worker-side override: when set, readSlot/readAllSlots uses this data instead of
// reading from the local harness files. Set by processSlotIntents before executing
// worker intents so that slot operations use fresh controller-fetched state.
let workerSlotsOverride: Map<number, SlotData> | null = null;

/** Set the in-memory slots data override for worker intent execution.
 *  Call with null to clear. */
export function setWorkerSlotsOverride(data: Map<number, SlotData> | null): void {
  workerSlotsOverride = data;
}

// Worker-side per-slot task-content freshness fingerprint (gh-ludics-609 (b)/AC2).
// Set by processSlotIntents from the start intent's `taskIntroCommit` just before
// dispatching slotStart, so makeAdapterContext can thread it onto the AdapterContext
// and the adapter setup refuses on present-but-stale task content. Cleared after.
const pendingStartFingerprint = new Map<number, string>();

/** Record the controller-supplied task intro-commit fingerprint for a slot's
 *  imminent worker-side start. Pass an empty/undefined commit to clear the slot. */
export function setPendingStartFingerprint(slot: number, introCommit: string | undefined): void {
  if (introCommit && introCommit.trim()) pendingStartFingerprint.set(slot, introCommit.trim());
  else pendingStartFingerprint.delete(slot);
}

/** Read the pending task intro-commit fingerprint for a slot, or undefined. */
export function getPendingStartFingerprint(slot: number): string | undefined {
  return pendingStartFingerprint.get(slot);
}

/** Mutator-only liveness writer: structural mirror of `parseSlotLiveness` on
 *  the read side. Sets `data.liveness = value` in place and returns `data` for
 *  chaining. Does NOT touch `sessionStarted` or other companion fields —
 *  callers continue to set those alongside this call. */
export function setSlotLivenessOnData(data: SlotData, value: SlotLiveness): SlotData {
  data.liveness = value;
  return data;
}

export function findSlotForTask(taskId: string): number | null {
  const slots = readAllSlotJson(slotsCount());
  for (const [slotNum, data] of slots) {
    const currentTask = data.task ?? "";
    if (currentTask === taskId) return slotNum;
  }
  return null;
}

function ensureSlotsDir(): void {
  const dir = slotJsonDir();
  if (existsSync(dir)) {
    // Backfill any missing slot files
    const count = slotsCount();
    for (let i = 1; i <= count; i++) {
      const file = join(dir, `slot-${i}.json`);
      if (!existsSync(file)) {
        writeSlotJson(i, emptySlotData(i));
      }
    }
    return;
  }
  // One-time migration: if slots.md exists but slots/ does not
  const mdFile = join(harnessDir(), "slots.md");
  if (existsSync(mdFile)) {
    const count = slotsCount();
    const migrated = migrateMarkdownToSlotData(mdFile, count);
    for (const [slot, data] of migrated) {
      writeSlotJson(slot, data);
    }
    // Backfill any slots not in the markdown file
    for (let i = 1; i <= count; i++) {
      if (!migrated.has(i)) writeSlotJson(i, emptySlotData(i));
    }
    return;
  }
  // Neither exists: create fresh
  const count = slotsCount();
  for (let i = 1; i <= count; i++) {
    writeSlotJson(i, emptySlotData(i));
  }
}

function readSlot(slotNum: number): SlotData {
  if (workerSlotsOverride) {
    return workerSlotsOverride.get(slotNum) ?? readSlotJson(slotNum);
  }
  return readSlotJson(slotNum);
}

function readAllSlots(): Map<number, SlotData> {
  if (workerSlotsOverride) return workerSlotsOverride;
  return readAllSlotJson(slotsCount());
}

function isWorkerContext(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular-dep chain: cluster.ts imports emitEvent from events.ts
    const { clusterIsController, clusterCurrentMachineName } = require("../cluster.ts") as typeof import("../cluster.ts");
    return !!(clusterCurrentMachineName() && !clusterIsController());
  } catch {
    return false;
  }
}

/** Resolve the machine field default for `slot assign` when --machine is omitted.
 *  In a federated setup, `null` produces a silently-broken slot (dashboard's
 *  generateTerminals/lookupSlotOrchestrationLinks bail on empty machine), so we
 *  prefer the current node name, fall back to the leader, and only return null
 *  when cluster is disabled or genuinely unresolvable. */
function defaultAssignMachine(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular-dep chain: cluster.ts imports emitEvent from events.ts
    const { clusterEnabled, clusterCurrentMachineName, resolveController } = require("../cluster.ts") as typeof import("../cluster.ts");
    if (!clusterEnabled()) return null;
    const current = clusterCurrentMachineName();
    if (current) return current;
    const leader = resolveController();
    if (leader) {
      console.error(
        `ludics: slot assign: current host not in cluster.machines; defaulting machine to leader "${leader.name}". ` +
        `Subsequent 'slot start/stop/resume' must be run from "${leader.name}" (or another configured cluster node) — ` +
        `this host cannot dispatch to the leader locally. Pass --machine <name> to override.`
      );
      return leader.name;
    }
    console.error(
      "ludics: slot assign: cluster configured but no resolvable machine (no self-match, no leader) — storing machine: null. " +
      "Dashboard ttyd links will be missing until machine is set. Pass --machine <name> to override."
    );
    return null;
  } catch {
    return null;
  }
}

/** Write slot data locally, or POST runtime sections to controller on workers. */
function writeSlotOrHttp(slotNum: number, data: SlotData): void {
  if (isWorkerContext()) {
    import("../cluster-http.ts").then(({ clusterPostSlotUpdate }) => {
      clusterPostSlotUpdate(slotNum, {
        sessionStarted: data.sessionStarted || undefined,
        liveness: data.liveness || undefined,
      }).catch(() => {});
    }).catch(() => {});
    return;
  }
  writeSlotJson(slotNum, data);
}

/**
 * Persist a slot's liveness to the AUTHORITATIVE store, worker-first
 * (gh-ludics-584).
 *
 * Unlike `writeSlotOrHttp`, the worker branch here does NOT read the local
 * slot clone: `readSlot()` falls back to the (possibly stale/empty) local
 * `slot-N.json` whenever `workerSlotsOverride` is not active (gh-ludics-580),
 * and an `(empty)` clone would early-return before the controller POST — so
 * the keepalive resume circuit-breaker's `escalated` mark would never reach the
 * controller-authoritative state and the loop would keep re-detecting the slot
 * as non-escalated. We therefore POST directly on a worker (no local read) and
 * `await` it so it lands before the keepalive oneshot process exits. The breaker
 * only calls this for a slot already confirmed active via controller-live
 * `freshSlots`, so skipping the local `(empty)` guard on the worker is safe.
 */
export async function persistSlotLiveness(slotNum: number, liveness: SlotLiveness): Promise<void> {
  validateRange(slotNum, slotsCount());
  if (isWorkerContext()) {
    const { clusterPostSlotUpdate } = await import("../cluster-http.ts");
    await clusterPostSlotUpdate(slotNum, { liveness: liveness ?? undefined });
    return;
  }
  // Controller / standalone: the local harness is authoritative.
  ensureSlotsDir();
  const data = readSlot(slotNum);
  if (data.process === "(empty)") return;
  setSlotLivenessOnData(data, liveness);
  writeSlotJson(slotNum, data);
}

function validateRange(slot: number, count: number): void {
  if (slot < 1 || slot > count) {
    throw new Error(`slot out of range: ${slot} (1-${count})`);
  }
}

// --- Task file helpers ---

function taskFilePath(taskId: string): string {
  return join(harnessDir(), "tasks", `${taskId}.md`);
}

/**
 * Read the raw `effort:` value from the frontmatter block without applying
 * parseTaskFrontmatter's "medium" normalization for missing fields. Returns
 * null when effort is absent, explicitly null, or when frontmatter is missing.
 * Scoped to orchestration-flag selection which needs to distinguish "legacy
 * task, field absent" (→ "small") from "explicit medium".
 */
function readRawEffortField(content: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const m = fmMatch[1]!.match(/^effort:\s*(.+)$/m);
  if (!m) return null;
  const raw = m[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (!raw || raw.toLowerCase() === "null") return null;
  return raw;
}

/**
 * Apply a batch of frontmatter field updates in a single read → mutate-in-memory →
 * atomic-write cycle. Each field is matched on its first occurrence inside the
 * `---`-delimited frontmatter block. Used by `taskUpdateForSlotAssign` to make
 * the (slot, adapter, started) write transactional — a crash mid-sequence would
 * otherwise leave the task with partial assignment (e.g. slot but no adapter).
 */
function taskUpdateFrontmatterFields(taskId: string, updates: Record<string, string | null>): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) return;

  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  const remaining = new Set(Object.keys(updates));
  let inFrontmatter = false;

  const output: string[] = [];
  for (const line of lines) {
    if (line === "---" && !inFrontmatter) {
      inFrontmatter = true;
      output.push(line);
      continue;
    }
    if (line === "---" && inFrontmatter) {
      inFrontmatter = false;
      output.push(line);
      continue;
    }
    if (inFrontmatter && remaining.size > 0) {
      let matched = false;
      for (const field of remaining) {
        if (line.startsWith(`${field}:`)) {
          output.push(`${field}: ${renderFrontmatterValue(updates[field]!)}`);
          remaining.delete(field);
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    output.push(line);
  }

  atomicWriteFileSync(file, output.join("\n"));
}

function taskUpdateFrontmatter(taskId: string, field: string, value: string | null): void {
  taskUpdateFrontmatterFields(taskId, { [field]: value });
}

function taskUpdateForSlotAssign(taskId: string, slot: number, adapter: string, started: string): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) {
    console.error(`ludics: task file not found: ${taskId} (skipping task update)`);
    return;
  }
  if (!transitionStatus(file, ["ready", "deferred", "blocked", "needs-confirmation", "preempted"], "in-progress")) {
    const content = readFileSync(file, "utf-8");
    const actual = parseTaskFrontmatter(content).status ?? "unknown";
    console.error(`ludics: skipping slot assign for ${taskId}: status is '${actual}', expected one of [ready, deferred, blocked, needs-confirmation, preempted]`);
    return;
  }
  taskUpdateFrontmatterFields(taskId, {
    slot: String(slot),
    adapter,
    started,
  });
}

function taskUpdateForSlotClear(taskId: string, finalStatus: string): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) {
    console.error(`ludics: task file not found: ${taskId} (skipping task update)`);
    return;
  }

  let expectedFrom: string[];
  if (finalStatus === "done") {
    expectedFrom = ["in-progress", "preempted"];
  } else if (finalStatus === "abandoned") {
    expectedFrom = ["in-progress", "deferred", "preempted"];
  } else {
    // ready (reset)
    expectedFrom = ["in-progress", "deferred"];
  }

  if (!transitionStatus(file, expectedFrom, finalStatus)) {
    const content = readFileSync(file, "utf-8");
    const actual = parseTaskFrontmatter(content).status ?? "unknown";
    console.error(`ludics: skipping slot clear for ${taskId}: status is '${actual}', expected one of [${expectedFrom.join(", ")}]`);
    return;
  }
  taskUpdateFrontmatter(taskId, "slot", null);

  if (finalStatus === "done" || finalStatus === "abandoned") {
    const completed = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
    taskUpdateFrontmatter(taskId, "completed", completed);
  }
}

// --- Slot CLI handlers ---

export function slotsList(): void {
  ensureSlotsDir();
  const slots = readAllSlots();
  const count = slotsCount();

  for (let i = 1; i <= count; i++) {
    const data = slots.get(i) ?? emptySlotData(i);
    const machineStr = data.machine ? ` [${data.machine}]` : "";
    console.log(`Slot ${i}: ${data.process}${machineStr}`);
  }
}

export function slotShow(slotNum: number): void {
  const count = slotsCount();
  validateRange(slotNum, count);
  ensureSlotsDir();
  const data = readSlot(slotNum);
  console.log(slotDataToMarkdown(data).trimEnd());
}

export async function slotAssign(
  slotNum: number,
  taskOrDesc: string,
  adapter: string = "manual",
  session: string = "",
  path: string = "",
  adapterArgs: string = "",
  machine: string = "",
  opts?: { allowPausedT3code?: boolean },
): Promise<void> {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);
  // Reject phantom adapters before any side effect (no slot write, no
  // prior-slot cleanup, no status flip, no interrupted-marker clearing).
  // `allowPausedT3code` is set by slotRestore so restoring a preempted t3code
  // slot is not blocked by the gh-ludics-539 pause gate (option (c)).
  validateAssignAdapter(adapter, { allowPausedT3code: opts?.allowPausedT3code });

  const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");

  // Normalize path
  if (path && path !== "/") {
    path = path.replace(/\/$/, "");
  }
  adapterArgs = adapterArgs.trim();

  // Determine task ID vs description
  let taskId: string | null;
  let processDesc: string;
  const tf = taskFilePath(taskOrDesc);
  if (existsSync(tf)) {
    taskId = taskOrDesc;
    const content = readFileSync(tf, "utf-8");
    const fm = parseTaskFrontmatter(content);
    // Container tasks (work split into subtasks) cannot be assigned — the
    // parent is non-actionable. Throw before any slot mutation so the call
    // is atomic: no slot file write, no prior-slot cleanup, no status flip.
    if (fm.leaf === false) {
      throw new Error(
        `Cannot assign container task ${taskId} to slot ${slotNum} — its work was split into subtasks. Assign a child instead.`,
      );
    }
    processDesc = fm.title || taskId;
  } else {
    taskId = null;
    processDesc = taskOrDesc;
  }

  // Session handling
  if (!session) {
    switch (adapter) {
      case "t3code":
        session = "";
        break;
      case "manual":
      default:
        session = String(slotNum);
        break;
    }
  }

  const data: SlotData = {
    slot: slotNum,
    process: processDesc,
    task: taskId,
    mode: adapter,
    session: session || null,
    path: path || null,
    started,
    adapterArgs: adapterArgs || null,
    machine: machine || defaultAssignMachine(),
    sessionStarted: null,
    liveness: null,
    terminals: "",
    runtime: "- Assigned via ludics\n",
    git: "",
  };

  // Clear metadata on the previous task (if any) being replaced in this slot
  const oldData = readSlot(slotNum);
  if (oldData.task && oldData.task !== taskId) {
    const oldTaskFile = taskFilePath(oldData.task);
    if (existsSync(oldTaskFile)) {
      updateFrontmatterField(oldTaskFile, "slot", null);
      const oldContent = readFileSync(oldTaskFile, "utf-8");
      const oldStatus = parseTaskFrontmatter(oldContent).status;
      if (oldStatus === "in-progress" || oldStatus === "deferred") {
        updateFrontmatterField(oldTaskFile, "status", "ready");
      }
    }
  }

  // Reap the prior assignment's runner/tmux/ttyd before overwriting slot state.
  // Without this, the orphaned `orch run-internal <slot>` keeps rewriting
  // orchestration/slot-<N>.json and confuses maybeAutoStartSlots.
  if (oldData.process !== "(empty)" && oldData.task && oldData.task !== taskId) {
    try {
      await slotStop(slotNum, /* force */ true, /* preserveState */ false);
    } catch (err) {
      journalAppend("slot", `Slot ${slotNum} assign: slotStop of prior task failed: ${String(err)}`);
    }
  }

  writeSlotJson(slotNum, data);

  // Remove stale orchestration state — may have been restored by git pull/stash-pop
  // after a previous slotClear deleted it
  const orchFile = join(harnessDir(), "orchestration", `slot-${slotNum}.json`);
  if (existsSync(orchFile)) {
    try { unlinkSync(orchFile); } catch { /* ignore */ }
  }
  const tmuxSlotFile = join(harnessDir(), "orchestration", `tmux-slot-${slotNum}.json`);
  if (existsSync(tmuxSlotFile)) {
    try { unlinkSync(tmuxSlotFile); } catch { /* ignore */ }
  }

  // Update task file
  if (taskId) {
    taskUpdateForSlotAssign(taskId, slotNum, adapter, started);
  }

  journalAppend(
    "slot",
    `Slot ${slotNum} assigned: ${processDesc}${taskId ? ` (task=${taskId})` : ""} (adapter=${adapter})`,
  );
  emitEvent({ event_type: "slot_assign", source: "cli", scope: "slot", slot: slotNum, task: taskId ?? undefined, adapter, message: processDesc });
  stateMarkDirty();
}

/** Clear duoPeerSlot on the sibling slot when one duo slot is cleared/stopped. */
function clearDuoPeerLink(slotNum: number): void {
  const orchState = readOrchestrationState(slotNum);
  if (!orchState?.duoPeerSlot) return;
  const siblingState = readOrchestrationState(orchState.duoPeerSlot);
  if (!siblingState) return;
  if (siblingState.duoPeerSlot === slotNum) {
    siblingState.duoPeerSlot = null;
    persistState(siblingState);
    console.error(`ludics: cleared duoPeerSlot on sibling slot ${orchState.duoPeerSlot}`);
  }
}

export async function slotClear(slotNum: number, finalStatus: string = "ready"): Promise<void> {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  // Hierarchical duo: clear duoPeerSlot on sibling so it becomes a regular pair slot
  clearDuoPeerLink(slotNum);

  const data = readSlot(slotNum);
  const taskId = data.task;

  // Save t3code thread IDs to task file frontmatter before clearing the slot state.
  // MUST run before slotStop: slotStop(preserveState=false) removes the slot state file this reads.
  if (data.mode === "t3code" && taskId) {
    try {
      const slotState = readSlotState(slotNum, harnessDir());
      if (slotState && slotState.threads.length > 0) {
        const threadIds = slotState.threads.map((t) => t.threadId);
        addFrontmatterField(taskFilePath(taskId), "t3code_threads", `[${threadIds.join(", ")}]`);
      }
    } catch {
      // non-critical: continue even if thread ID saving fails
    }
  }

  // Reap the runner/tmux/ttyd before unlinking sibling state files.
  // The adapter's stop() already does the right cleanup (TERM pid, kill ttyd,
  // deferred cleanup for sessions, remove slot state). Without this, the
  // `orch run-internal <slot>` process is orphaned and keeps rewriting
  // orchestration/slot-<N>.json.
  if (data.process !== "(empty)") {
    try {
      await slotStop(slotNum, /* force */ true, /* preserveState */ false);
    } catch (err) {
      journalAppend("slot", `Slot ${slotNum} clear: slotStop failed: ${String(err)}`);
    }
  }

  writeSlotJson(slotNum, emptySlotData(slotNum));

  // Remove task-specific orchestration state
  const orchFile = join(harnessDir(), "orchestration", `slot-${slotNum}.json`);
  if (existsSync(orchFile)) {
    try { unlinkSync(orchFile); } catch { /* ignore */ }
  }

  // Remove tmux slot state if present
  const tmuxSlotFile = join(harnessDir(), "orchestration", `tmux-slot-${slotNum}.json`);
  if (existsSync(tmuxSlotFile)) {
    try { unlinkSync(tmuxSlotFile); } catch { /* ignore */ }
  }

  // Remove t3code slot state if present (e.g. preserved from a paused session)
  const t3codeSlotFile = join(harnessDir(), "t3code", `slot-${slotNum}.json`);
  if (existsSync(t3codeSlotFile)) {
    try { unlinkSync(t3codeSlotFile); } catch { /* ignore */ }
  }

  if (taskId) {
    taskUpdateForSlotClear(taskId, finalStatus);
    journalAppend("slot", `Slot ${slotNum} cleared: task=${taskId} status=${finalStatus}`);
    emitEvent({ event_type: "slot_clear", source: "cli", scope: "slot", slot: slotNum, task: taskId, status: finalStatus });

    // Prune blocked_by → relates_to across all tasks when a task completes
    if (finalStatus === "done") {
      pruneBlockedBy(taskId);
    }
  } else {
    journalAppend("slot", `Slot ${slotNum} cleared`);
    emitEvent({ event_type: "slot_clear", source: "cli", scope: "slot", slot: slotNum });
  }

  stateMarkDirty();

  // Auto-restore preempted work when priority task is gone for good (done or abandoned).
  // "ready" (Postpone) is excluded — the priority task is coming back and would race
  // for the slot. "merged" is not a valid finalStatus today (rejected by
  // VALID_CLEAR_STATUSES, no callsite); revisit if a merge-via-slot path appears.
  if ((finalStatus === "done" || finalStatus === "abandoned") && hasStash(slotNum)) {
    console.error(
      `ludics: auto-restoring preempted work to slot ${slotNum} (trigger: ${finalStatus})`,
    );
    await slotRestore(slotNum);
    // Emit observability after slotRestore succeeds, so a failed restore
    // (e.g. corrupt stash where hasStash() is true but readStash() returns
    // null) does not produce a success-looking slot_auto_restore event.
    journalAppend(
      "slot",
      `Slot ${slotNum} auto-restored preempted work (trigger: ${finalStatus})`,
    );
    emitEvent({
      event_type: "slot_auto_restore",
      source: "cli",
      scope: "slot",
      slot: slotNum,
      message: `trigger: ${finalStatus}`,
    });
  }

  // Best-effort t3code cleanup after clearing a slot
  try {
    void cleanupStaleItems(harnessDir(), false).catch(() => { /* ignore */ });
  } catch {
    // t3code not available — skip
  }
}

/**
 * Mark a slot as interrupted due to orchestration setup failure.
 * Unlike slotClear, this keeps the slot assigned (not empty) so that
 * maybeFillEmptySlots won't overwrite it with a different task.
 * The dashboard will show "Interrupted" with a Resume button.
 */
export function markSlotSetupFailed(slotNum: number, error: string): void {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  const data = readSlot(slotNum);
  if (data.process === "(empty)") return;

  const taskId = data.task;

  // Mark slot as interrupted
  setSlotLivenessOnData(data, "interrupted");
  data.sessionStarted = null;
  writeSlotJson(slotNum, data);

  // Reset task status from in-progress back to ready so it's not orphaned
  if (taskId) {
    const taskFile = taskFilePath(taskId);
    if (existsSync(taskFile)) {
      const content = readFileSync(taskFile, "utf-8");
      const status = parseTaskFrontmatter(content).status;
      if (status === "in-progress" || status === "deferred") {
        taskUpdateFrontmatter(taskId, "status", "ready");
      }
    }
  }

  journalAppend("slot", `Slot ${slotNum} setup failed: ${error}`);
  emitEvent({
    event_type: "slot_setup_failed",
    source: "cli",
    scope: "slot",
    slot: slotNum,
    task: taskId ?? undefined,
    message: `setup failed: ${error}`,
  });
  stateMarkDirty();
}

/**
 * Clear a slot's interrupted/escalated liveness marker.
 *
 * Recovery verb for slots stranded by a failed setup (`markSlotSetupFailed`)
 * or an agent hand-raise. Unlike `slotResume`, this performs NO adapter
 * dispatch, NO process kill, and NO task-status flip — so it works for any
 * `mode` value, including phantom adapters left in stale slot files. It only
 * resets `liveness` and `sessionStarted`; the slot stays assigned.
 */
export function slotReset(slotNum: number): void {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  const data = readSlot(slotNum);
  if (data.process === "(empty)") return; // no-op-safe on an unassigned slot

  setSlotLivenessOnData(data, null);
  data.sessionStarted = null;
  writeSlotJson(slotNum, data);

  journalAppend("slot", `Slot ${slotNum} reset (liveness cleared)`);
  emitEvent({
    event_type: "slot_reset",
    source: "cli",
    scope: "slot",
    slot: slotNum,
    task: data.task ?? undefined,
  });
  stateMarkDirty();
}

/**
 * Mark a task as done directly (without a slot clear).
 * Used when a task has no slot assignment but needs to be completed,
 * e.g. from `ludics mag completed <proposal-name>`.
 */
export function taskCompleteDirectly(taskId: string): void {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  const file = taskFilePath(taskId);
  if (!existsSync(file)) {
    console.error(`ludics: task file not found: ${taskId} (skipping task update)`);
    return;
  }
  if (!transitionStatus(file, ["in-progress", "deferred"], "done")) {
    const content = readFileSync(file, "utf-8");
    const actual = parseTaskFrontmatter(content).status ?? "unknown";
    console.error(`ludics: skipping direct completion for ${taskId}: status is '${actual}', expected one of [in-progress, deferred]`);
    return;
  }
  taskUpdateFrontmatter(taskId, "slot", null);
  const completed = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
  taskUpdateFrontmatter(taskId, "completed", completed);
  pruneBlockedBy(taskId);
  emitEvent({ event_type: "task_completed", source: "cli", scope: "task", task: taskId, status: "done", message: "direct completion (no slot)" });
  stateMarkDirty();
}

/**
 * When a task completes, remove it from other tasks' blocked_by lists
 * and move the reference to relates_to (preserving the relationship).
 */
function pruneBlockedBy(completedTaskId: string): void {
  const tasksPath = join(harnessDir(), "tasks");
  if (!existsSync(tasksPath)) return;

  const files = readdirSync(tasksPath).filter((f: string) => f.endsWith(".md"));
  for (const f of files) {
    const filePath = join(tasksPath, f);
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    let fm;
    try {
      fm = parseTaskFrontmatter(content);
    } catch { continue; }

    const blockedBy = fm.dependencies?.blocked_by ?? [];
    if (!blockedBy.includes(completedTaskId)) continue;

    // Remove from blocked_by
    const newBlockedBy = blockedBy.filter((id) => id !== completedTaskId);
    updateDependencyArray(filePath, "blocked_by", newBlockedBy);

    // Add to relates_to (if not already there and not in blocks)
    const relatesTo = fm.dependencies?.relates_to ?? [];
    const blocks = fm.dependencies?.blocks ?? [];
    if (!relatesTo.includes(completedTaskId) && !blocks.includes(completedTaskId)) {
      updateDependencyArray(filePath, "relates_to", [...relatesTo, completedTaskId]);
    }

    console.error(`ludics: ${fm.id}: moved ${completedTaskId} from blocked_by to relates_to`);
  }
}

export async function slotPreempt(
  slotNum: number,
  taskId: string,
  adapter: string = "manual",
  session: string = "",
  path: string = "",
  adapterArgs: string = "",
): Promise<void> {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);
  // Reject phantom adapters before the stash write / `preempted` status flip
  // on a non-empty slot — `slotAssign`'s own validator runs too late here.
  validateAssignAdapter(adapter);

  const data = readSlot(slotNum);
  const currentProcess = data.process;
  const isEmpty = !currentProcess || currentProcess === "(empty)";

  // If slot is empty, just assign directly — no stash needed
  if (isEmpty) {
    await slotAssign(slotNum, taskId, adapter, session, path, adapterArgs);
    return;
  }

  // No double preemption
  if (hasStash(slotNum)) {
    throw new Error(`slot ${slotNum} already has a preempted stash (no double preemption)`);
  }

  // Save current slot state to stash
  const stash: PreemptStash = {
    slotNum,
    previousTask: data.task ?? "null",
    previousProcess: currentProcess,
    previousMode: data.mode ?? "null",
    previousSession: data.session ?? "null",
    previousPath: data.path ?? "null",
    previousStarted: data.started ?? "null",
    previousAdapterArgs: data.adapterArgs ?? "null",
    preemptedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z"),
    preemptingTask: taskId,
  };
  writeStash(stash);

  // Set previous task status to "preempted"
  if (data.task) {
    const taskFile = taskFilePath(data.task);
    if (!transitionStatus(taskFile, ["in-progress"], "preempted")) {
      const content = existsSync(taskFile) ? readFileSync(taskFile, "utf-8") : "";
      const actual = parseTaskFrontmatter(content).status ?? "unknown";
      console.error(`ludics: skipping preempt status update for ${data.task}: status is '${actual}', expected 'in-progress'`);
    }
  }

  // Assign the new priority task
  await slotAssign(slotNum, taskId, adapter, session, path, adapterArgs);

  journalAppend("slot", `Slot ${slotNum} preempted: ${currentProcess} → ${taskId}`);
  emitEvent({ event_type: "slot_preempt", source: "cli", scope: "slot", slot: slotNum, task: taskId, message: `preempted ${currentProcess}` });
  stateMarkDirty();
}

export async function slotRestore(slotNum: number): Promise<void> {
  // CONTROLLER-ONLY: runs locally; no remote-dispatch guard needed
  const count = slotsCount();
  validateRange(slotNum, count);

  const stash = readStash(slotNum);
  if (!stash) {
    throw new Error(`slot ${slotNum} has no preempted stash to restore`);
  }

  // Restore previous assignment.
  // A stash captured before assign-time adapter validation (gh-ludics-524)
  // may carry a legacy/phantom previousMode (agent-claude, agent-pair-codex,
  // ...) that slotAssign now rejects. Coerce anything outside the canonical
  // set to "manual" rather than hard-failing the restore and stranding the
  // stash with no recovery path.
  const rawPrevMode = stash.previousMode === "null" ? "manual" : stash.previousMode;
  const prevAdapter = (VALID_ASSIGN_ADAPTERS as readonly string[]).includes(rawPrevMode)
    ? rawPrevMode
    : "manual";
  const prevSession = stash.previousSession === "null" ? "" : stash.previousSession;
  const prevPath = stash.previousPath === "null" ? "" : stash.previousPath;
  const prevAdapterArgs = !stash.previousAdapterArgs || stash.previousAdapterArgs === "null"
    ? ""
    : stash.previousAdapterArgs;
  const prevTask = stash.previousTask === "null" ? stash.previousProcess : stash.previousTask;

  // slotAssign handles preempted→in-progress via taskUpdateForSlotAssign.
  // gh-ludics-539: restoring a previously-preempted t3code slot must not be
  // blocked by the paused-integration gate — this is recovery of existing
  // work, not a new assignment (option (c)). Phantom-adapter rejection still
  // applies (prevAdapter was already coerced to the canonical set above).
  await slotAssign(slotNum, prevTask, prevAdapter, prevSession, prevPath, prevAdapterArgs, "", {
    allowPausedT3code: true,
  });

  removeStash(slotNum);

  journalAppend("slot", `Slot ${slotNum} restored: ${stash.previousProcess} (from preempt by ${stash.preemptingTask})`);
  emitEvent({ event_type: "slot_restore", source: "cli", scope: "slot", slot: slotNum, task: stash.previousTask !== "null" ? stash.previousTask : undefined, message: `restored from preempt by ${stash.preemptingTask}` });
  stateMarkDirty();
}

export function slotNote(slotNum: number, note: string): void {
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  const data = readSlot(slotNum);
  if (data.process === "(empty)") {
    throw new Error(`slot ${slotNum} not found`);
  }

  writeSlotJson(slotNum, addNoteToSlotData(data, note));
}

export async function slotSetMode(slotNum: number, mode: string): Promise<void> {
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);
  // gh-ludics-539: `slot mode <N> t3code` updates data.mode directly without
  // going through slotAssign, so it must enforce the same paused-integration
  // gate — otherwise a user could create a t3code slot while paused by
  // assigning tmux/manual then toggling mode. Also rejects phantom modes.
  validateAssignAdapter(mode);

  let data = readSlot(slotNum);
  if (data.process === "(empty)") {
    throw new Error(`slot ${slotNum} not found`);
  }

  const hasActiveSession = data.sessionStarted != null;

  if (hasActiveSession) {
    const isAutomated = data.mode === "tmux" || data.mode === "t3code";
    if (isAutomated && mode === "manual") {
      // Kill processes but preserve state for later resume
      await slotStop(slotNum, false, true);
      // Re-read since slotStop modified the file
      data = readSlot(slotNum);
    } else {
      throw new Error(
        `slot ${slotNum} has an active session (started at ${data.sessionStarted}); stop or clear the slot before switching to ${mode}`,
      );
    }
  }

  data.mode = mode;
  writeSlotJson(slotNum, data);

  // Keep task file adapter: field in sync
  if (data.task) {
    taskUpdateFrontmatter(data.task, "adapter", mode);
  }

  journalAppend("slot", `Slot ${slotNum} mode set to ${mode}`);
  emitEvent({ event_type: "slot_mode", source: "cli", scope: "slot", slot: slotNum, message: `mode=${mode}` });
  stateMarkDirty();
}

export function makeAdapterContext(slotNum: number, data: SlotData): AdapterContext {
  let resolvedPath = data.path ?? "";
  const taskId = normalizeTaskId(data.task);

  // If path is empty, try to resolve from the task's project config
  if (!resolvedPath && taskId) {
    const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
    if (existsSync(taskFile)) {
      const content = readFileSync(taskFile, "utf-8");
      const project = parseTaskFrontmatter(content).project;
      if (project) {
        resolvedPath = resolveProjectPath(project);
      }
    }
  }

  return {
    slot: slotNum,
    mode: data.mode ?? "",
    session: data.session ?? "",
    path: resolvedPath,
    started: data.started ?? "",
    taskId,
    adapterArgs: data.adapterArgs ?? "",
    process: data.process === "(empty)" ? "" : data.process,
    machine: data.machine ?? "",
    harnessDir: harnessDir(),
    stateRepoDir: stateRepoDir(),
    expectedTaskIntroCommit: getPendingStartFingerprint(slotNum),
  };
}

/**
 * Start the adapter session for a slot.
 *
 * Remote dispatch behavior:
 * - If the target machine is offline, throws an Error (caller must handle).
 * - If the target machine is online, queues a start intent and returns normally;
 *   success/failure is observed asynchronously via slot intent events / journal.
 * - Callers wanting synchronous confirmation must poll intent state.
 *
 * @throws {Error} If the assigned remote machine is offline or has no cluster config.
 */

/** Shared remote-dispatch logic for slotStart, slotStop (non-force), and slotResume.
 *  Validates heartbeat + cluster config, records an intent, logs, and emits an event.
 *  Callers should `return` after awaiting this function. */
async function ensureRemoteMachineReachable(
  slotNum: number,
  machine: string,
  action: "start" | "stop" | "resume",
  adapter: string,
  intentPayload: Record<string, unknown>,
): Promise<void> {
  // Off-cluster guard: cluster is configured but this host is not in
  // cluster.machines, so heartbeats are invisible here and there is no HTTP
  // route to the leader. Fire BEFORE heartbeatIsFresh so the operator does
  // not see the misleading "offline" message that simply means "no local
  // visibility from off-cluster". slotStop --force skips this function
  // entirely, so the force escape hatch is preserved for free.
  if (clusterEnabled() && clusterCurrentMachineName() === null) {
    throw new Error(
      `slot ${slotNum}: this host is not in cluster.machines; cannot ${action} on "${machine}". ` +
      `Run from "${machine}" (or another configured cluster node), use the dashboard launch button, ` +
      `or re-assign with --machine <thisHost> to make the slot local.`
    );
  }
  if (!heartbeatIsFresh(machine)) {
    throw new Error(`slot ${slotNum}: assigned machine ${machine} is offline — cannot ${action}`);
  }
  const targetMachine = clusterMachine(machine);
  if (!targetMachine) {
    throw new Error(`slot ${slotNum}: no cluster config for machine ${machine}`);
  }
  const { recordIntent } = await import("../cluster-http.ts");
  const epoch = Math.floor(Date.now() / 1000);
  recordIntent(slotNum, { action, epoch, machine, ...intentPayload });
  console.error(`ludics: slot ${slotNum}: ${action} intent recorded for ${machine}`);
  journalAppend("slot", `Slot ${slotNum} ${action} intent recorded for ${machine}`);
  emitEvent({ event_type: `slot_${action}_queued`, source: "cli", scope: "slot", slot: slotNum, adapter, machine, message: `${action} intent recorded for ${machine}` });
}

/**
 * Pure helper extracted from `slotStart`: computes the orchestration flags to
 * auto-fill for an orchestrated slot whose `adapterArgs` is empty/whitespace,
 * and returns the updated `SlotData` so the caller can persist it.
 *
 * Returns `null` when auto-fill does not apply (mode other than t3code/tmux,
 * or `ctx.adapterArgs` already non-empty). Throws the same three errors as
 * the original inline block. Does *not* call `runAdapterAction`, `t3code.start`,
 * or `ensureServer`, and does not persist or journal — that is the caller's job.
 */
/**
 * Detect whether `slotNum` is a hierarchical-duo member whose own `adapterArgs`
 * failed to arrive, by scanning the *other* slots (worker override / fresh
 * snapshot when active, else local slot json) for a sibling that names this slot
 * as its duo peer via `--duo-peer-slot=<slotNum>` (gh-ludics-589).
 *
 * This is the duo-membership signal that survives an empty `adapterArgs`: a duo
 * slotB with blank args cannot self-report its peer, but its healthy sibling
 * slotA still carries `--duo-peer-slot=<slotB>`. A genuine solo slot is never
 * referenced this way, so it is correctly NOT flagged. No `SlotData` field and no
 * migration — derived entirely from existing args.
 *
 * The match additionally requires the sibling to share this slot's `task`. A
 * genuine duo pair is assigned to the same task id by both `slotAssign` calls, so
 * this is always true for a real delivery failure. It guards against a STALE peer
 * token: `clearDuoPeerLink` clears the sibling's orchestration `duoPeerSlot` when
 * a duo breaks but does NOT rewrite the sibling's stored `adapterArgs`, so a later
 * SOLO reuse of this slot would otherwise be mis-flagged by the leftover
 * `--duo-peer-slot=<slotNum>` token (the new task has a different id → no match).
 *
 * Exported as a test seam (mirrors `autoFillAdapterArgs`).
 */
export function slotIsDuoMember(slotNum: number): boolean {
  const all = readAllSlots();
  const selfTask = all.get(slotNum)?.task ?? "";
  if (!selfTask) return false; // no task → not a duo delivery failure
  for (const [other, sd] of all) {
    if (other === slotNum) continue;
    if ((sd?.task ?? "") !== selfTask) continue; // stale-token / unrelated-pair guard
    const args = sd?.adapterArgs ?? "";
    const m = args.match(/--duo-peer-slot=(\d+)/);
    if (m && Number(m[1]) === slotNum) return true;
  }
  return false;
}

export async function autoFillAdapterArgs(
  ctx: AdapterContext,
  data: SlotData,
): Promise<{ args: string; effort: string; updatedData: SlotData } | null> {
  if (!(ctx.mode === "t3code" || ctx.mode === "tmux") || ctx.adapterArgs.trim()) {
    return null;
  }

  // gh-ludics-589 (Part A, fail-loud safety net): empty adapterArgs on a duo
  // member is a *delivery failure*, not "operator wants defaults". Auto-filling a
  // default pair here would discard the swapped providers and --duo-peer-slot, and
  // slotStart would then persist that wrong default back to the controller via
  // clusterPostSlotUpdate — turning a transient empty read into durable
  // corruption. Refuse loudly so Mag can retry (the intent stays unacked). The
  // throw also unwinds slotStart before the clusterPostSlotUpdate write-back, so
  // no wrong default is ever persisted (AC2). Solo slots fall through and auto-fill
  // exactly as before (AC3).
  if (slotIsDuoMember(ctx.slot)) {
    throw new Error(
      `slot ${ctx.slot}: duo member with empty adapterArgs — refusing to auto-fill a default pair. ` +
      `The expanded duo args (swapped --coder/--reviewer + --duo-peer-slot) failed to reach this worker. ` +
      `Retry the launch so the controller-authored args are delivered.`
    );
  }

  const taskId = ctx.taskId;
  if (!taskId) {
    throw new Error(`slot ${ctx.slot}: ${ctx.mode} adapter requires orchestration flags but no task is assigned`);
  }

  // Read task content — on worker, fetch via HTTP; on controller, read locally
  let content: string | null = null;
  if (isWorkerContext()) {
    try {
      const { clusterGetTask } = await import("../cluster-http.ts");
      const result = await clusterGetTask(taskId);
      if (result.ok && typeof result.data === "string") content = result.data;
    } catch { /* ignore */ }
  } else {
    const tf = taskFilePath(taskId);
    if (existsSync(tf)) content = readFileSync(tf, "utf-8");
  }
  if (!content) {
    throw new Error(`slot ${ctx.slot}: ${ctx.mode} adapter requires orchestration flags but task file not found`);
  }

  // parseTaskFrontmatter normalizes a missing `effort:` field to "medium" as
  // its documented default, collapsing "field absent" with "field == medium".
  // Pre-unification this site used readFrontmatterField which returned null
  // for missing fields, so `?? "small"` fired for legacy/manual tasks that
  // never declared effort. Preserve that small-orchestration default by
  // consulting the raw frontmatter block before falling back on the parser's
  // normalized value.
  const effort = readRawEffortField(content) ?? "small";
  let autoArgs: string;
  try {
    ({ args: autoArgs } = selectOrchestrationFlagsForTask(content, effort));
  } catch (e) {
    // gh-ludics-539: t3code integration paused — treat the slot as not
    // auto-fillable rather than silently falling back to a stale default.
    if (isT3codeIntegrationPausedError(e)) {
      console.error(`ludics: slot ${ctx.slot}: auto-fill skipped: t3code integration paused`);
      return null;
    }
    throw e;
  }
  if (!autoArgs.trim()) {
    throw new Error(`slot ${ctx.slot}: selectOrchestrationFlagsForTask returned empty args for effort="${effort}"`);
  }

  const updatedData: SlotData = { ...data, adapterArgs: autoArgs };
  return { args: autoArgs, effort, updatedData };
}

export async function slotStart(slotNum: number, { startTtyd: shouldStartTtyd = true }: { startTtyd?: boolean } = {}): Promise<void> {
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  let data = readSlot(slotNum);
  if (data.process === "(empty)") throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, data);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode`);

  // Remote dispatch: record intent in controller memory (pure pull model)
  if (ctx.machine && isRemoteMachine(ctx.machine)) {
    // gh-ludics-589: capture the launch-time adapterArgs in the start intent so the
    // worker launches with the correct expanded duo args (swapped providers +
    // --duo-peer-slot) even if its up-front freshSlots snapshot raced the
    // controller's two-slot publish. The controller's slot state is authoritative
    // here. Pass undefined (not "") when empty so parsePendingIntent drops it.
    // gh-ludics-609 (c): thread the assigned task file's freshness fingerprint (the
    // commit that last touched tasks/<id>.md in the controller's authoritative
    // harness) so the worker can (1) require it to be an ancestor of its harness
    // HEAD before launching and (2) refuse a present-but-stale local task file.
    await ensureRemoteMachineReachable(slotNum, ctx.machine, "start", ctx.mode, {
      taskId: ctx.taskId,
      adapterArgs: ctx.adapterArgs.trim() ? ctx.adapterArgs : undefined,
      taskIntroCommit: ctx.taskId ? (taskFileIntroCommit(harnessDir(), ctx.taskId) || undefined) : undefined,
    });
    return;
  }

  // --- LOCAL EXECUTION ONLY (worker side or local slot) ---

  const autoFill = await autoFillAdapterArgs(ctx, data);
  if (autoFill) {
    data = autoFill.updatedData;
    ctx.adapterArgs = autoFill.args;
    if (isWorkerContext()) {
      import("../cluster-http.ts").then(({ clusterPostSlotUpdate }) => {
        clusterPostSlotUpdate(slotNum, { adapterArgs: autoFill.args }).catch(() => {});
      }).catch(() => {});
    } else {
      writeSlotJson(slotNum, data);
    }
    console.error(`ludics: slot ${slotNum}: auto-filled adapter args from task effort="${autoFill.effort}": ${autoFill.args}`);
    journalAppend("slot", `Slot ${slotNum} auto-filled adapter args: ${autoFill.args} (effort=${autoFill.effort})`);
  }

  // Guard: check for recoverable orchestration state matching current task
  if (ctx.taskId) {
    const orchState = readOrchestrationState(slotNum);
    if (orchState && orchState.phase !== "done" && orchState.taskId === ctx.taskId) {
      throw new Error(
        `slot ${slotNum} has recoverable orchestration state for ${ctx.taskId} (phase: ${orchState.phase}). ` +
        `Use 'ludics slot ${slotNum} resume' to continue, or 'ludics slot ${slotNum} clear' first to discard.`
      );
    }
  }

  await runAdapterAction("start", { ...ctx, startTtyd: shouldStartTtyd });

  // Clear any prior interrupted liveness and stamp active session marker
  const sessionStartedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
  data.sessionStarted = sessionStartedAt;
  setSlotLivenessOnData(data, null);
  writeSlotOrHttp(slotNum, data);

  journalAppend("slot", `Slot ${slotNum} started (adapter=${ctx.mode})`);
  emitEvent({ event_type: "slot_start", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode });
}

/**
 * Stop the adapter session for a slot.
 */
export async function slotStop(slotNum: number, force: boolean = false, preserveState: boolean = false): Promise<void> {
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  const data = readSlot(slotNum);
  if (data.process === "(empty)") throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, data);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode`);

  // Remote dispatch: if slot is owned by another machine, send via HTTP
  if (ctx.machine && isRemoteMachine(ctx.machine)) {
    if (force) {
      console.error(`ludics: slot ${slotNum}: force-clearing local state (skipping remote stop on ${ctx.machine})`);
    } else {
      await ensureRemoteMachineReachable(slotNum, ctx.machine, "stop", ctx.mode, { taskId: ctx.taskId, preserveState });
      return;
    }
  } else {
    await runAdapterAction("stop", ctx, { preserveState });
  }

  // --- LOCAL EXECUTION ONLY ---
  clearDuoPeerLink(slotNum);

  // Clear the session-active marker
  data.sessionStarted = null;
  writeSlotOrHttp(slotNum, data);

  journalAppend("slot", `Slot ${slotNum} stopped (adapter=${ctx.mode})`);
  emitEvent({ event_type: "slot_stop", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode });
}

/**
 * Read the orchestrator PID for a slot from whichever adapter-side state file
 * owns it (t3code or tmux) and return it only when the process is actually
 * alive. Returns `null` when no PID is recorded, the PID is stale/dead, or the
 * adapter state is missing.
 *
 * Used by slotResume's idempotence short-circuit (AC5): when the caller
 * invokes resume on a slot whose orchestrator is already running, we skip the
 * terminate-and-restart path instead of churning the runner.
 */
function readLiveOrchestratorPid(slotNum: number, mode: string, harness: string): number | null {
  let pid: number | undefined;
  if (mode === "t3code") {
    pid = readSlotState(slotNum, harness)?.orchestration?.pid;
  } else if (mode === "tmux") {
    pid = readTmuxSlotState(slotNum, harness)?.orchestration?.pid;
  } else {
    return null;
  }
  if (pid === undefined || !processAlive(pid)) return null;
  return pid;
}

/**
 * Decide the ttyd pid to persist for an agent during slot re-init, bringing the
 * ttyd into a consistent state in the SAME operation as the tmux-session
 * decision (the root-cause fix for mid-session ttyd deaths — task-1373e911):
 *
 *  - `sessionRecreated` → any pre-existing ttyd is attached to the now-destroyed
 *    session instance; restart it unconditionally. (startTtyd's `pkill -f
 *    "ttyd.*--port ${port}"` clears the orphan and the fresh ttyd re-attaches
 *    the new session.) Returns the fresh pid. Skipping the restart here because
 *    the old ttyd still occupies the port is exactly the bug: that orphan dies
 *    ~30-60s later and the runner flap logic eventually trips the give-up
 *    sentinel (the observed connection-refused gap).
 *  - `!sessionRecreated` & port free → (re)start; fresh pid.
 *  - `!sessionRecreated` & port in use & a tracked prior pid is still alive →
 *    preserve it (a healthy ttyd is still serving the intact session). Never
 *    pkill a healthy ttyd here.
 *  - `!sessionRecreated` & port in use & no/dead tracked pid → restart, so we
 *    record a real pid instead of persisting `undefined`/a stale pid for a
 *    process the next `ensureTtydAlive` tick would then have to chase.
 *
 * Exported as a test seam (mirrors `createTmuxAgentSession`): the decision is
 * verified directly without driving the full resume against a live tmux.
 */
export function reinitTtydPid(opts: {
  slot: number;
  agentName: string;
  role: "coder" | "reviewer";
  taskId?: string;
  sessionRecreated: boolean;
  portInUse: boolean;
  priorPid?: number;
}): number {
  const { slot, agentName, role, taskId, sessionRecreated, portInUse, priorPid } = opts;
  if (sessionRecreated) return startTtyd(slot, agentName, role, taskId);
  if (!portInUse) return startTtyd(slot, agentName, role, taskId);
  if (priorPid !== undefined && processAlive(priorPid)) return priorPid;
  return startTtyd(slot, agentName, role, taskId);
}

/**
 * Resume a crashed orchestrated session from persisted state.
 */
export async function slotResume(slotNum: number, { startTtyd: shouldStartTtyd = true }: { startTtyd?: boolean } = {}): Promise<void> {
  ensureSlotsDir();
  const count = slotsCount();
  validateRange(slotNum, count);

  const data = readSlot(slotNum);
  if (data.process === "(empty)") throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, data);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode — nothing to resume`);

  // Remote dispatch: if slot is owned by another machine, send via HTTP
  if (ctx.machine && isRemoteMachine(ctx.machine)) {
    await ensureRemoteMachineReachable(slotNum, ctx.machine, "resume", ctx.mode, { taskId: ctx.taskId });
    return;
  }

  // --- LOCAL EXECUTION ONLY ---
  if (ctx.mode !== "t3code" && ctx.mode !== "tmux") {
    throw new Error(`slot ${slotNum} has Mode=${ctx.mode} — resume only supports t3code and tmux`);
  }
  if (!ctx.taskId) throw new Error(`slot ${slotNum} has no Task — nothing to resume`);

  // Cancel any pending deferred cleanup for this task+slot
  try {
    const { cancelDeferredCleanup } = await import("../orchestration/deferred-cleanup.ts");
    cancelDeferredCleanup(ctx.taskId, slotNum, ctx.harnessDir);
  } catch { /* non-critical */ }

  // Recoverable-from-fresh-start fallback: triggered when the slot was flagged
  // interrupted (setup failure) or escalated (agent hand-raise) AND persisted
  // state has gone missing. Normal escalations leave state intact and flow
  // through the regular resume path; the liveness marker gets cleared to null
  // at the end of this function just like a normal interrupted-resume.
  const needsFreshFallback = data.liveness === "interrupted" || data.liveness === "escalated";

  // --- t3code-specific: Require persisted slot state ---
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir);
    if (!slotState || slotState.threads.length === 0) {
      if (needsFreshFallback) {
        console.error(`ludics: slot ${slotNum}: no recoverable t3code state — falling back to fresh start`);
        try { removeOrchestrationState(slotNum, ctx.harnessDir); } catch { /* ignore */ }
        await slotStart(slotNum, { startTtyd: shouldStartTtyd });
        return;
      }
      throw new Error(
        `slot ${slotNum} has no persisted t3code state (t3code/slot-${slotNum}.json) — use 'slot start' for fresh start`
      );
    }
  }

  // Require persisted orchestration state (orchestrated sessions only)
  const orchState = readOrchestrationState(slotNum);
  if (!orchState) {
    if (needsFreshFallback) {
      console.error(`ludics: slot ${slotNum}: no recoverable orchestration state — falling back to fresh start`);
      await slotStart(slotNum, { startTtyd: shouldStartTtyd });
      return;
    }
    throw new Error(
      `slot ${slotNum} has no persisted orchestration state — ` +
      `resume only supports orchestrated sessions. Use 'slot start' for fresh start`
    );
  }

  // Guard: orchestration state must match the slot's current task
  if (orchState.taskId && orchState.taskId !== ctx.taskId) {
    throw new Error(
      `slot ${slotNum}: persisted orchestration is for task "${orchState.taskId}" but slot is assigned to "${ctx.taskId}" — ` +
      `use 'ludics slot ${slotNum} clear' then 'ludics slot ${slotNum} start' for a fresh start`
    );
  }

  if (orchState.phase === "done") {
    console.log(`Orchestration already completed for slot ${slotNum} (task ${ctx.taskId}).`);
    return;
  }

  // Idempotence (AC5): if the orchestrator is already live and no liveness
  // marker needs clearing, a second `ludics slot N resume` is a no-op. Without
  // this short-circuit we would kill the running runner and start a fresh one
  // on every redundant invocation — which also races the self-guard and can
  // leave the slot in a transiently inconsistent state. `liveness === null`
  // gates the check: if the caller wants to clear "interrupted" or
  // "escalated", they fall through to the normal terminate-and-restart path
  // that flips the marker back to null at the end.
  if (data.liveness === null) {
    const livePid = readLiveOrchestratorPid(slotNum, ctx.mode, ctx.harnessDir);
    if (livePid !== null) {
      console.log(`Slot ${slotNum} orchestrator already running (pid ${livePid}); nothing to resume.`);
      return;
    }
  }

  // --- t3code-specific: validate server and threads ---
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir)!;
    const { ensureServer } = await import("../t3code/server.ts");
    const record = await ensureServer({ harnessDir: ctx.harnessDir });

    const { T3CodeClient } = await import("../t3code/client.ts");
    const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
    try {
      const storedThreadIds = slotState.threads.map((t) => t.threadId);
      try {
        const dbPath = join(ctx.harnessDir, "t3code", "userdata", "state.sqlite");
        if (existsSync(dbPath)) {
          const { Database } = await import("bun:sqlite");
          const db = new Database(dbPath);
          const placeholders = storedThreadIds.map(() => "?").join(",");
          const result = db.run(
            `UPDATE projection_threads SET deleted_at = NULL WHERE thread_id IN (${placeholders}) AND deleted_at IS NOT NULL`,
            storedThreadIds,
          );
          if (result.changes > 0) {
            console.error(`ludics: undeleted ${result.changes} soft-deleted thread(s) for resume`);
          }
          db.close();
        }
      } catch {
        // Non-critical
      }

      const snapshot = await client.getSnapshot();
      const existingThreadIds = new Set(snapshot.threads.map((t: { id: string }) => t.id));
      const missingThreads = storedThreadIds.filter((id) => !existingThreadIds.has(id));
      if (missingThreads.length > 0) {
        throw new Error(
          `slot ${slotNum}: persisted thread(s) ${missingThreads.join(", ")} no longer exist on t3code server — ` +
          `use 'ludics slot ${slotNum} clear' then 'ludics slot ${slotNum} start' for a fresh start`
        );
      }
    } finally {
      client.close();
    }
  }

  // Collected during the tmux reconciliation loop below; hoisted to function
  // scope so the post-`startOrchestrationProcess` sibling-state write can
  // reconstruct the full TmuxSlotState even when the file was absent at resume
  // start (gh-ludics-559 defect B).
  let newTtydPids: Record<string, number> = {};

  // --- tmux-specific: verify/recreate tmux session, windows, ttyd, agent CLIs ---
  if (ctx.mode === "tmux") {
    const tmuxState = readTmuxSlotState(slotNum, ctx.harnessDir);

    if (tmuxState?.orchestration?.pid) {
      const pid = tmuxState.orchestration.pid;
      if (processAlive(pid)) {
        console.error(`ludics: terminating stale orchestration runner (pid ${pid}) before resume`);
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (processAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* race: died between check and kill */ }
        }
      }
    }

    newTtydPids = { ...(tmuxState?.ttydPids ?? {}) };
    const taskId = orchState.taskId;

    const bootCliInSession = (session: string, agent: { name: string; provider: string; model?: string; role?: "coder" | "reviewer"; thinkingEffort?: string }) => {
      const envCmd = [
        `export LUDICS_SLOT=${slotNum}`,
        `LUDICS_AGENT=${agent.name}`,
        `LUDICS_PEER_SYNC_DIR="${orchState.peerSyncDir}"`,
      ].join(" ");
      tmuxSendCommand(session, envCmd);
      tmuxSendCommand(session, agentCliCommand(agent, loadOrchestrationConfig()));
    };

    for (let i = 0; i < orchState.agents.length; i++) {
      const agent = orchState.agents[i];
      const sessionName = tmuxSessionName(slotNum, agent.name, taskId);
      const role: "coder" | "reviewer" =
        agent.role === "coder" || agent.role === "reviewer"
          ? agent.role
          : i % 2 === 0 ? "coder" : "reviewer";
      const port = ttydPort(slotNum, role);

      const sessionExists = tmuxHasSession(sessionName);

      if (!sessionExists) {
        const cwd = agent.worktreePath;
        tmuxNewSession(sessionName, cwd);
        safeSyncOutput(["tmux", "set-option", "-t", sessionName, "mouse", "off"]);
        console.error(`ludics: re-created tmux session '${sessionName}'`);

        bootCliInSession(sessionName, agent);
        console.error(`ludics: booted ${agent.provider} CLI in '${sessionName}'`);
      } else {
        tmuxSendKeys(sessionName, "C-c");
        tmuxSendKeys(sessionName, "C-c");
        tmuxSendKeys(sessionName, "Enter");
        await Bun.sleep(200);

        if (!isAgentAlive(slotNum, agent.name, taskId)) {
          bootCliInSession(sessionName, agent);
          console.error(`ludics: re-booted ${agent.provider} CLI in existing session '${sessionName}'`);
        } else {
          console.error(`ludics: session '${sessionName}' exists, agent CLI alive — reset shell state only`);
        }
      }

      if (shouldStartTtyd) {
        let portInUse = false;
        try {
          const lsofBin = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
          portInUse = safeSyncOutput([lsofBin, "-i", `:${port}`]).ok;
        } catch { /* lsof not available */ }
        // Bring the ttyd into a consistent state in the same operation as the
        // session decision. On a recreate the port-in-use ttyd is an orphan
        // attached to the destroyed session and MUST be replaced; the skip is
        // valid only when the session was left intact and a healthy ttyd is
        // still serving it (see reinitTtydPid).
        newTtydPids[agent.name] = reinitTtydPid({
          slot: slotNum,
          agentName: agent.name,
          role,
          taskId,
          sessionRecreated: !sessionExists,
          portInUse,
          priorPid: tmuxState?.ttydPids?.[agent.name],
        });
        console.error(
          `ludics: ttyd for ${agent.name} on port ${port} reconciled ` +
          `(recreated=${!sessionExists}, portInUse=${portInUse}, pid=${newTtydPids[agent.name]})`,
        );
      }
    }

    if (tmuxState) {
      writeTmuxSlotState({ ...tmuxState, ttydPids: newTtydPids }, ctx.harnessDir);
    }
  }

  // --- t3code-specific: terminate stale runner ---
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir)!;
    if (slotState.orchestration?.pid) {
      const pid = slotState.orchestration.pid;
      if (processAlive(pid)) {
        console.error(`ludics: terminating stale orchestration runner (pid ${pid}) before resume`);
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (processAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* race: died between check and kill */ }
        }
      }
    }
  }

  // Reset turnLifecycle for all agents
  for (const agentName of Object.keys(orchState.agentStates)) {
    orchState.agentStates[agentName]!.turnLifecycle = null;
  }
  orchState.phaseDispatched = false;
  persistState(orchState, ctx.harnessDir);

  const newPid = await startOrchestrationProcess(slotNum, ctx.harnessDir, orchState.taskId);

  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir)!;
    if (!slotState.orchestration) {
      throw new Error(`slot ${slotNum}: persisted t3code state has no orchestration record — use 'slot start' for fresh start`);
    }
    writeSlotState({
      ...slotState,
      orchestration: { ...slotState.orchestration, pid: newPid },
    }, ctx.harnessDir);
  } else if (ctx.mode === "tmux") {
    // Unconditional sibling-state write (gh-ludics-559 defect B). When
    // `tmux-slot-N.json` is absent (post-tmux-server-restart, post-`stop`), the
    // helper reconstructs the full TmuxSlotState mirroring `start()`; when it is
    // present, the helper patches in place, preserving unmanaged fields such as
    // `ttydRestartCounts`. Previously this write was guarded by `if (tmuxState)`
    // and silently no-op'd on a missing file, so the runner exited on the
    // sibling-state self-guard grace timeout.
    const tmuxState = readTmuxSlotState(slotNum, ctx.harnessDir);
    writeTmuxOrchestrationSiblingState({
      slot: slotNum,
      harnessDir: ctx.harnessDir,
      mode: orchState.mode,
      pid: newPid,
      ttydPids: newTtydPids,
      existing: tmuxState,
    });
  }

  // Clear interrupted liveness and stamp session-active marker
  const sessionStartedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
  data.sessionStarted = sessionStartedAt;
  setSlotLivenessOnData(data, null);
  writeSlotOrHttp(slotNum, data);

  journalAppend("slot", `Slot ${slotNum} resumed (adapter=${ctx.mode}, phase=${orchState.phase}, task=${ctx.taskId})`);
  emitEvent({
    event_type: "slot_resume",
    source: "cli",
    scope: "slot",
    slot: slotNum,
    adapter: ctx.mode,
    task: ctx.taskId,
  });
  console.log(`Slot ${slotNum} resumed: orchestration continuing from phase "${orchState.phase}"`);
}

export async function slotsRefresh(): Promise<void> {
  ensureSlotsDir();
  const count = slotsCount();
  const updatedSlots: number[] = [];

  for (let i = 1; i <= count; i++) {
    let data = readSlot(i);
    if (!data.mode) continue;

    const ctx = makeAdapterContext(i, data);
    const output = await readAdapterState(ctx);
    if (output) {
      data = mergeAdapterState(data, output);
      updatedSlots.push(i);
      console.error(`ludics: refreshed slot ${i} (${data.mode})`);
    }

    // Update task modified timestamp from adapter activity
    if (data.task) {
      const activity = await readAdapterLastActivity(ctx);
      if (activity) {
        if (isWorkerContext()) {
          try {
            const { clusterPostTaskUpdate } = await import("../cluster-http.ts");
            await clusterPostTaskUpdate(data.task, "modified", activity);
          } catch { /* ignore */ }
        } else {
          const tf = taskFilePath(data.task);
          addFrontmatterField(tf, "modified", activity);
        }
      }
    }

    if (output) {
      if (isWorkerContext()) {
        try {
          const { clusterPostSlotUpdate } = await import("../cluster-http.ts");
          await clusterPostSlotUpdate(i, {
            sessionStarted: data.sessionStarted || undefined,
            liveness: data.liveness || undefined,
            terminals: data.terminals || undefined,
            runtime: data.runtime || undefined,
            git: data.git || undefined,
          }).catch(() => {});
        } catch { /* ignore */ }
      } else {
        writeSlotJson(i, data);
      }
    }
  }

  if (updatedSlots.length > 0 && !isWorkerContext()) {
    stateMarkDirty();
  }
}

// --- CLI handler ---

export async function runSlots(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  if (sub === "refresh") {
    await slotsRefresh();
    return;
  }

  // Default: list slots
  if (sub === "" || sub === "list") {
    slotsList();
    return;
  }

  throw new Error(`unknown slots subcommand: ${sub}`);
}

export async function runSlot(args: string[]): Promise<void> {
  const slotStr = args[0];
  if (!slotStr || !/^\d+$/.test(slotStr)) {
    throw new Error("slot number required (e.g., ludics slot 1)");
  }
  const slotNum = parseInt(slotStr, 10);
  const sub = args[1] ?? "";

  switch (sub) {
    case "":
      slotShow(slotNum);
      break;

    case "assign": {
      const taskOrDesc = args[2];
      if (!taskOrDesc) throw new Error("task or description required");
      // Parse optional flags
      let adapter = "manual";
      let session = "";
      let path = "";
      const adapterArgFragments: string[] = [];
      let machine = "";
      let hasDirectOrchFlags = false;
      let firstDirectOrchFlagIdx = -1;
      for (let i = 3; i < args.length; i++) {
        switch (args[i]) {
          case "-a": adapter = args[++i] ?? "manual"; break;
          case "-s": session = args[++i] ?? ""; break;
          case "-p": path = args[++i] ?? ""; break;
          case "--machine": machine = args[++i] ?? ""; break;
          case "-A":
          case "--adapter-args": {
            const raw = args[++i];
            if (raw === undefined) throw new Error("--adapter-args requires a value");
            adapterArgFragments.push(raw);
            break;
          }
          case "--pair":
            hasDirectOrchFlags = true;
            adapterArgFragments.push("--pair");
            break;
          case "--duo":
            hasDirectOrchFlags = true;
            adapterArgFragments.push("--duo");
            break;
          case "--solo":
            hasDirectOrchFlags = true;
            adapterArgFragments.push("--solo");
            break;
          case "--pilot":
            hasDirectOrchFlags = true;
            adapterArgFragments.push("--pilot");
            break;
          case "--coder": {
            const val = args[++i];
            if (!val || val.startsWith("-")) throw new Error("--coder requires a provider value (got a flag instead)");
            hasDirectOrchFlags = true;
            if (firstDirectOrchFlagIdx === -1) firstDirectOrchFlagIdx = adapterArgFragments.length;
            adapterArgFragments.push(`--coder ${val}`);
            break;
          }
          case "--reviewer": {
            const val = args[++i];
            if (!val || val.startsWith("-")) throw new Error("--reviewer requires a provider value (got a flag instead)");
            hasDirectOrchFlags = true;
            if (firstDirectOrchFlagIdx === -1) firstDirectOrchFlagIdx = adapterArgFragments.length;
            adapterArgFragments.push(`--reviewer ${val}`);
            break;
          }
          case "--plan":
            hasDirectOrchFlags = true;
            if (firstDirectOrchFlagIdx === -1) firstDirectOrchFlagIdx = adapterArgFragments.length;
            adapterArgFragments.push("--plan");
            break;
        }
      }

      // Fast-fail on phantom adapters before the orchestration-flag guard so
      // `-a agent-pair-codex --pair` gets the precise canonical-adapter error
      // rather than the less-specific "--pair requires t3code or tmux" one.
      validateAssignAdapter(adapter);

      if (hasDirectOrchFlags && adapter !== "t3code" && adapter !== "tmux") {
        throw new Error(
          `--pair/--solo/--pilot/--coder/--reviewer/--plan flags require adapter "t3code" or "tmux" (got "${adapter}")`
        );
      }

      if (hasDirectOrchFlags || adapterArgFragments.some(f => /--(?:pair|duo|solo|pilot)/.test(f))) {
        const expected = globalAdapter();
        if ((adapter === "t3code" || adapter === "tmux") && adapter !== expected) {
          throw new Error(
            `slot ${slotNum}: adapter "${adapter}" does not match global config adapter "${expected}".\n` +
            `  Either change config.yaml to 'adapter: ${adapter}' or use '-a ${expected}'.`
          );
        }
      }

      const hasDuoDirectFlag = adapterArgFragments.includes("--duo");
      const hasDuoInRawFragments = adapterArgFragments.some(
        f => /(?:^|\s)--duo(?:\s|$)/.test(f) && !/--duo-peer-slot/.test(f)
      );
      const isDuoAssign = hasDuoDirectFlag || hasDuoInRawFragments;

      if (isDuoAssign) {
        ensureSlotsDir();
        const allSlots = readAllSlots();
        const totalSlots = slotsCount();
        let secondSlot: number | null = null;
        for (let s = 1; s <= totalSlots; s++) {
          if (s === slotNum) continue;
          const sd = allSlots.get(s);
          if (!sd || sd.process === "(empty)") { secondSlot = s; break; }
        }
        if (secondSlot === null) {
          throw new Error(`duo mode requires two empty slots; only slot ${slotNum} is available`);
        }
        const cleanedFragments = adapterArgFragments
          .map(f => f.replace(/(?:^|\s)--duo(?:\s|$)/g, " ").trim())
          .filter(Boolean);
        const baseArgs = cleanedFragments.join(" ");
        const expansion = expandDuoSlots(slotNum, secondSlot, baseArgs);
        await slotAssign(slotNum, taskOrDesc, adapter, session, path, expansion.slotA.args, machine);
        await slotAssign(secondSlot, taskOrDesc, adapter, "", path, expansion.slotB.args, machine);
        console.error(`ludics: duo assign → slots ${slotNum}+${secondSlot}`);
      } else {
        const hasModeDirectFlag = adapterArgFragments.includes("--pair") || adapterArgFragments.includes("--solo") || adapterArgFragments.includes("--pilot");
        const hasModeInRawFragments = adapterArgFragments.some(
          f => /(?:^|\s)--(?:pair|duo|solo|pilot)(?:\s|$)/.test(f)
        );
        if (hasDirectOrchFlags && !hasModeDirectFlag && !hasModeInRawFragments && firstDirectOrchFlagIdx !== -1) {
          adapterArgFragments.splice(firstDirectOrchFlagIdx, 0, "--pair");
        }

        const adapterArgs = adapterArgFragments.join(" ");
        await slotAssign(slotNum, taskOrDesc, adapter, session, path, adapterArgs, machine);
      }
      break;
    }

    case "clear": {
      const finalStatus = args[2] ?? "ready";
      if (!(VALID_CLEAR_STATUSES as readonly string[]).includes(finalStatus)) {
        throw new Error(`invalid clear status: ${finalStatus} (use: ${VALID_CLEAR_STATUSES.join(", ")})`);
      }
      await slotClear(slotNum, finalStatus);
      break;
    }

    case "start":
      await slotStart(slotNum);
      break;

    case "stop": {
      const forceStop = args.includes("--force");
      const preserveState = args.includes("--preserve-state");
      await slotStop(slotNum, forceStop, preserveState);
      break;
    }

    case "resume":
      await slotResume(slotNum);
      break;

    case "note": {
      const noteText = args[2];
      if (!noteText) throw new Error("note text required");
      slotNote(slotNum, noteText);
      break;
    }

    case "mode": {
      const modeVal = args[2];
      if (!modeVal) throw new Error("mode value required (e.g., manual, t3code)");
      await slotSetMode(slotNum, modeVal);
      break;
    }

    case "reset":
      slotReset(slotNum);
      break;

    case "preempt": {
      const preemptTask = args[2];
      if (!preemptTask) throw new Error("task id required for preempt");
      let adapter = "manual";
      let session = "";
      let path = "";
      let adapterArgs = "";
      for (let i = 3; i < args.length; i++) {
        switch (args[i]) {
          case "-a": adapter = args[++i] ?? "manual"; break;
          case "-s": session = args[++i] ?? ""; break;
          case "-p": path = args[++i] ?? ""; break;
          case "-A":
          case "--adapter-args":
            adapterArgs = args[++i] ?? "";
            break;
        }
      }
      await slotPreempt(slotNum, preemptTask, adapter, session, path, adapterArgs);
      break;
    }

    case "restore":
      await slotRestore(slotNum);
      break;

    default:
      throw new Error(`unknown slot subcommand: ${sub}`);
  }
}
