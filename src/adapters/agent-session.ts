// Shared logic for agent-claude and agent-codex adapters.
//
// Both adapters are ~95% identical — parameterize the differences via
// AgentSessionConfig and export factory functions.

import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { tmuxAvailable, tmuxHasSession, tmuxPaneCwd } from "./tmux.ts";
import { readStatusFile, formatAgentStatus, timeAgo, isGitWorktree, getMainRepoFromWorktree, getGitBranch, resolveProjectDir, latestMtime } from "./base.ts";
import { readAgentSessionFile } from "./peer-sync.ts";
import { getUrl } from "../network.ts";
import { MarkdownBuilder } from "./markdown.ts";
import { readProposalLaunchMetadata } from "./task-launch.ts";
import type { AdapterContext, Adapter } from "./types.ts";
import { registerKnownSessions, type SweepMode } from "../sessions/sweep-state.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentSessionConfig {
  command: string;          // "agent-claude" | "agent-codex"
  modeLabel: string;        // "agent-claude" | "agent-codex"
  terminalLabel: string;    // "Claude Code" | "Codex"
  statusFileName: string;   // "claude.status" | "codex.status"
  sessionPrefixes: string[]; // ["claude-", "agent-claude-"] | ["codex-", "agent-codex-"]
}

export function resolveAgentSessionProjectDir(ctx: AdapterContext): string {
  const candidates: string[] = [];
  if (ctx.path && ctx.path !== "null") candidates.push(ctx.path);
  candidates.push(resolveProjectDir(ctx.session));

  const normalized = Array.from(new Set(candidates.map((raw) => {
    const expanded = raw.startsWith("~/")
      ? join(process.env.HOME ?? "~", raw.slice(2))
      : raw;
    const abs = resolve(expanded);
    if (isGitWorktree(abs)) {
      const mainRepo = getMainRepoFromWorktree(abs);
      if (mainRepo) return mainRepo;
    }
    return abs;
  })));

  for (const dir of normalized) {
    if (existsSync(join(dir, ".agent-sessions"))) return dir;
  }
  for (const dir of normalized) {
    if (existsSync(dir)) return dir;
  }
  return normalized[0] ?? process.cwd();
}

function readLaunchFeature(
  cfg: AgentSessionConfig,
  ctx: AdapterContext,
  projectDir: string,
): string | null {
  if (!ctx.taskId || ctx.taskId === "null") return null;
  return readProposalLaunchMetadata(cfg.command, ctx.harnessDir, ctx.taskId, projectDir)?.launchFeature ?? null;
}

function tryReadLaunchFeature(
  cfg: AgentSessionConfig,
  ctx: AdapterContext,
  projectDir: string,
): string | null {
  try {
    return readLaunchFeature(cfg, ctx, projectDir);
  } catch {
    return null;
  }
}

