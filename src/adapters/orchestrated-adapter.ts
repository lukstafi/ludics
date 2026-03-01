// Shared logic for orchestrated adapters (agent-duo + agent-pair variants).
//
// Both adapters share ~80% structure. The differences are parameterized
// via OrchestratedConfig.

import { existsSync } from "fs";
import { join, resolve } from "path";
import {
  listSessions,
  readBasicState,
  readPorts,
  readWorktrees,
} from "./peer-sync.ts";
import {
  readStatusFile,
  formatAgentStatus,
  readSingleFile,
  resolveProjectDir,
  latestMtime,
  isGitWorktree,
  getMainRepoFromWorktree,
} from "./base.ts";
import { getUrl } from "../network.ts";
import { MarkdownBuilder } from "./markdown.ts";
import type { AdapterContext, Adapter } from "./types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OrchestratedStatusFile {
  label: string;    // "Claude" | "Codex" | "Coder" | "Reviewer"
  fileName: string; // "claude.status" | "codex.status" | "coder.status" | "reviewer.status"
}

export interface OrchestratedConfig {
  modeLabel: string;                     // e.g. "agent-duo" | "agent-pair-codex"
  modeFilter?: string;                   // optional filter against .peer-sync/mode (e.g. "duo", "pair")
  statusSectionLabel: string;            // "Agents" | "Roles"
  statusFiles: OrchestratedStatusFile[]; // which status files to check
  portLabels: Record<string, string>;    // PORT_KEY → display label
  worktreeKeys: string[];                // which worktree keys to display
  cliCommand: string;                    // e.g. "agent-duo" | "agent-pair"
  cliStartArgs?: string;                 // e.g. "--codex" for pair-codex
  cliStartHint?: string;                 // extra guidance for start command options
  cliStopArgs?: string;                  // optional extra args for stop commands
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesMode(peerSyncPath: string, modeFilter?: string): boolean {
  if (!modeFilter) return true;
  const mode = readSingleFile(join(peerSyncPath, "mode"));
  return mode === modeFilter;
}

function parseArgs(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

function normalizeProjectDirCandidate(raw: string): string {
  const expanded = raw.startsWith("~/")
    ? join(process.env.HOME ?? "~", raw.slice(2))
    : raw;
  const abs = resolve(expanded);
  if (isGitWorktree(abs)) {
    const mainRepo = getMainRepoFromWorktree(abs);
    if (mainRepo) return mainRepo;
  }
  return abs;
}

function resolveAdapterProjectDir(ctx: AdapterContext): string {
  const candidates: string[] = [];
  if (ctx.path && ctx.path !== "null") candidates.push(ctx.path);
  candidates.push(resolveProjectDir(ctx.session, true));

  const normalized = Array.from(new Set(candidates.map(normalizeProjectDirCandidate)));

  for (const dir of normalized) {
    if (existsSync(join(dir, ".agent-sessions"))) return dir;
  }
  for (const dir of normalized) {
    if (existsSync(dir)) return dir;
  }
  return normalized[0] ?? process.cwd();
}

function appendSessionState(
  md: MarkdownBuilder,
  cfg: OrchestratedConfig,
  syncDir: string,
  feature: string,
): void {
  if (!existsSync(syncDir)) return;

  const state = readBasicState(syncDir);

  // Header
  if (state.session) md.keyValue("Session", state.session);
  if (feature) md.keyValue("Feature", feature);

  // Status files (agents/roles)
  const hasAnyStatus = cfg.statusFiles.some((sf) =>
    existsSync(join(syncDir, sf.fileName)),
  );
  if (hasAnyStatus) {
    md.section(cfg.statusSectionLabel);
    for (const sf of cfg.statusFiles) {
      const status = readStatusFile(join(syncDir, sf.fileName));
      if (status?.status) md.bullet(`${sf.label}: ${formatAgentStatus(status)}`);
    }
  }

  // Terminals from ports file
  const ports = readPorts(syncDir);
  if (ports.size > 0) {
    md.section("Terminals");
    for (const [key, port] of ports) {
      const label = cfg.portLabels[key];
      if (label) md.bullet(`${label}: ${getUrl(port)}`);
    }
  }

  // Runtime
  if (state.phase || state.round) {
    md.section("Runtime");
    if (state.phase) md.bullet(`Phase: ${state.phase}`);
    if (state.round) md.bullet(`Round: ${state.round}`);
  }

  // Worktrees
  const worktrees = readWorktrees(syncDir);
  const wtEntries = Object.entries(worktrees).filter(([k]) =>
    cfg.worktreeKeys.includes(k),
  );
  if (wtEntries.length > 0) {
    md.section("Git");
    for (const [agent, path] of wtEntries) {
      md.bullet(`${agent} worktree: ${path}`);
    }
  }

  // Error warning
  const errorLog = join(syncDir, "error.log");
  if (existsSync(errorLog)) {
    const content = readSingleFile(errorLog);
    if (content) {
      const errorCount = content.split("\n").filter(Boolean).length;
      if (errorCount > 0) {
        md.section("Warnings");
        md.bullet(`Error log has ${errorCount} entries`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createOrchestratedAdapter(cfg: OrchestratedConfig): Adapter {
  const startArgs = parseArgs(cfg.cliStartArgs);
  const stopArgs = parseArgs(cfg.cliStopArgs);

  function readState(ctx: AdapterContext): string | null {
    const projectDir = resolveAdapterProjectDir(ctx);
    const sessions = listSessions(projectDir);
    const filtered = sessions.filter((s) => matchesMode(s.peerSyncPath, cfg.modeFilter));
    const count = filtered.length;
    if (count === 0) return null;

    const md = new MarkdownBuilder();
    md.keyValue("Mode", `${cfg.modeLabel} (${count} sessions)`);
    md.separator();

    let first = true;
    for (const session of filtered) {
      if (!first) md.rule();
      first = false;

      md.heading(3, `Task: ${session.feature}`);
      md.keyValue("Root", session.rootWorktree);
      appendSessionState(md, cfg, session.peerSyncPath, session.feature);
    }

    return md.toString();
  }

  function start(ctx: AdapterContext): string {
    const projectDir = resolveAdapterProjectDir(ctx);
    const feature = ctx.taskId || ctx.process || `slot-${ctx.slot}`;
    const args = [cfg.cliCommand, "start", feature, ...startArgs, ...parseArgs(ctx.adapterArgs)];

    const result = Bun.spawnSync(args, {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      const stdout = result.stdout.toString().trim();
      const detail = stderr || stdout || `exit ${result.exitCode}`;
      throw new Error(`${cfg.cliCommand} start failed: ${detail}`);
    }

    return result.stdout.toString().trim() || `${cfg.cliCommand} start ${feature} (cwd=${projectDir})`;
  }

  function stop(ctx: AdapterContext): string {
    const projectDir = resolveAdapterProjectDir(ctx);
    const args = [cfg.cliCommand, "stop", ...stopArgs];
    if (ctx.taskId) {
      args.push("--feature", ctx.taskId);
    }

    const result = Bun.spawnSync(args, {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      const stdout = result.stdout.toString().trim();
      const detail = stderr || stdout || `exit ${result.exitCode}`;
      throw new Error(`${cfg.cliCommand} stop failed: ${detail}`);
    }

    return result.stdout.toString().trim() || `${cfg.cliCommand} stop (cwd=${projectDir})`;
  }

  function lastActivity(ctx: AdapterContext): string | null {
    const projectDir = resolveAdapterProjectDir(ctx);
    const sessions = listSessions(projectDir);
    const filtered = sessions.filter((s) => matchesMode(s.peerSyncPath, cfg.modeFilter));
    if (filtered.length === 0) return null;

    // Collect status file paths across all sessions
    const paths: string[] = [];
    for (const session of filtered) {
      for (const sf of cfg.statusFiles) {
        paths.push(join(session.peerSyncPath, sf.fileName));
      }
      // Also check phase file — updates on orchestrator state changes
      paths.push(join(session.peerSyncPath, "phase"));
    }
    return latestMtime(paths);
  }

  return { readState, start, stop, lastActivity };
}
