// Slot operations — list, show, assign, clear, note, start, stop, refresh

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { globalAdapter, harnessDir, slotsFilePath, slotsCount, stateRepoDir, resolveProjectPath } from "../config.ts";
import { parseSlotBlocks, getField, getTask, getMode, getSession, getProcess, getPath, getStarted, getAdapterArgs,
         getSessionStarted, getMachine, getLiveness, setField,
         emptyBlock, writeSlotFile, addNoteToBlock, mergeAdapterState } from "./markdown.ts";
import { stateCommit } from "../state.ts";
import { journalAppend } from "../journal.ts";
import { emitEvent } from "../events.ts";
import { runAdapterAction, readAdapterState, readAdapterLastActivity } from "../adapters/index.ts";
import type { AdapterContext } from "../adapters/index.ts";
import { addFrontmatterField, updateFrontmatterField, updateDependencyArray, parseTaskFrontmatter } from "../tasks/markdown.ts";
import { hasStash, readStash, writeStash, removeStash } from "./preempt.ts";
import { expandDuoSlots } from "./duo-expand.ts";
import type { PreemptStash } from "./preempt.ts";
import { readSlotState, writeSlotState } from "../t3code/server.ts";
import { readOrchestrationState, persistState, removeOrchestrationState } from "../orchestration/state.ts";
import { startOrchestrationProcess } from "../orchestration/process.ts";
import { isRemoteMachine } from "../remote.ts";
import { writeSlotIntent } from "../slot-intents.ts";
import { heartbeatIsFresh } from "../federation.ts";

function ensureSlotsFile(): string {
  const file = slotsFilePath();
  if (!existsSync(file)) {
    const count = slotsCount();
    const blocks = new Map<number, string>();
    writeSlotFile(file, blocks, count);
  }
  return file;
}

function loadBlocks(file: string): Map<number, string> {
  const content = readFileSync(file, "utf-8");
  return parseSlotBlocks(content);
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

function taskUpdateFrontmatter(taskId: string, field: string, value: string): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) return;

  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  let inFrontmatter = false;
  let done = false;

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
    if (inFrontmatter && !done && line.startsWith(`${field}:`)) {
      output.push(`${field}: ${value}`);
      done = true;
      continue;
    }
    output.push(line);
  }

  writeFileSync(file, output.join("\n"));
}

function taskUpdateForSlotAssign(taskId: string, slot: number, adapter: string, started: string): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) {
    console.error(`ludics: task file not found: ${taskId} (skipping task update)`);
    return;
  }
  taskUpdateFrontmatter(taskId, "status", "in-progress");
  taskUpdateFrontmatter(taskId, "slot", String(slot));
  taskUpdateFrontmatter(taskId, "adapter", adapter);
  taskUpdateFrontmatter(taskId, "started", started);
}

function taskUpdateForSlotClear(taskId: string, finalStatus: string): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) {
    console.error(`ludics: task file not found: ${taskId} (skipping task update)`);
    return;
  }
  taskUpdateFrontmatter(taskId, "status", finalStatus);
  taskUpdateFrontmatter(taskId, "slot", "null");

  if (finalStatus === "done" || finalStatus === "abandoned") {
    const completed = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
    taskUpdateFrontmatter(taskId, "completed", completed);
  }
}

// --- Slot CLI handlers ---

export function slotsList(): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();

  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    const process = block ? getProcess(block) : "(empty)";
    const machineName = block ? getMachine(block).trim() : "";
    const machineStr = machineName && machineName !== "null" ? ` [${machineName}]` : "";
    console.log(`Slot ${i}: ${process}${machineStr}`);
  }
}

export function slotShow(slotNum: number): void {
  const count = slotsCount();
  validateRange(slotNum, count);
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const block = blocks.get(slotNum);
  if (!block) {
    console.log(emptyBlock(slotNum));
  } else {
    console.log(block.trimEnd());
  }
}