function sessionLookupCandidates(
  ctx: AdapterContext,
  launchFeature: string | null,
): string[] {
  const candidates = [
    ctx.taskId,
    launchFeature,
    ctx.session && ctx.session !== "null" && !/^\d+$/.test(ctx.session) ? ctx.session : "",
  ];
  return Array.from(new Set(candidates.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function findSessionFileForCandidates(
  projectDir: string,
  candidates: string[],
  prefixes: string[],
): string | null {
  const sessionsDir = join(projectDir, ".agent-sessions");
  if (!existsSync(sessionsDir)) return null;

  let files: string[] = [];
  try {
    files = readdirSync(sessionsDir).filter((entry) => entry.endsWith(".session"));
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    for (const prefix of prefixes) {
      const fileName = `${prefix}${candidate}.session`;
      if (files.includes(fileName)) return join(sessionsDir, fileName);
    }
    const legacyName = `${candidate}.session`;
    if (files.includes(legacyName)) return join(sessionsDir, legacyName);
  }

  for (const prefix of prefixes) {
    const prefixed = files.find((entry) => entry.startsWith(prefix));
    if (prefixed) return join(sessionsDir, prefixed);
  }

  const fallback = files[0];
  return fallback ? join(sessionsDir, fallback) : null;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createAgentSessionAdapter(cfg: AgentSessionConfig): Adapter {
  const sweepMode = cfg.modeLabel as SweepMode;

  function readState(ctx: AdapterContext): string | null {
    if (!tmuxAvailable()) return null;

    const projectDir = resolveAgentSessionProjectDir(ctx);
    const launchFeature = tryReadLaunchFeature(cfg, ctx, projectDir);
    const sessionFile = findSessionFileForCandidates(
      projectDir,
      sessionLookupCandidates(ctx, launchFeature),
      cfg.sessionPrefixes,
    );
    const sessionInfo = sessionFile ? readAgentSessionFile(sessionFile) : null;

    const tmuxName = sessionInfo?.tmux
      || (ctx.session && ctx.session !== "null" ? ctx.session : null);
    if (!tmuxName) return null;
    if (!tmuxHasSession(tmuxName)) return null;

    const knownName = (
      sessionInfo?.task
      || launchFeature
      || (ctx.taskId && ctx.taskId !== "null" ? ctx.taskId : "")
      || (ctx.session && ctx.session !== "null" && !/^\d+$/.test(ctx.session) ? ctx.session : "")
    ).trim();
    if (knownName) {
      registerKnownSessions([
        {
          mode: sweepMode,
          projectDir,
          name: knownName,
        },
      ]);
    }

    const md = new MarkdownBuilder();
    md.keyValue("Mode", cfg.modeLabel);

    // Terminals
    md.section("Terminals");
    md.bullet(`${cfg.terminalLabel}: tmux session '${tmuxName}'`);
    if (sessionInfo?.ttydPort) {
      md.bullet(`Web: ${getUrl(sessionInfo.ttydPort)}`);
    }

    // Git info
    const cwd = tmuxPaneCwd(tmuxName);
    if (cwd) {
      md.section("Git");
      if (isGitWorktree(cwd)) {
        const mainRepo = getMainRepoFromWorktree(cwd);
        md.bullet(`Working directory: ${cwd} (worktree)`);
        if (mainRepo) md.bullet(`Main repository: ${mainRepo}`);
      } else {
        md.bullet(`Working directory: ${cwd}`);
      }
      const branch = getGitBranch(cwd);
      if (branch) md.bullet(`Branch: ${branch}`);
    }

    // Runtime info from session file
    if (sessionInfo) {
      md.section("Runtime");
      if (sessionInfo.task) md.bullet(`Task: ${sessionInfo.task}`);
      if (sessionInfo.mode) md.bullet(`Mode: ${sessionInfo.mode}`);
      if (sessionInfo.started) md.bullet(`Started: ${sessionInfo.started}`);
    }

    // Agent status
    if (sessionInfo?.workdir) {
      const statusPath = join(sessionInfo.workdir, ".peer-sync", cfg.statusFileName);
      const status = readStatusFile(statusPath);
      if (status && status.status) {
        md.bullet(`Status: ${formatAgentStatus(status)}`);
        if (status.epoch) md.detail(`Updated: ${timeAgo(status.epoch)}`);
      }
    }

    return md.toString();
  }

  function start(ctx: AdapterContext): string {
    const projectDir = resolveAgentSessionProjectDir(ctx);
    const task = readLaunchFeature(cfg, ctx, projectDir)
      || ctx.taskId
      || ctx.session
      || `slot-${ctx.slot}`;

    const result = Bun.spawnSync([cfg.command, task, "--bare"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(`${cfg.command} start failed: ${stderr}`);
    }

    const knownName = task.trim();
    if (knownName) {
      registerKnownSessions([
        {
          mode: sweepMode,
          projectDir,
          name: knownName,
        },
      ]);
    }

    return result.stdout.toString().trim() || `${cfg.command} session started for ${task}`;
  }

  function stop(ctx: AdapterContext): string {
    const projectDir = resolveAgentSessionProjectDir(ctx);
    const task = tryReadLaunchFeature(cfg, ctx, projectDir)
      || ctx.taskId
      || ctx.session
      || `slot-${ctx.slot}`;

    const result = Bun.spawnSync([cfg.command, "cleanup", task], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(`${cfg.command} cleanup failed: ${stderr}`);
    }

    return result.stdout.toString().trim() || `${cfg.command} session stopped for ${task}`;
  }

  function lastActivity(ctx: AdapterContext): string | null {
    const projectDir = resolveAgentSessionProjectDir(ctx);
    const launchFeature = tryReadLaunchFeature(cfg, ctx, projectDir);
    const sessionFile = findSessionFileForCandidates(
      projectDir,
      sessionLookupCandidates(ctx, launchFeature),
      cfg.sessionPrefixes,
    );
    const sessionInfo = sessionFile ? readAgentSessionFile(sessionFile) : null;

    const paths: string[] = [];
    // Check the session file itself
    if (sessionFile) paths.push(sessionFile);
    // Check agent status file in workdir
    if (sessionInfo?.workdir) {
      paths.push(join(sessionInfo.workdir, ".peer-sync", cfg.statusFileName));
    }
    return latestMtime(paths);
  }

  return { readState, start, stop, lastActivity };
}
