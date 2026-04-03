// State repository git operations (git via Bun.$)

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, relative } from "path";
import { harnessDir, slotsCount, stateRepoDir } from "./config.ts";
import { parseSlotBlocks, getField, getMachine, setField, emptyBlock } from "./slots/markdown.ts";

function run(cmd: string[], cwd: string): { success: boolean; stdout: string } {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    success: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
  };
}

function dirtyFlagPath(): string {
  // Place outside git tree, scoped to this state repo to avoid cross-workspace interference.
  const repoDir = stateRepoDir();
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(repoDir);
  const suffix = hasher.digest("hex").slice(0, 8);
  return join(process.env.HOME ?? "/tmp", `.ludics-state-dirty-${suffix}`);
}

/** Mark state as dirty (has uncommitted file writes). Cheap no-op if already dirty. */
export function stateMarkDirty(): void {
  const flag = dirtyFlagPath();
  if (!existsSync(flag)) {
    writeFileSync(flag, String(Math.floor(Date.now() / 1000)));
  }
}

export function stateIsDirty(): boolean {
  return existsSync(dirtyFlagPath());
}

function clearDirtyFlag(): void {
  const flag = dirtyFlagPath();
  if (existsSync(flag)) {
    try { unlinkSync(flag); } catch { /* ignore */ }
  }
}

/**
 * Commit accumulated changes immediately (git add + commit, no push).
 * Used by CLI slot/task mutations to ensure state is persisted before
 * the command returns. Push happens at the next checkpoint.
 */
export function stateCommit(message: string): void {
  const repoDir = stateRepoDir();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  const { success: hasCached } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  if (!hasDiff && !hasCached) return;

  run(["git", "add", "-A"], repoDir);
  const result = run(["git", "commit", "-m", message], repoDir);
  if (result.success) {
    console.error(`ludics: committed: ${message}`);
  }
  clearDirtyFlag();
}

/** Immediately commit and push. For critical moments like controller handoff. */
export function stateCommitImmediate(message: string): void {
  const repoDir = stateRepoDir();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  const { success: hasCached } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  if (!hasDiff && !hasCached) {
    clearDirtyFlag();
    return;
  }

  run(["git", "add", "-A"], repoDir);
  const result = run(["git", "commit", "-m", message], repoDir);
  if (result.success) {
    console.error(`ludics: committed: ${message}`);
  }
  clearDirtyFlag();
}

/**
 * Batch checkpoint: commit accumulated changes and optionally push.
 * No-op if nothing is dirty and no git diff exists.
 */
export function stateCheckpoint(
  message: string,
  opts: { push?: boolean } = {},
): void {
  const repoDir = stateRepoDir();
  const push = opts.push ?? true;

  // Check both dirty flag and actual git diff
  const hasDirtyFlag = stateIsDirty();
  const { success: hasDiff } = (() => {
    const r = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    return { success: r.exitCode !== 0 };
  })();

  if (!hasDirtyFlag && !hasDiff) return;

  run(["git", "add", "-A"], repoDir);
  const result = run(["git", "commit", "-m", `checkpoint: ${message}`], repoDir);
  if (result.success) {
    console.error(`ludics: checkpoint committed: ${message}`);
  }
  clearDirtyFlag();

  if (push) {
    statePush();
  }
}