export function slotAssign(
  slotNum: number,
  taskOrDesc: string,
  adapter: string = "manual",
  session: string = "",
  path: string = "",
  adapterArgs: string = "",
  machine: string = "",
): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");

  // Normalize path
  if (path && path !== "/") {
    path = path.replace(/\/$/, "");
  }
  adapterArgs = adapterArgs.trim();

  // Determine task ID vs description
  let taskId: string;
  let processDesc: string;
  const tf = taskFilePath(taskOrDesc);
  if (existsSync(tf)) {
    taskId = taskOrDesc;
    const content = readFileSync(tf, "utf-8");
    const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
    processDesc = titleMatch ? titleMatch[1]! : taskId;
  } else {
    taskId = "null";
    processDesc = taskOrDesc;
  }

  // Session handling
  if (!session) {
    switch (adapter) {
      case "agent-claude":
      case "agent-codex":
      case "manual":
        session = String(slotNum);
        break;
      case "t3code":
        session = "null";
        break;
      default:
        session = String(slotNum);
        break;
    }
  }

  const block = `## Slot ${slotNum}

**Process:** ${processDesc}
**Task:** ${taskId}
**Mode:** ${adapter}
**Session:** ${session}
**Path:** ${path || "null"}
**Started:** ${started}
**Adapter Args:** ${adapterArgs || "null"}
**Machine:** ${machine || "null"}
**Session Started:** null

**Terminals:**

**Runtime:**
- Assigned via ludics

**Git:**
`;

  // Clear metadata on the previous task (if any) being replaced in this slot
  const oldBlock = blocks.get(slotNum);
  if (oldBlock) {
    const oldTaskId = getTask(oldBlock).trim();
    if (oldTaskId && oldTaskId !== "null" && oldTaskId !== taskId) {
      const oldTaskFile = taskFilePath(oldTaskId);
      if (existsSync(oldTaskFile)) {
        updateFrontmatterField(oldTaskFile, "slot", "null");
        const oldContent = readFileSync(oldTaskFile, "utf-8");
        const oldStatus = oldContent.match(/^status:\s*(.+)$/m)?.[1]?.trim();
        if (oldStatus === "in-progress") {
          updateFrontmatterField(oldTaskFile, "status", "ready");
        }
      }
    }
  }

  blocks.set(slotNum, block);
  writeSlotFile(file, blocks, count);

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
  if (taskId !== "null") {
    taskUpdateForSlotAssign(taskId, slotNum, adapter, started);
  }

  journalAppend("slot", `Slot ${slotNum} assigned: ${processDesc} (task=${taskId}, adapter=${adapter})`);
  emitEvent({ event_type: "slot_assign", source: "cli", scope: "slot", slot: slotNum, task: taskId !== "null" ? taskId : undefined, adapter, message: processDesc });
  stateCommit(`slot ${slotNum}: assign ${taskOrDesc}`);
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

export function slotClear(slotNum: number, finalStatus: string = "ready"): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  // Hierarchical duo: clear duoPeerSlot on sibling so it becomes a regular pair slot
  clearDuoPeerLink(slotNum);

  const block = blocks.get(slotNum) ?? "";
  const taskId = block ? getTask(block) : "null";

  // Save t3code thread IDs to task file frontmatter before clearing the slot state
  const mode = block ? getMode(block).trim() : "";
  if (mode === "t3code" && taskId && taskId !== "null") {
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

  blocks.set(slotNum, emptyBlock(slotNum));
  writeSlotFile(file, blocks, count);

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

  if (taskId && taskId !== "null") {
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

  stateCommit(`slot ${slotNum}: cleared (status=${finalStatus})`);

  // Auto-restore preempted work when priority task completes
  if (finalStatus === "done" && hasStash(slotNum)) {
    console.error(`ludics: auto-restoring preempted work to slot ${slotNum}`);
    slotRestore(slotNum);
  }
}

/**
 * Mark a slot as interrupted due to orchestration setup failure.
 * Unlike slotClear, this keeps the slot assigned (not empty) so that
 * maybeFillEmptySlots won't overwrite it with a different task.
 * The dashboard will show "Interrupted" with a Resume button.
 */
export function markSlotSetupFailed(slotNum: number, error: string): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) return;

  const taskId = getTask(block).trim();

  // Mark slot as interrupted
  let updated = setField(block, "Liveness", "interrupted");
  // Clear Session Started so maybeAutoStartSlots doesn't think it's active
  updated = setField(updated, "Session Started", "null");
  blocks.set(slotNum, updated);
  writeSlotFile(file, blocks, count);

  // Reset task status from in-progress back to ready so it's not orphaned
  if (taskId && taskId !== "null") {
    const taskFile = taskFilePath(taskId);
    if (existsSync(taskFile)) {
      const content = readFileSync(taskFile, "utf-8");
      const statusMatch = content.match(/^status:\s*(.+)$/m);
      if (statusMatch && statusMatch[1]!.trim() === "in-progress") {
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
    task: taskId !== "null" ? taskId : undefined,
    message: `setup failed: ${error}`,
  });
  stateCommit(`slot ${slotNum}: setup failed (interrupted)`);
}

