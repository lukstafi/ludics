// Shared state for detached-session sweeper.
//
// This module owns the allowlist ("known sessions") written by adapter logic.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { harnessDir } from "../config.ts";
import { isGitWorktree, getMainRepoFromWorktree } from "../adapters/base.ts";

export type SweepMode = "agent-duo" | "agent-pair-codex" | "agent-pair-claude" | "agent-claude" | "agent-codex" | "t3code";

export const SWEEP_TARGET_MODES = new Set<SweepMode>([
  "agent-duo",
  "agent-pair-codex",
  "agent-pair-claude",
  "agent-claude",
  "agent-codex",
  "t3code",
]);

export interface KnownSessionRecord {
  key: string;
  mode: SweepMode;
  projectDir: string;
  name: string;
  cleanupCommand: string[];
  detachedStreak: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SessionSweepState {
  version: 1;
  lastSweepAt?: string;
  sessions: Record<string, KnownSessionRecord>;
}

export interface KnownSessionInput {
  mode: SweepMode;
  projectDir: string;
  name: string;
  cleanupCommand?: string[];
  seenAt?: string;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function expandHomePath(raw: string): string {
  if (raw.startsWith("~/")) return resolve(process.env.HOME ?? "~", raw.slice(2));
  return resolve(raw);
}

export function normalizeProjectDirForSweep(raw: string): string {
  const abs = expandHomePath(raw);
  if (isGitWorktree(abs)) {
    const mainRepo = getMainRepoFromWorktree(abs);
    if (mainRepo) return mainRepo;
  }
  return abs;
}

export function sweepStatePath(): string {
  return join(harnessDir(), "mag", "session-sweeper-state.json");
}

export function buildKnownSessionKey(mode: SweepMode, projectDir: string, name: string): string {
  return `${mode}|${normalizeProjectDirForSweep(projectDir)}|${name}`;
}

export function defaultCleanupCommand(mode: SweepMode, name: string): string[] {
  if (mode === "agent-duo") return ["agent-duo", "cleanup", "--feature", name, "--full"];
  if (mode === "agent-pair-codex" || mode === "agent-pair-claude") {
    return ["agent-pair", "cleanup", "--feature", name, "--full"];
  }
  if (mode === "t3code") {
    // name is the threadId for t3code sessions
    return ["ludics", "t3code", "stop-thread", name];
  }
  return [mode, "cleanup", name];
}

export function loadSessionSweepState(): SessionSweepState {
  const file = sweepStatePath();
  if (!existsSync(file)) return { version: 1, sessions: {} };

  try {
    const parsedUnknown = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsedUnknown || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
      return { version: 1, sessions: {} };
    }
    const parsed = parsedUnknown as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.sessions !== "object" || !parsed.sessions || Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: {} };
    }
    const parsedSessions = parsed.sessions as Record<string, unknown>;

    const sessions: Record<string, KnownSessionRecord> = {};
    for (const [, record] of Object.entries(parsedSessions)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const recordData = record as Record<string, unknown>;
      const mode = String(recordData.mode);
      if (!SWEEP_TARGET_MODES.has(mode as SweepMode)) continue;
      const projectDirRaw = String(recordData.projectDir ?? "");
      const projectDir = normalizeProjectDirForSweep(projectDirRaw);
      const name = String(recordData.name ?? "");
      const cleanupCommand = Array.isArray(recordData.cleanupCommand)
        ? (recordData.cleanupCommand as unknown[]).filter((v) => typeof v === "string").map((v) => String(v))
        : [];
      if (!projectDir || !name || cleanupCommand.length < 2) continue;

      const detachedStreakRaw = Number(recordData.detachedStreak ?? 0);
      const detachedStreak = Number.isFinite(detachedStreakRaw) && detachedStreakRaw > 0
        ? Math.floor(detachedStreakRaw)
        : 0;
      const firstSeenAt = String(recordData.firstSeenAt ?? "");
      const lastSeenAt = String(recordData.lastSeenAt ?? "");

      const key = buildKnownSessionKey(mode as SweepMode, projectDir, name);
      sessions[key] = {
        key,
        mode: mode as SweepMode,
        projectDir,
        name,
        cleanupCommand,
        detachedStreak,
        firstSeenAt: firstSeenAt || isoNow(),
        lastSeenAt: lastSeenAt || isoNow(),
      };
    }

    return {
      version: 1,
      lastSweepAt: typeof parsed.lastSweepAt === "string" ? parsed.lastSweepAt : undefined,
      sessions,
    };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export function saveSessionSweepState(state: SessionSweepState): void {
  const file = sweepStatePath();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

export function registerKnownSessions(inputs: KnownSessionInput[]): void {
  if (inputs.length === 0) return;
  const now = isoNow();
  const state = loadSessionSweepState();
  let changed = false;

  for (const input of inputs) {
    if (!SWEEP_TARGET_MODES.has(input.mode)) continue;
    const projectDir = normalizeProjectDirForSweep(input.projectDir);
    const name = input.name.trim();
    if (!projectDir || !name) continue;

    const cleanupCommand = (input.cleanupCommand && input.cleanupCommand.length > 1)
      ? input.cleanupCommand
      : defaultCleanupCommand(input.mode, name);
    const key = buildKnownSessionKey(input.mode, projectDir, name);
    const seenAt = input.seenAt || now;

    const existing = state.sessions[key];
    if (!existing) {
      state.sessions[key] = {
        key,
        mode: input.mode,
        projectDir,
        name,
        cleanupCommand,
        detachedStreak: 0,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      };
      changed = true;
      continue;
    }

    const next: KnownSessionRecord = {
      ...existing,
      mode: input.mode,
      projectDir,
      name,
      cleanupCommand,
      detachedStreak: 0,
      lastSeenAt: seenAt,
    };

    const existingJson = JSON.stringify(existing);
    const nextJson = JSON.stringify(next);
    if (existingJson !== nextJson) {
      state.sessions[key] = next;
      changed = true;
    }
  }

  if (changed) saveSessionSweepState(state);
}