export function statePull(): boolean {
  const repoDir = stateRepoDir();

  // Check for uncommitted changes
  const diffResult = Bun.spawnSync(["git", "diff", "--quiet", "HEAD"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  const hasChanges = diffResult.exitCode !== 0;

  if (hasChanges) {
    run(["git", "stash", "push", "-m", "ludics auto-stash before pull"], repoDir);
  }

  const pullResult = run(["git", "pull", "--rebase"], repoDir);
  if (pullResult.success) {
    console.error("ludics: pulled latest from remote");
  } else {
    console.error("ludics: pull failed (may need manual intervention)");
    if (hasChanges) {
      run(["git", "stash", "pop"], repoDir);
    }
    return false;
  }

  if (hasChanges) {
    const popResult = run(["git", "stash", "pop"], repoDir);
    if (popResult.success) {
      console.error("ludics: restored local changes");
    } else {
      console.error("ludics: conflict restoring local changes (check git stash)");
    }
  }

  return true;
}

export function statePush(): void {
  const repoDir = stateRepoDir();

  // Resolve federation identity lazily to avoid state.ts → federation.ts import cycle
  let currentMachine = "";
  let isCurrentMachineController = true; // standalone default
  let controllerMachine = ""; // the controller's machine name
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { federationCurrentMachineName, federationIsController, federationCurrentController } = require("./federation.ts");
    currentMachine = federationCurrentMachineName() ?? "";
    isCurrentMachineController = federationIsController();
    controllerMachine = federationCurrentController() ?? currentMachine;
  } catch { /* standalone mode — no federation */ }

  if (!pullRebasePush(repoDir, currentMachine, isCurrentMachineController, controllerMachine)) {
    // Retry once: another machine may have pushed between our pull and push
    console.error("ludics: push rejected or conflict, retrying...");
    if (!pullRebasePush(repoDir, currentMachine, isCurrentMachineController, controllerMachine)) {
      console.error("ludics: push failed after retry (will retry next checkpoint)");
    }
  }
}

/** Pull with rebase, resolve conflicts, push. Returns true on success. */
function pullRebasePush(
  repoDir: string,
  currentMachine: string,
  isController: boolean,
  controllerMachine: string,
): boolean {
  const pullResult = run(["git", "pull", "--rebase"], repoDir);
  if (!pullResult.success) {
    // Check if we're in a conflicted rebase
    const hasConflict = run(["git", "diff", "--name-only", "--diff-filter=U"], repoDir).stdout;
    if (hasConflict) {
      // Resolve conflicts in a loop — rebase may replay multiple commits
      const MAX_CONFLICT_STEPS = 5;
      let resolved = false;
      for (let step = 0; step < MAX_CONFLICT_STEPS; step++) {
        const stepOk = resolveRebaseConflicts(repoDir, currentMachine, isController, controllerMachine);
        if (stepOk) { resolved = true; break; }

        // Check if rebase --continue hit another conflict
        const moreConflicts = run(["git", "diff", "--name-only", "--diff-filter=U"], repoDir).stdout;
        if (!moreConflicts) { resolved = true; break; }
      }
      if (!resolved) {
        run(["git", "rebase", "--abort"], repoDir);
        console.error("ludics: push aborted — too many rebase conflicts");
        return false;
      }
    } else {
      // Pull failed for non-conflict reason (no remote, network)
      console.error("ludics: pull failed before push, pushing anyway");
    }
  }

  const pushResult = run(["git", "push"], repoDir);
  if (pushResult.success) {
    console.error("ludics: pushed to remote");
    return true;
  }
  return false;
}

// --- Merge conflict resolution ---

function harnessPrefix(): string {
  const rel = relative(stateRepoDir(), harnessDir());
  return rel ? rel + "/" : "";
}

function resolveRebaseConflicts(
  repoDir: string,
  currentMachine: string,
  isController: boolean,
  controllerMachine: string,
): boolean {
  const { stdout } = run(["git", "diff", "--name-only", "--diff-filter=U"], repoDir);
  if (!stdout) return true;

  const prefix = harnessPrefix();

  for (const file of stdout.split("\n").filter(Boolean)) {
    if (file === `${prefix}journal/events.jsonl`) {
      resolveAppendOnly(repoDir, file);
    } else if (file.startsWith(`${prefix}federation/heartbeats/`)) {
      // Each machine owns its own heartbeat file — accept local (theirs in rebase)
      run(["git", "checkout", "--theirs", file], repoDir);
    } else if (file.startsWith(`${prefix}orchestration/`)) {
      resolveByRecency(repoDir, file);
    } else if (file === `${prefix}slots.md`) {
      resolveSlotsMd(repoDir, file, currentMachine, isController, controllerMachine);
    } else {
      // In rebase, --theirs = our local commit being replayed
      run(["git", "checkout", "--theirs", file], repoDir);
      console.error(`ludics: merge conflict on ${file} — accepted local version`);
    }
    run(["git", "add", file], repoDir);
  }

  const env = { ...process.env, GIT_EDITOR: "true" };
  const result = Bun.spawnSync(["git", "rebase", "--continue"], {
    cwd: repoDir, env, stdout: "pipe", stderr: "pipe",
  });
  return result.exitCode === 0;
}

/** Append-only file merge: concatenate upstream + local-only lines, deduplicate. */
function resolveAppendOnly(repoDir: string, file: string): void {
  const upstreamRaw = run(["git", "show", `:2:${file}`], repoDir).stdout;
  const localRaw = run(["git", "show", `:3:${file}`], repoDir).stdout;

  const upstreamLines = upstreamRaw.split("\n").filter(Boolean);
  const localLines = localRaw.split("\n").filter(Boolean);

  const upstreamSet = new Set(upstreamLines);
  const localOnly = localLines.filter(l => !upstreamSet.has(l));

  const merged = [...upstreamLines, ...localOnly].join("\n") + "\n";
  writeFileSync(join(repoDir, file), merged);
}

/** JSON file merge: keep the version with a more recent phaseStartedAt epoch. */
function resolveByRecency(repoDir: string, file: string): void {
  try {
    const upstreamRaw = run(["git", "show", `:2:${file}`], repoDir).stdout;
    const localRaw = run(["git", "show", `:3:${file}`], repoDir).stdout;

    const upstream = JSON.parse(upstreamRaw) as Record<string, unknown>;
    const local = JSON.parse(localRaw) as Record<string, unknown>;

    const upstreamEpoch = Number(upstream.phaseStartedAt ?? 0);
    const localEpoch = Number(local.phaseStartedAt ?? 0);

    // In rebase: --ours = upstream (:2:), --theirs = local (:3:)
    if (upstreamEpoch > localEpoch) {
      run(["git", "checkout", "--ours", file], repoDir); // keep upstream
    } else {
      run(["git", "checkout", "--theirs", file], repoDir); // keep local
    }
  } catch {
    // Parse failed — accept our local commit (theirs in rebase)
    run(["git", "checkout", "--theirs", file], repoDir);
  }
}

/**
 * Slot-block-level merge for slots.md.
 *
 * Git rebase sides during `git pull --rebase`:
 * - :2: ("ours") = upstream version (remote/fetched commits we're rebasing onto)
 * - :3: ("theirs") = local commit being replayed
 *
 * Role mapping:
 * - Controller rebases: :3: = controller, :2: = worker
 * - Worker rebases: :2: = controller, :3: = worker
 *
 * Three merge cases per slot:
 * 1. Controller-owned local slot → controller full block wins
 * 2. Remote worker-owned slot, same task → controller identity + worker runtime
 * 3. Cleared/reassigned/task-mismatch → controller full block wins
 */
function resolveSlotsMd(
  repoDir: string,
  file: string,
  currentMachine: string,
  isController: boolean,
  controllerMachine: string,
): void {
  const upstreamRaw = run(["git", "show", `:2:${file}`], repoDir).stdout;
  const localRaw = run(["git", "show", `:3:${file}`], repoDir).stdout;

  const upstreamBlocks = parseSlotBlocks(upstreamRaw);
  const localBlocks = parseSlotBlocks(localRaw);
  const count = slotsCount();

  // Map git sides to roles based on who is rebasing
  const controllerBlocks = isController ? localBlocks : upstreamBlocks;
  const workerBlocks = isController ? upstreamBlocks : localBlocks;

  const merged = new Map<number, string>();

  for (let i = 1; i <= count; i++) {
    const ctrlBlock = controllerBlocks.get(i);
    const wrkBlock = workerBlocks.get(i);

    if (!ctrlBlock && !wrkBlock) continue;
    if (!ctrlBlock) { merged.set(i, wrkBlock!); continue; }
    if (!wrkBlock) { merged.set(i, ctrlBlock); continue; }

    const ctrlProcess = getField(ctrlBlock, "Process").trim();
    const wrkProcess = getField(wrkBlock, "Process").trim();
    const ctrlEmpty = !ctrlProcess || ctrlProcess === "(empty)";
    const wrkEmpty = !wrkProcess || wrkProcess === "(empty)";

    const ctrlTask = getField(ctrlBlock, "Task").trim();
    const wrkTask = getField(wrkBlock, "Task").trim();

    // CASE 3: cleared, reassigned, or task mismatch → controller wins
    if (ctrlEmpty || wrkEmpty || ctrlTask !== wrkTask) {
      merged.set(i, ctrlBlock);
      continue;
    }

    // CASE 1: controller-owned slot (no Machine field, or Machine matches controller)
    // Controller owns both identity and runtime — its full block wins regardless
    // of which machine is rebasing. selectMachineForSlot() writes the controller's
    // own machine name for local slots, so we must match against it.
    const slotMachine = getMachine(ctrlBlock).trim() || getMachine(wrkBlock).trim();
    const slotIsControllerOwned = !slotMachine || slotMachine === "null"
      || slotMachine === controllerMachine;

    if (slotIsControllerOwned) {
      merged.set(i, ctrlBlock);
      continue;
    }

    // CASE 2: remote worker-owned slot, same task
    // Controller provides identity fields; worker provides runtime sections
    merged.set(i, mergeSlotBlock(ctrlBlock, wrkBlock));
  }

  // Write merged file
  const parts: string[] = ["# Slots\n\n"];
  for (let i = 1; i <= count; i++) {
    const block = merged.get(i) ?? emptyBlock(i);
    parts.push(block);
    if (i < count) parts.push("\n---\n\n");
  }
  writeFileSync(join(repoDir, file), parts.join(""));
}

/**
 * Merge a controller-side block with a worker-side block for the same slot/task.
 * Controller owns identity fields; worker owns Session Started + sections.
 */
function mergeSlotBlock(controllerBlock: string, workerBlock: string): string {
  // Start from controller block (has authoritative identity fields)
  let result = controllerBlock;

  // Override Session Started from worker
  const workerSessionStarted = getField(workerBlock, "Session Started");
  if (workerSessionStarted) {
    result = setField(result, "Session Started", workerSessionStarted);
  }

  // Extract Terminals/Runtime/Git sections from worker block
  const sections = extractSections(workerBlock);

  // Replace those sections in the controller block
  result = replaceSections(result, sections);

  return result;
}

interface SlotSections {
  terminals: string;
  runtime: string;
  git: string;
}

/** Extract content of Terminals/Runtime/Git sections from a slot block. */
function extractSections(block: string): SlotSections {
  let terminals = "";
  let runtime = "";
  let git = "";
  let currentSection = "";

  for (const line of block.split("\n")) {
    if (line === "**Terminals:**") { currentSection = "terminals"; continue; }
    if (line === "**Runtime:**") { currentSection = "runtime"; continue; }
    if (line === "**Git:**") { currentSection = "git"; continue; }
    if (/^\*\*[^*]+:\*\*/.test(line)) { currentSection = ""; continue; }

    switch (currentSection) {
      case "terminals": terminals += line + "\n"; break;
      case "runtime": runtime += line + "\n"; break;
      case "git": git += line + "\n"; break;
    }
  }

  return { terminals: terminals.trimEnd(), runtime: runtime.trimEnd(), git: git.trimEnd() };
}

/** Replace Terminals/Runtime/Git sections in a block with provided content. */
function replaceSections(block: string, sections: SlotSections): string {
  const output: string[] = [];
  let skipUntilNext = false;

  for (const line of block.split("\n")) {
    if (line === "**Terminals:**") {
      output.push("**Terminals:**");
      if (sections.terminals) output.push(sections.terminals);
      skipUntilNext = true;
      continue;
    }
    if (line === "**Runtime:**") {
      output.push("**Runtime:**");
      if (sections.runtime) output.push(sections.runtime);
      skipUntilNext = true;
      continue;
    }
    if (line === "**Git:**") {
      output.push("**Git:**");
      if (sections.git) output.push(sections.git);
      skipUntilNext = true;
      continue;
    }
    if (/^\*\*/.test(line)) {
      skipUntilNext = false;
    }
    if (!skipUntilNext) {
      output.push(line);
    }
  }

  return output.join("\n");
}

export function stateSync(message: string): void {
  stateCommitImmediate(message);
  statePush();
}

export function stateFullSync(): void {
  statePull();
  stateCommitImmediate("sync");
  statePush();
}
