// Sessions sweeper — cleanup detached known adapter sessions.
//
// Safety model:
// - Only sessions registered by adapter logic are tracked ("known").
// - Unknown sessions are never harvested.
// - Cleanup runs after 3 consecutive detached sweeps.

import { existsSync, readdirSync } from "fs";
import { basename, join } from "path";
import { slotsCount } from "../config.ts";
import { safeSyncOutput } from "../spawn.ts";
import { readAllSlotJson } from "../slots/json.ts";
import { resolveProjectDir } from "../adapters/base.ts";
import { findSessionByPrefixOrTask } from "../adapters/peer-sync.ts";
import { readSlotState, serverStatus } from "../t3code/server.ts";
import type { T3Snapshot } from "../t3code/types.ts";
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

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveProjectDirForSlot(mode: SweepMode, slotPath: string, slotSession: string): string {
  const candidates: string[] = [];
  if (slotPath && slotPath !== "null") candidates.push(normalizeProjectDirForSweep(slotPath));

  const resolved = resolveProjectDir(slotSession, false);
  if (resolved) candidates.push(normalizeProjectDirForSweep(resolved));

  const unique = Array.from(new Set(candidates.filter(Boolean)));
  for (const candidate of unique) {
    if (existsSync(join(candidate, ".agent-sessions"))) return candidate;
  }
  for (const candidate of unique) {
    if (existsSync(candidate)) return candidate;
  }
  return unique[0] ?? process.cwd();
}

function providerCleanupName(taskId: string, session: string): string | null {
  if (taskId && taskId !== "null") return taskId;
  if (session && session !== "null" && !/^\d+$/.test(session)) return session;
  return null;
}

function collectAttachedKeys(): Set<string> {
  const slots = readAllSlotJson(slotsCount());
  const attached = new Set<string>();

  for (const [slot, data] of slots) {
    const modeRaw = (data.mode ?? "").trim();
    if (!SWEEP_TARGET_MODES.has(modeRaw as SweepMode)) continue;
    const mode = modeRaw as SweepMode;
    const taskId = (data.task ?? "").trim();
    const slotSession = (data.session ?? "").trim();
    const slotPath = (data.path ?? "").trim();

    // t3code mode: use slot state files for thread tracking
    if (mode === "t3code") {
      const slotState = readSlotState(slot);
      if (slotState) {
        for (const thread of slotState.threads) {
          const projectDir = normalizeProjectDirForSweep(thread.worktreePath ?? slotPath);
          attached.add(buildKnownSessionKey(mode, projectDir, thread.threadId));
        }
      }
      continue;
    }

    const projectDir = resolveProjectDirForSlot(mode, slotPath, slotSession);

    const name = providerCleanupName(taskId, slotSession);
    if (!name) continue;
    attached.add(buildKnownSessionKey(mode, projectDir, name));
  }

  return attached;
}

function agentPrefixes(mode: SweepMode): string[] {
  if (mode === "agent-claude") return ["claude-", "agent-claude-"];
  if (mode === "agent-codex") return ["codex-", "agent-codex-"];
  return [];
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
  // t3code mode: check if the thread still exists in the snapshot
  if (record.mode === "t3code") {
    if (!t3codeSnapshot) return false;
    return t3codeSnapshot.threads.some((t) => t.id === record.name && !t.deletedAt);
  }

  if (!existsSync(record.projectDir)) return false;

  const prefixes = agentPrefixes(record.mode);
  if (prefixes.length === 0) return false;
  const byTask = findSessionByPrefixOrTask(record.projectDir, record.name, prefixes);
  if (byTask) return true;

  // Fallback: exact basename match if task lookup fails.
  // Also check slot-qualified links (${taskId}-s${slot}.session).
  const sessionsDir = join(record.projectDir, ".agent-sessions");
  if (!existsSync(sessionsDir)) return false;
  if (existsSync(join(sessionsDir, `${record.name}.session`))
    || existsSync(join(sessionsDir, basename(record.name) + ".session"))) return true;
  // Check for slot-qualified session links
  try {
    const base = basename(record.name);
    for (const entry of readdirSync(sessionsDir)) {
      if (entry.startsWith(`${base}-s`) && entry.endsWith(".session")) return true;
      if (entry.startsWith(`${record.name}-s`) && entry.endsWith(".session")) return true;
    }
  } catch { /* ignore */ }
  return false;
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
