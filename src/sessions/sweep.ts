// Sessions sweeper — cleanup detached known adapter sessions.
//
// Safety model:
// - Only sessions registered by adapter logic are tracked ("known").
// - Unknown sessions are never harvested.
// - Cleanup runs after 3 consecutive detached sweeps.

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { slotsCount, slotsFilePath } from "../config.ts";
import { parseSlotBlocks, getMode, getTask, getPath, getSession } from "../slots/markdown.ts";
import { readSingleFile, resolveProjectDir } from "../adapters/base.ts";
import { listSessions, type SessionInfo, findSessionByPrefixOrTask } from "../adapters/peer-sync.ts";
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

  const preferPeerSync = mode === "agent-duo" || mode.startsWith("agent-pair");
  const resolved = resolveProjectDir(slotSession, preferPeerSync);
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

function matchesOrchestratedMode(peerSyncPath: string, mode: SweepMode): boolean {
  const expected = mode === "agent-duo" ? "duo" : mode.startsWith("agent-pair") ? "pair" : "";
  if (!expected) return true;
  return (readSingleFile(join(peerSyncPath, "mode")) ?? "") === expected;
}

function selectSessionForTask(sessions: SessionInfo[], taskId: string): SessionInfo | null {
  if (sessions.length === 0) return null;
  if (!taskId) return sessions.length === 1 ? sessions[0]! : null;

  const exact = sessions.find((s) => s.feature === taskId);
  if (exact) return exact;

  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundaryPattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
  const boundaryMatch = sessions.find((s) => boundaryPattern.test(s.feature));
  if (boundaryMatch) return boundaryMatch;

  return sessions.length === 1 ? sessions[0]! : null;
}

function providerCleanupName(taskId: string, session: string): string | null {
  if (taskId && taskId !== "null") return taskId;
  if (session && session !== "null" && !/^\d+$/.test(session)) return session;
  return null;
}

function collectAttachedKeys(): Set<string> {
  const slotsFile = slotsFilePath();
  if (!existsSync(slotsFile)) return new Set();

  const blocks = parseSlotBlocks(readFileSync(slotsFile, "utf-8"));
  const attached = new Set<string>();
  const count = slotsCount();

  for (let slot = 1; slot <= count; slot++) {
    const block = blocks.get(slot);
    if (!block) continue;

    const modeRaw = getMode(block).trim();
    if (!SWEEP_TARGET_MODES.has(modeRaw as SweepMode)) continue;
    const mode = modeRaw as SweepMode;
    const taskId = getTask(block).trim();
    const slotSession = getSession(block).trim();
    const slotPath = getPath(block).trim();
    const projectDir = resolveProjectDirForSlot(mode, slotPath, slotSession);

    if (mode === "agent-duo" || mode.startsWith("agent-pair")) {
      const sessions = listSessions(projectDir).filter((s) => matchesOrchestratedMode(s.peerSyncPath, mode));
      const selected = selectSessionForTask(sessions, taskId && taskId !== "null" ? taskId : "");
      const feature = selected?.feature ?? (taskId && taskId !== "null" ? taskId : "");
      if (!feature) continue;
      attached.add(buildKnownSessionKey(mode, projectDir, feature));
      continue;
    }

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

function knownSessionStillPresent(record: KnownSessionRecord): boolean {
  if (!existsSync(record.projectDir)) return false;

  if (record.mode === "agent-duo" || record.mode.startsWith("agent-pair")) {
    const sessions = listSessions(record.projectDir).filter((s) => matchesOrchestratedMode(s.peerSyncPath, record.mode));
    return sessions.some((s) => s.feature === record.name);
  }

  const prefixes = agentPrefixes(record.mode);
  if (prefixes.length === 0) return false;
  const byTask = findSessionByPrefixOrTask(record.projectDir, record.name, prefixes);
  if (byTask) return true;

  // Fallback: exact basename match if task lookup fails.
  const sessionsDir = join(record.projectDir, ".agent-sessions");
  if (!existsSync(sessionsDir)) return false;
  return existsSync(join(sessionsDir, `${record.name}.session`))
    || existsSync(join(sessionsDir, basename(record.name) + ".session"));
}

function runCleanup(record: KnownSessionRecord): { ok: boolean; detail: string } {
  const result = Bun.spawnSync(record.cleanupCommand, {
    cwd: record.projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (result.exitCode === 0) {
    return { ok: true, detail: result.stdout.toString().trim() || "ok" };
  }
  const stderr = result.stderr.toString().trim();
  const stdout = result.stdout.toString().trim();
  return { ok: false, detail: stderr || stdout || `exit ${result.exitCode}` };
}

export function runSessionSweep(options: SweepOptions): void {
  const now = isoNow();
  const state = loadSessionSweepState();
  const attachedKeys = collectAttachedKeys();

  let reattachedResets = 0;
  let detachedUpdated = 0;
  let retiredMissing = 0;
  let cleanupAttempts = 0;
  let cleanupSuccess = 0;
  let cleanupFailed = 0;

  const detachedToCleanup: KnownSessionRecord[] = [];
  for (const [key, record] of Object.entries(state.sessions)) {
    if (attachedKeys.has(key)) {
      if (record.detachedStreak > 0) reattachedResets++;
      record.detachedStreak = 0;
      record.lastSeenAt = now;
      continue;
    }

    if (!knownSessionStillPresent(record)) {
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
