// Slot operations — list, show, assign, clear, note, start, stop, refresh

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { harnessDir, slotsFilePath, slotsCount, stateRepoDir, resolveProjectPath } from "../config.ts";
import { parseSlotBlocks, getField, getTask, getMode, getSession, getProcess, getPath, getStarted, getAdapterArgs,
         emptyBlock, writeSlotFile, addNoteToBlock, mergeAdapterState } from "./markdown.ts";
import { stateCommit } from "../state.ts";
import { journalAppend } from "../journal.ts";
import { emitEvent } from "../events.ts";
import { runAdapterAction, readAdapterState, readAdapterLastActivity } from "../adapters/index.ts";
import type { AdapterContext } from "../adapters/index.ts";
import { maybeNotifySessionConclusionForAdapter } from "../notify.ts";
import { addFrontmatterField, updateDependencyArray, parseTaskFrontmatter } from "../tasks/markdown.ts";
import { hasStash, readStash, writeStash, removeStash } from "./preempt.ts";
import type { PreemptStash } from "./preempt.ts";
import { readSlotState } from "../t3code/server.ts";

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
    console.log(`Slot ${i}: ${process}`);
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

**Terminals:**

**Runtime:**
- Assigned via ludics

**Git:**
`;

  blocks.set(slotNum, block);
  writeSlotFile(file, blocks, count);

  // Update task file
  if (taskId !== "null") {
    taskUpdateForSlotAssign(taskId, slotNum, adapter, started);
  }

  journalAppend("slot", `Slot ${slotNum} assigned: ${processDesc} (task=${taskId}, adapter=${adapter})`);
  emitEvent({ event_type: "slot_assign", source: "cli", scope: "slot", slot: slotNum, task: taskId !== "null" ? taskId : undefined, adapter, message: processDesc });
  stateCommit(`slot ${slotNum}: assign ${taskOrDesc}`);
}

export function slotClear(slotNum: number, finalStatus: string = "ready"): void {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

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

function makeAdapterContext(slotNum: number, block: string): AdapterContext {
  const mode = getMode(block).trim();
  const session = getSession(block).trim();
  const path = getPath(block).trim();
  const started = getStarted(block).trim();
  const taskIdRaw = getTask(block).trim();
  const adapterArgs = getAdapterArgs(block).trim();
  const process = getProcess(block).trim();

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
    harnessDir: harnessDir(),
    stateRepoDir: stateRepoDir(),
  };
}

export async function slotStart(slotNum: number): Promise<void> {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, block);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode`);

  await runAdapterAction("start", ctx);
  journalAppend("slot", `Slot ${slotNum} started (adapter=${ctx.mode})`);
  emitEvent({ event_type: "slot_start", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode });
}

export async function slotStop(slotNum: number): Promise<void> {
  const file = ensureSlotsFile();
  const blocks = loadBlocks(file);
  const count = slotsCount();
  validateRange(slotNum, count);

  const block = blocks.get(slotNum);
  if (!block) throw new Error(`slot ${slotNum} not found`);

  const ctx = makeAdapterContext(slotNum, block);
  if (!ctx.mode) throw new Error(`slot ${slotNum} has no Mode`);

  await runAdapterAction("stop", ctx);
  journalAppend("slot", `Slot ${slotNum} stopped (adapter=${ctx.mode})`);
  emitEvent({ event_type: "slot_stop", source: "cli", scope: "slot", slot: slotNum, adapter: ctx.mode });
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

    try {
      maybeNotifySessionConclusionForAdapter(ctx);
    } catch (err) {
      console.error(`ludics: session conclusion notify scan failed for slot ${i}: ${err instanceof Error ? err.message : String(err)}`);
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
      slotAssign(slotNum, taskOrDesc, adapter, session, path, adapterArgs);
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

    case "stop":
      await slotStop(slotNum);
      break;

    case "note": {
      const noteText = args[2];
      if (!noteText) throw new Error("note text required");
      slotNote(slotNum, noteText);
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