/**
 * Mark a task as done directly (without a slot clear).
 * Used when a task has no slot assignment but needs to be completed,
 * e.g. from `ludics mag completed <proposal-name>`.
 */
export function taskCompleteDirectly(taskId: string): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) {
    console.error(`ludics: task file not found: ${taskId} (skipping task update)`);
    return;
  }
  taskUpdateFrontmatter(taskId, "status", "done");
  taskUpdateFrontmatter(taskId, "slot", "null");
  const completed = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
  taskUpdateFrontmatter(taskId, "completed", completed);
  pruneBlockedBy(taskId);
  emitEvent({ event_type: "task_completed", source: "cli", scope: "task", task: taskId, status: "done", message: "direct completion (no slot)" });
  stateCommit(`completed: ${taskId} (direct)`);
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

export function slotPreempt(
  slotNum: number,
  taskId: string,
  adapter: string = "manual",
  session: string = "",
  path: string = "",
  adapterArgs: string = "",
): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum) ?? "";
  const currentProcess = block ? getProcess(block).trim() : "";
  const isEmpty = !currentProcess || currentProcess === "(empty)";

  // If slot is empty, just assign directly — no stash needed
  if (isEmpty) {
    slotAssign(slotNum, taskId, adapter, session, path, adapterArgs);
    return;
  }

  // No double preemption
  if (hasStash(slotNum)) {
    throw new Error(`slot ${slotNum} already has a preempted stash (no double preemption)`);
  }

  // Save current slot state to stash
  const currentTask = getTask(block).trim();
  const stash: PreemptStash = {
    slotNum,
    previousTask: currentTask,
    previousProcess: currentProcess,
    previousMode: getMode(block).trim(),
    previousSession: getSession(block).trim(),
    previousPath: getPath(block).trim(),
    previousStarted: getField(block, "Started").trim(),
    previousAdapterArgs: getAdapterArgs(block).trim(),
    preemptedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z"),
    preemptingTask: taskId,
  };
  writeStash(stash);

  // Set previous task status to "preempted"
  if (currentTask && currentTask !== "null") {
    taskUpdateFrontmatter(currentTask, "status", "preempted");
  }

  // Assign the new priority task
  slotAssign(slotNum, taskId, adapter, session, path, adapterArgs);

  journalAppend("slot", `Slot ${slotNum} preempted: ${currentProcess} → ${taskId}`);
  emitEvent({ event_type: "slot_preempt", source: "cli", scope: "slot", slot: slotNum, task: taskId, message: `preempted ${currentProcess}` });
  stateCommit(`slot ${slotNum}: preempt for ${taskId}`);
}

export function slotRestore(slotNum: number): void {
  const count = slotsCount();
  validateRange(slotNum, count);

  const stash = readStash(slotNum);
  if (!stash) {
    throw new Error(`slot ${slotNum} has no preempted stash to restore`);
  }

  // Restore previous assignment
  const prevAdapter = stash.previousMode === "null" ? "manual" : stash.previousMode;
  const prevSession = stash.previousSession === "null" ? "" : stash.previousSession;
  const prevPath = stash.previousPath === "null" ? "" : stash.previousPath;
  const prevAdapterArgs = !stash.previousAdapterArgs || stash.previousAdapterArgs === "null"
    ? ""
    : stash.previousAdapterArgs;
  const prevTask = stash.previousTask === "null" ? stash.previousProcess : stash.previousTask;

  slotAssign(slotNum, prevTask, prevAdapter, prevSession, prevPath, prevAdapterArgs);

  // Restore previous task status to "in-progress"
  if (stash.previousTask && stash.previousTask !== "null") {
    taskUpdateFrontmatter(stash.previousTask, "status", "in-progress");
  }

  removeStash(slotNum);

  journalAppend("slot", `Slot ${slotNum} restored: ${stash.previousProcess} (from preempt by ${stash.preemptingTask})`);
  emitEvent({ event_type: "slot_restore", source: "cli", scope: "slot", slot: slotNum, task: stash.previousTask !== "null" ? stash.previousTask : undefined, message: `restored from preempt by ${stash.preemptingTask}` });
  stateCommit(`slot ${slotNum}: restored ${stash.previousProcess}`);
}

export function slotNote(slotNum: number, note: string): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) {
    throw new Error(`slot ${slotNum} not found`);
  }

  blocks.set(slotNum, addNoteToBlock(block, note));
  writeSlotFile(file, blocks, count);
}

