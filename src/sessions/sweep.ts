// Sessions sweeper — cleanup detached known adapter sessions.
//
// Safety model:
// - Only sessions registered by adapter logic are tracked ("known").
// - Unknown sessions are never harvested.
// - Cleanup runs after 3 consecutive detached sweeps.

import { slotsCount } from "../config.ts";
import { safeSyncOutput } from "../spawn.ts";
import { readAllSlotJson } from "../slots/json.ts";
import { readSlotState, serverStatus } from "../t3code/server.ts";
import type { T3Snapshot } from "../t3code/types.ts";
import { isoNow } from "../orchestration/util.ts";
import {
  type KnownSessionRecord,
  type SweepMode,
  SWEEP_TARGET_MODES,
  buildKnownSessionKey,
  loadSessionSweepState,
  normalizeProjectDirForSweep,
  saveSessionSweepState,
} from "./sweep-state.ts";

interface SweepOptions {
  dryRun: boolean;
}

function collectAttachedKeys(): Set<string> {
  const slots = readAllSlotJson(slotsCount());
  const attached = new Set<string>();

  for (const [slot, data] of slots) {
    const modeRaw = (data.mode ?? "").trim();
    if (!SWEEP_TARGET_MODES.has(modeRaw as SweepMode)) continue;
    const mode = modeRaw as SweepMode;
    const slotPath = (data.path ?? "").trim();

    // t3code is the only swept mode: use slot state files for thread tracking.
    const slotState = readSlotState(slot);
    if (slotState) {
      for (const thread of slotState.threads) {
        const projectDir = normalizeProjectDirForSweep(thread.worktreePath ?? slotPath);
        attached.add(buildKnownSessionKey(mode, projectDir, thread.threadId));
      }
    }
  }

  return attached;
}

// Lazily cached t3code snapshot for sweep presence checks
let cachedT3codeSnapshot: T3Snapshot | null | undefined;
async function getT3codeSnapshotForSweep(): Promise<T3Snapshot | null> {
  if (cachedT3codeSnapshot !== undefined) return cachedT3codeSnapshot;
  try {
    const status = await serverStatus();
    cachedT3codeSnapshot = status.running ? (status.snapshot ?? null) : null;
  } catch {
    cachedT3codeSnapshot = null;
  }
  return cachedT3codeSnapshot;
}

function knownSessionStillPresent(record: KnownSessionRecord, t3codeSnapshot: T3Snapshot | null): boolean {
  // t3code is the only swept mode: check if the thread still exists in the snapshot.
  if (!t3codeSnapshot) return false;
  return t3codeSnapshot.threads.some((t) => t.id === record.name && !t.deletedAt);
}

function runCleanup(record: KnownSessionRecord): { ok: boolean; detail: string } {
  const result = safeSyncOutput(record.cleanupCommand, { cwd: record.projectDir });
  if (result.ok) {
    return { ok: true, detail: result.stdout || "ok" };
  }
  return { ok: false, detail: result.stderr || result.stdout || `exit ${result.exitCode}` };
}

export async function runSessionSweep(options: SweepOptions): Promise<void> {
  // Reset cached snapshot for each sweep run
  cachedT3codeSnapshot = undefined;

  const now = isoNow();
  const state = loadSessionSweepState();
  const attachedKeys = collectAttachedKeys();

  // Pre-fetch t3code snapshot for presence checks
  const t3codeSnapshot = await getT3codeSnapshotForSweep();

  let reattachedResets = 0;
  let detachedUpdated = 0;
  let retiredMissing = 0;
  let cleanupAttempts = 0;
  let cleanupSuccess = 0;
  let cleanupFailed = 0;

  // Safety invariant: only sessions registered by adapter logic appear in
  // state.sessions. Manually-created t3code threads are never registered
  // and thus never eligible for sweep cleanup. See also: knownSessionStillPresent()
  // which verifies the registered session's specific threadId still exists.
  const detachedToCleanup: KnownSessionRecord[] = [];
  for (const [key, record] of Object.entries(state.sessions)) {
    if (attachedKeys.has(key)) {
      if (record.detachedStreak > 0) reattachedResets++;
      record.detachedStreak = 0;
      record.lastSeenAt = now;
      continue;
    }

    if (!knownSessionStillPresent(record, t3codeSnapshot)) {
      delete state.sessions[key];
      retiredMissing++;
      continue;
    }

    record.detachedStreak += 1;
    record.lastSeenAt = now;
    detachedUpdated++;
    if (record.detachedStreak >= 3) detachedToCleanup.push(record);
  }

  for (const record of detachedToCleanup) {
    cleanupAttempts++;
    if (options.dryRun) {
      console.log(
        `DRY RUN cleanup (${record.detachedStreak} detached sweeps): ${record.cleanupCommand.join(" ")} (cwd=${record.projectDir})`,
      );
      continue;
    }

    const result = runCleanup(record);
    if (result.ok) {
      cleanupSuccess++;
      console.log(`Cleaned detached session: ${record.key}`);
      delete state.sessions[record.key];
    } else {
      cleanupFailed++;
      console.error(`Cleanup failed for ${record.key}: ${result.detail}`);
    }
  }

  if (!options.dryRun) {
    state.lastSweepAt = now;
    saveSessionSweepState(state);
  }

  const tracked = Object.keys(state.sessions).length;
  console.log(
    `sessions sweep: tracked=${tracked}, attached=${attachedKeys.size}, reattached_resets=${reattachedResets}, detached_updated=${detachedUpdated}, retired_missing=${retiredMissing}, cleanup_attempts=${cleanupAttempts}, cleanup_success=${cleanupSuccess}, cleanup_failed=${cleanupFailed}, dry_run=${options.dryRun}`,
  );
}