export async function slotSetMode(slotNum: number, mode: string): Promise<void> {
  const file = ensureSlotsFile();
  let blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  let block = blocks.get(slotNum);
  if (!block) {
    throw new Error(`slot ${slotNum} not found`);
  }

  const sessionStarted = getSessionStarted(block).trim();
  const hasActiveSession = sessionStarted && sessionStarted !== "null";

  if (hasActiveSession) {
    const currentMode = getMode(block).trim();
    const isAutomated = currentMode === "tmux" || currentMode === "t3code";
    if (isAutomated && mode === "manual") {
      // Kill processes but preserve state for later resume
      await slotStop(slotNum, false, true);
      // Re-read blocks since slotStop modified the file
      blocks = loadBlocks(file);
      block = blocks.get(slotNum)!;
    } else {
      throw new Error(
        `slot ${slotNum} has an active session (started at ${sessionStarted}); stop or clear the slot before switching to ${mode}`,
      );
    }
  }

  // Update the Mode field in-place
  const updated = block.split("\n").map(line => {
    if (line.startsWith("**Mode:**")) {
      return `**Mode:** ${mode}`;
    }
    return line;
  }).join("\n");

  blocks.set(slotNum, updated);
  writeSlotFile(file, blocks, count);

  // Keep task file adapter: field in sync
  const taskId = getTask(updated).trim();
  if (taskId && taskId !== "null") {
    taskUpdateFrontmatter(taskId, "adapter", mode);
  }

  journalAppend("slot", `Slot ${slotNum} mode set to ${mode}`);
  emitEvent({ event_type: "slot_mode", source: "cli", scope: "slot", slot: slotNum, message: `mode=${mode}` });
  stateCommit(`slot ${slotNum}: mode=${mode}`);
}

function makeAdapterContext(slotNum: number, block: string): AdapterContext {
  const mode = getMode(block).trim();
  const session = getSession(block).trim();
  const path = getPath(block).trim();
  const started = getStarted(block).trim();
  const taskIdRaw = getTask(block).trim();
  const adapterArgs = getAdapterArgs(block).trim();
  const process = getProcess(block).trim();
  const machineName = getMachine(block).trim();

  let resolvedPath = path === "null" ? "" : path;

  // If path is empty, try to resolve from the task's project config
  if (!resolvedPath && taskIdRaw && taskIdRaw !== "null") {
    const taskFile = join(harnessDir(), "tasks", `${taskIdRaw}.md`);
    if (existsSync(taskFile)) {
      const content = readFileSync(taskFile, "utf-8");
      const projectMatch = content.match(/^project:\s*(.+)$/m);
      if (projectMatch) {
        resolvedPath = resolveProjectPath(projectMatch[1]!.trim());
      }
    }
  }

  return {
    slot: slotNum,
    mode: mode === "null" ? "" : mode,
    session: session === "null" ? "" : session,
    path: resolvedPath,
    started: started === "null" ? "" : started,
    taskId: taskIdRaw === "null" ? "" : taskIdRaw,
    adapterArgs: adapterArgs === "null" ? "" : adapterArgs,
    process: process === "(empty)" ? "" : process,
    machine: machineName === "null" ? "" : machineName,
    harnessDir: harnessDir(),
    stateRepoDir: stateRepoDir(),
  };
}

export async function slotStart(slotNum: number, { startTtyd: shouldStartTtyd = true }: { startTtyd?: boolean } = {}): Promise<void> {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, block);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode`);

  // Remote dispatch: if slot is owned by another machine, write intent file
  if (ctx.machine && isRemoteMachine(ctx.machine)) {
    if (!heartbeatIsFresh(ctx.machine)) {
      throw new Error(`slot ${slotNum}: assigned machine ${ctx.machine} is offline — cannot start`);
    }
    console.error(`ludics: slot ${slotNum}: queuing start intent for remote machine ${ctx.machine}`);

    writeSlotIntent(slotNum, { action: "start", epoch: Math.floor(Date.now() / 1000), machine: ctx.machine });

    // Checkpoint and push state so the worker sees fresh slot/task metadata + intent
    const { stateCheckpoint } = await import("../state.ts");
    try { stateCheckpoint(`remote start intent slot ${slotNum}`, { push: true }); } catch { /* ignore */ }

    journalAppend("slot", `Slot ${slotNum} start queued for ${ctx.machine}`);
    emitEvent({ event_type: "slot_start_queued", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode, machine: ctx.machine, message: `start queued for ${ctx.machine}` });
    return;
  }

  if ((ctx.mode === "t3code" || ctx.mode === "tmux") && !ctx.adapterArgs.trim()) {
    throw new Error(
      `slot ${slotNum}: ${ctx.mode} adapter requires orchestration flags.\n` +
      `  Reassign with one of:\n` +
      `    ludics slot ${slotNum} assign <task> -a ${ctx.mode} --pair --coder <provider> --reviewer <provider>\n` +
      `    ludics slot ${slotNum} assign <task> -a ${ctx.mode} -A "<flags>"`
    );
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
  let updated = setField(block, "Session Started", sessionStartedAt);
  updated = setField(updated, "Liveness", "null");
  if (updated !== block) {
    blocks.set(slotNum, updated);
    writeSlotFile(file, blocks, count);
  }

  journalAppend("slot", `Slot ${slotNum} started (adapter=${ctx.mode})`);
  emitEvent({ event_type: "slot_start", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode });
}

export async function slotStop(slotNum: number, force: boolean = false, preserveState: boolean = false): Promise<void> {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, block);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode`);

  // Remote dispatch: if slot is owned by another machine, delegate via SSH
  if (ctx.machine && isRemoteMachine(ctx.machine)) {
    if (force) {
      // --force: clear controller-side state without contacting the remote machine
      console.error(`ludics: slot ${slotNum}: force-clearing local state (skipping remote stop on ${ctx.machine})`);
    } else {
      // Async stop: write intent, return early. Worker processes on next keepalive.
      // Do NOT clear Session Started or duo peer link — worker hasn't stopped yet.
      console.error(`ludics: slot ${slotNum}: queuing stop intent for remote machine ${ctx.machine}`);
      writeSlotIntent(slotNum, { action: "stop", epoch: Math.floor(Date.now() / 1000), machine: ctx.machine, preserveState });
      const { stateCheckpoint } = await import("../state.ts");
      try { stateCheckpoint(`remote stop intent slot ${slotNum}`, { push: true }); } catch { /* ignore */ }
      journalAppend("slot", `Slot ${slotNum} stop queued for ${ctx.machine}`);
      emitEvent({ event_type: "slot_stop_queued", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode, machine: ctx.machine, message: `stop queued for ${ctx.machine}` });
      return;
    }
  } else {
    await runAdapterAction("stop", ctx, { preserveState });
  }

  // Hierarchical duo: clear duoPeerSlot on sibling AFTER stop succeeds,
  // so a failed stop doesn't prematurely detach the sibling.
  clearDuoPeerLink(slotNum);

  // Clear the session-active marker so the mode toggle becomes available again
  const updated = setField(block, "Session Started", "null");
  if (updated !== block) {
    blocks.set(slotNum, updated);
    writeSlotFile(file, blocks, count);
  }

  journalAppend("slot", `Slot ${slotNum} stopped (adapter=${ctx.mode})`);
  emitEvent({ event_type: "slot_stop", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode });
}

/** Resume a crashed orchestrated t3code session from persisted state.
 *  Unlike slotStart(), does not reinitialize threads/worktrees/orchestration.
 *  Only supports orchestrated t3code sessions — single-thread sessions have no state to resume. */
export async function slotResume(slotNum: number, { startTtyd: shouldStartTtyd = true }: { startTtyd?: boolean } = {}): Promise<void> {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, block);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode — nothing to resume`);

  // Remote dispatch: if slot is owned by another machine, write intent file
  if (ctx.machine && isRemoteMachine(ctx.machine)) {
    console.error(`ludics: slot ${slotNum}: queuing resume intent for remote machine ${ctx.machine}`);
    writeSlotIntent(slotNum, { action: "resume", epoch: Math.floor(Date.now() / 1000), machine: ctx.machine });
    const { stateCheckpoint } = await import("../state.ts");
    try { stateCheckpoint(`remote resume intent slot ${slotNum}`, { push: true }); } catch { /* ignore */ }
    journalAppend("slot", `Slot ${slotNum} resume queued for ${ctx.machine}`);
    emitEvent({ event_type: "slot_resume_queued", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode, machine: ctx.machine, message: `resume queued for ${ctx.machine}` });
    return;
  }

  if (ctx.mode !== "t3code" && ctx.mode !== "tmux") {
    throw new Error(`slot ${slotNum} has Mode=${ctx.mode} — resume only supports t3code and tmux`);
  }
  if (!ctx.taskId) throw new Error(`slot ${slotNum} has no Task — nothing to resume`);

  // --- t3code-specific: Require persisted slot state ---
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir);
    if (!slotState || slotState.threads.length === 0) {
      // If slot was interrupted before state was persisted, fall back to fresh start
      const slotLiveness = getLiveness(block).trim();
      if (slotLiveness === "interrupted") {
        console.error(`ludics: slot ${slotNum}: no recoverable t3code state — falling back to fresh start`);
        // Clean up any stale orchestration state that slotStart's guard would reject
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
    // If slot was interrupted before orchestration state was persisted, fall back to fresh start
    const slotLiveness = getLiveness(block).trim();
    if (slotLiveness === "interrupted") {
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

  // --- t3code-specific: validate server and threads ---
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir)!;
    // Ensure t3code server is running
    const { ensureServer } = await import("../t3code/server.ts");
    const record = await ensureServer({ harnessDir: ctx.harnessDir });

    // Validate stored thread IDs still exist on the server
    const { T3CodeClient } = await import("../t3code/client.ts");
    const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
    try {
      // Undelete any soft-deleted threads we need (t3code auto-cleans old project
      // threads when new ones are created, but resume reuses the old thread IDs)
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
        // Non-critical — continue with resume, threads might still work
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

  // --- tmux-specific: verify/recreate tmux session, windows, ttyd, agent CLIs ---
  if (ctx.mode === "tmux") {
    const { tmuxHasSession, tmuxNewSession, tmuxSendCommand, tmuxSendKeys } = await import("../adapters/tmux.ts");
    const { readTmuxSlotState, writeTmuxSlotState, tmuxSessionName, ttydPort, agentCliCommand, isAgentAlive, startTtyd } = await import("../adapters/tmux-adapter.ts");
    const tmuxState = readTmuxSlotState(slotNum, ctx.harnessDir);

    // Kill stale orchestration runner from tmux state first
    if (tmuxState?.orchestration?.pid) {
      const pid = tmuxState.orchestration.pid;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
      if (alive) {
        console.error(`ludics: terminating stale orchestration runner (pid ${pid}) before resume`);
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* dead */ }
      }
    }

    // Recreate missing tmux sessions, ttyd, and agent CLIs for each agent
    const newTtydPids: Record<string, number> = { ...(tmuxState?.ttydPids ?? {}) };
    const taskId = orchState.taskId;

    // Local helper: export env vars and launch agent CLI in an existing tmux session
    const bootCliInSession = (session: string, agent: { name: string; provider: string }) => {
      const envCmd = [
        `export LUDICS_SLOT=${slotNum}`,
        `LUDICS_AGENT=${agent.name}`,
        `LUDICS_PEER_SYNC_DIR="${orchState.peerSyncDir}"`,
      ].join(" ");
      tmuxSendCommand(session, envCmd);
      tmuxSendCommand(session, agentCliCommand(agent.provider));
    };

    for (let i = 0; i < orchState.agents.length; i++) {
      const agent = orchState.agents[i];
      const sessionName = tmuxSessionName(slotNum, agent.name, taskId);
      const role: "coder" | "reviewer" =
        agent.role === "coder" || agent.role === "reviewer"
          ? agent.role
          : i % 2 === 0 ? "coder" : "reviewer";
      const port = ttydPort(slotNum, role);

      // Check if the tmux session exists
      const sessionExists = tmuxHasSession(sessionName);

      if (!sessionExists) {
        // Recreate the tmux session in the agent's worktree
        const cwd = agent.worktreePath;
        tmuxNewSession(sessionName, cwd);
        Bun.spawnSync(["tmux", "set-option", "-t", sessionName, "mouse", "off"], {
          stdout: "pipe", stderr: "pipe",
        });
        console.error(`ludics: re-created tmux session '${sessionName}'`);

        bootCliInSession(sessionName, agent);
        console.error(`ludics: booted ${agent.provider} CLI in '${sessionName}'`);
      } else {
        // Session exists — reset shell state in case it's stuck (e.g. bquote> mode)
        tmuxSendKeys(sessionName, "C-c");
        tmuxSendKeys(sessionName, "C-c");
        tmuxSendKeys(sessionName, "Enter");
        await Bun.sleep(200);

        // Re-boot agent CLI if it died while the tmux session persisted
        if (!isAgentAlive(slotNum, agent.name, taskId)) {
          bootCliInSession(sessionName, agent);
          console.error(`ludics: re-booted ${agent.provider} CLI in existing session '${sessionName}'`);
        } else {
          console.error(`ludics: session '${sessionName}' exists, agent CLI alive — reset shell state only`);
        }
      }

      // Re-create ttyd if the port is not in use
      if (shouldStartTtyd) {
        const portInUse = Bun.spawnSync(["lsof", "-i", `:${port}`], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
        if (!portInUse) {
          newTtydPids[agent.name] = startTtyd(slotNum, agent.name, role, taskId);
          console.error(`ludics: re-started ttyd on port ${port} for ${agent.name}`);
        }
      }
    }

    // Update tmux slot state with new ttyd PIDs (will be overwritten with runner PID below)
    if (tmuxState) {
      writeTmuxSlotState({ ...tmuxState, ttydPids: newTtydPids }, ctx.harnessDir);
    }
  }

  // --- t3code-specific: terminate stale runner from t3code slot state ---
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir)!;
    if (slotState.orchestration?.pid) {
      const pid = slotState.orchestration.pid;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {
        // PID already dead — expected for crash recovery
      }
      if (alive) {
        console.error(`ludics: terminating stale orchestration runner (pid ${pid}) before resume`);
        try { process.kill(pid, "SIGTERM"); } catch {
          // ignore if kill fails
        }
        // Brief wait for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Force kill if still alive
        try {
          process.kill(pid, 0); // check if still alive
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead — good
        }
      }
    }
  }

  // Reset turnLifecycle for all agents — stale lifecycle data from before the crash
  // would block phase transitions (isAgentDone returns false for state "running"/"dispatched").
  // With lifecycle null, the orchestrator trusts peer-sync status files as ground truth.
  for (const agentName of Object.keys(orchState.agentStates)) {
    orchState.agentStates[agentName]!.turnLifecycle = null;
  }
  orchState.phaseDispatched = false;
  persistState(orchState, ctx.harnessDir);

  // Restart orchestration runner (reuses existing state)
  const newPid = await startOrchestrationProcess(slotNum, ctx.harnessDir, orchState.taskId);

  // Update PID in slot state (only after successful spawn)
  if (ctx.mode === "t3code") {
    const slotState = readSlotState(slotNum, ctx.harnessDir)!;
    if (!slotState.orchestration) {
      throw new Error(`slot ${slotNum}: persisted t3code state has no orchestration record — use 'slot start' for fresh start`);
    }
    writeSlotState({
      ...slotState,
      orchestration: {
        ...slotState.orchestration,
        pid: newPid,
      },
    }, ctx.harnessDir);
  } else if (ctx.mode === "tmux") {
    const { readTmuxSlotState, writeTmuxSlotState } = await import("../adapters/tmux-adapter.ts");
    const tmuxState = readTmuxSlotState(slotNum, ctx.harnessDir);
    if (tmuxState) {
      writeTmuxSlotState({
        ...tmuxState,
        orchestration: {
          ...tmuxState.orchestration!,
          pid: newPid,
        },
      }, ctx.harnessDir);
    }
  }

  // Clear interrupted liveness and stamp session-active marker
  const sessionStartedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
  let updated = setField(block, "Session Started", sessionStartedAt);
  updated = setField(updated, "Liveness", "null");
  if (updated !== block) {
    blocks.set(slotNum, updated);
    writeSlotFile(file, blocks, count);
  }

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
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  let anyUpdated = false;

  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    if (!block) continue;

    const mode = getMode(block).trim();
    if (!mode || mode === "null") continue;

    const ctx = makeAdapterContext(i, block);
    const output = await readAdapterState(ctx);
    if (output) {
      blocks.set(i, mergeAdapterState(block, output));
      anyUpdated = true;
      console.error(`ludics: refreshed slot ${i} (${mode})`);
    }

    // Update task modified timestamp from adapter activity
    const taskId = getTask(block).trim();
    if (taskId && taskId !== "null") {
      const activity = await readAdapterLastActivity(ctx);
      if (activity) {
        const tf = taskFilePath(taskId);
        addFrontmatterField(tf, "modified", activity);
      }
    }
  }

  if (anyUpdated) {
    writeSlotFile(file, blocks, count);
    stateCommit("slots refresh");
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
      let hasDirectOrchFlags = false;    // true only if a direct shorthand flag was used (not -A)
      let firstDirectOrchFlagIdx = -1;   // fragment index of the first direct --coder/--reviewer/--plan
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
            adapterArgFragments.push(raw);   // raw payload — does NOT set hasDirectOrchFlags
            break;
          }
          case "--pair":
            hasDirectOrchFlags = true;
            // --pair itself is the mode flag; no need to record it as an auto-prepend target
            adapterArgFragments.push("--pair");
            break;
          case "--duo":
            hasDirectOrchFlags = true;
            // Hierarchical duo: handled after arg parsing by isDuoAssign check
            adapterArgFragments.push("--duo");
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

      // Guard: shorthand orchestration flags require an orchestrated adapter.
      // Raw -A/--adapter-args payloads are not subject to this check.
      if (hasDirectOrchFlags && adapter !== "t3code" && adapter !== "tmux") {
        throw new Error(
          `--pair/--coder/--reviewer/--plan flags require adapter "t3code" or "tmux" (got "${adapter}")`
        );
      }

      // Guard: orchestrated adapter must match globalAdapter() to prevent split-brain.
      // The runner selects its transport from the persisted backend field, which is set
      // from the adapter used at slot creation. A mismatch would start a t3code adapter
      // session but spawn a runner that then uses TmuxTransport (or vice versa).
      if (hasDirectOrchFlags || adapterArgFragments.some(f => /--(?:pair|duo)/.test(f))) {
        const expected = globalAdapter();
        if ((adapter === "t3code" || adapter === "tmux") && adapter !== expected) {
          throw new Error(
            `slot ${slotNum}: adapter "${adapter}" does not match global config adapter "${expected}".\n` +
            `  Either change config.yaml to 'adapter: ${adapter}' or use '-a ${expected}'.`
          );
        }
      }

      // Check for --duo flag (direct or in -A raw fragments) — triggers two-slot expansion.
      const hasDuoDirectFlag = adapterArgFragments.includes("--duo");
      const hasDuoInRawFragments = adapterArgFragments.some(
        f => /(?:^|\s)--duo(?:\s|$)/.test(f) && !/--duo-peer-slot/.test(f)
      );
      const isDuoAssign = hasDuoDirectFlag || hasDuoInRawFragments;

      if (isDuoAssign) {
        // Hierarchical duo: assign TWO pair-mode slots with swapped coder/reviewer.
        // Find a second empty slot.
        const allBlocks = loadBlocks(ensureSlotsFile());
        const totalSlots = slotsCount();
        let secondSlot: number | null = null;
        for (let s = 1; s <= totalSlots; s++) {
          if (s === slotNum) continue;
          const blk = allBlocks.get(s);
          const proc = blk ? getProcess(blk).trim() : "(empty)";
          if (!proc || proc === "(empty)") { secondSlot = s; break; }
        }
        if (secondSlot === null) {
          throw new Error(`duo mode requires two empty slots; only slot ${slotNum} is available`);
        }
        // Strip --duo from fragments before expansion
        const cleanedFragments = adapterArgFragments
          .map(f => f.replace(/(?:^|\s)--duo(?:\s|$)/g, " ").trim())
          .filter(Boolean);
        const baseArgs = cleanedFragments.join(" ");
        const expansion = expandDuoSlots(slotNum, secondSlot, baseArgs);
        slotAssign(slotNum, taskOrDesc, adapter, session, path, expansion.slotA.args, machine);
        slotAssign(secondSlot, taskOrDesc, adapter, "", path, expansion.slotB.args, machine);
        console.error(`ludics: duo assign → slots ${slotNum}+${secondSlot}`);
      } else {
        // Auto-prepend --pair when any direct orchestration shorthand is present without an
        // explicit mode flag. Splice at the position of the first such shorthand to preserve
        // fragment ordering (raw -A fragments that precede it are left undisturbed).
        const hasModeDirectFlag = adapterArgFragments.includes("--pair");
        const hasModeInRawFragments = adapterArgFragments.some(
          f => /(?:^|\s)--(?:pair|duo)(?:\s|$)/.test(f)
        );
        if (hasDirectOrchFlags && !hasModeDirectFlag && !hasModeInRawFragments && firstDirectOrchFlagIdx !== -1) {
          adapterArgFragments.splice(firstDirectOrchFlagIdx, 0, "--pair");
        }

        const adapterArgs = adapterArgFragments.join(" ");
        slotAssign(slotNum, taskOrDesc, adapter, session, path, adapterArgs, machine);
      }
      break;
    }

    case "clear": {
      const finalStatus = args[2] ?? "ready";
      const VALID_CLEAR_STATUSES = ["ready", "in-progress", "done", "abandoned"];
      if (!VALID_CLEAR_STATUSES.includes(finalStatus)) {
        throw new Error(`invalid clear status: ${finalStatus} (use: ${VALID_CLEAR_STATUSES.join(", ")})`);
      }
      slotClear(slotNum, finalStatus);
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
      slotPreempt(slotNum, preemptTask, adapter, session, path, adapterArgs);
      break;
    }

    case "restore":
      slotRestore(slotNum);
      break;

    default:
      throw new Error(`unknown slot subcommand: ${sub}`);
  }
}
