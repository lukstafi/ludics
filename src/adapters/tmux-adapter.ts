// tmux+ttyd adapter — implements the Adapter interface for tmux orchestration mode.
// The existing src/adapters/tmux.ts holds shared tmux helpers; this file is the adapter entry point.

import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import { getMainRepoFromWorktree, latestMtime, resolveProjectDir, slotSessionName } from "./base.ts";
import { safeSyncOutput } from "../spawn.ts";
import { MarkdownBuilder } from "./markdown.ts";
import type { Adapter, AdapterContext } from "./types.ts";
import { findProjectConfig, loadConfigSync, type LudicsFullConfig } from "../config.ts";
import { setsidWrap } from "../orchestration/util.ts";
import {
  tmuxHasSession,
  tmuxNewSession,
  tmuxPanePid,
  tmuxKillSession,
  tmuxSendCommand,
  tmuxCapture,
} from "./tmux.ts";
import {
  defaultOrchestrationConfig,
  initAgentRuntimeState,
  persistState,
  readOrchestrationState,
  removeOrchestrationState,
  stateFilePath,
  type AgentConfig,
  type OrchestrationState,
} from "../orchestration/state.ts";
import { initPeerSync, removePeerSyncSession, writeAgentMarkerFiles } from "../orchestration/peer-sync.ts";
import { claudeEffort, codexEffort, normaliseEffortLevel } from "../orchestration/effort.ts";
import { createWorktrees, cleanupWorktrees, symlinkPeerSync } from "../orchestration/worktrees.ts";
import { recordDeferredCleanup, buildCleanupEntry } from "../orchestration/deferred-cleanup.ts";
import { isoNow, makeId, nowEpoch } from "../orchestration/util.ts";
import { startOrchestrationProcess } from "../orchestration/process.ts";
import { parseT3CodeAdapterArgs } from "./t3code.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT_BASE = 7681; // port 7680 reserved

// ---------------------------------------------------------------------------
// Tmux slot state — persisted alongside orchestration state
// ---------------------------------------------------------------------------

interface TmuxSlotState {
  slot: number;
  ttydPids: Record<string, number>; // agent name → ttyd PID
  orchestration?: {
    stateFile: string;
    mode: "duo" | "pair";
    pid?: number;
  };
}

function tmuxSlotPath(slot: number, harnessDir: string): string {
  return join(harnessDir, "orchestration", `tmux-slot-${slot}.json`);
}

function readTmuxSlotState(slot: number, harnessDir: string): TmuxSlotState | null {
  const path = tmuxSlotPath(slot, harnessDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(require("fs").readFileSync(path, "utf-8")) as TmuxSlotState;
  } catch {
    return null;
  }
}

function writeTmuxSlotState(state: TmuxSlotState, harnessDir: string): void {
  const path = tmuxSlotPath(state.slot, harnessDir);
  const dir = join(harnessDir, "orchestration");
  if (!existsSync(dir)) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
  require("fs").writeFileSync(path, JSON.stringify(state, null, 2));
}

function removeTmuxSlotState(slot: number, harnessDir: string): void {
  const path = tmuxSlotPath(slot, harnessDir);
  if (existsSync(path)) {
    try { require("fs").unlinkSync(path); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Naming / port helpers
// ---------------------------------------------------------------------------

/** Tmux session name — delegates to shared slotSessionName convention */
export function tmuxSessionName(slot: number, agentName: string, taskId?: string): string {
  return slotSessionName(slot, agentName, taskId);
}

/** Target for tmux commands — just the session name (one window per session) */
function tmuxTarget(slot: number, agentName: string, taskId?: string): string {
  return tmuxSessionName(slot, agentName, taskId);
}

export function ttydPort(slot: number, role: "coder" | "reviewer"): number {
  const roleIndex = role === "reviewer" ? 1 : 0;
  return PORT_BASE + (slot - 1) * 2 + roleIndex;
}

/**
 * Derive the port-assignment role for an agent.
 * Uses the explicit role if set, otherwise falls back to index-based assignment
 * (even index → coder, odd → reviewer) so duo-mode agents with arbitrary names
 * get distinct ports instead of all colliding on "reviewer".
 */
function agentPortRole(agent: { role?: string; name: string }, index: number): "coder" | "reviewer" {
  if (agent.role === "coder" || agent.role === "reviewer") return agent.role;
  return index % 2 === 0 ? "coder" : "reviewer";
}

// ---------------------------------------------------------------------------
// Workspace & feature helpers (shared with t3code adapter)
// ---------------------------------------------------------------------------

function normalizeWorkspacePath(ctx: AdapterContext): string {
  const raw = ctx.path && ctx.path !== "null"
    ? ctx.path
    : resolveProjectDir(ctx.session);
  if (raw.startsWith("~/")) {
    return resolve(process.env.HOME ?? "~", raw.slice(2));
  }
  return resolve(raw);
}

function orchestrationProjectDir(workspaceRoot: string): string {
  return getMainRepoFromWorktree(workspaceRoot) ?? workspaceRoot;
}

function killPid(pid?: number): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore missing process
  }
}

function loadConfigOrchestration(config?: LudicsFullConfig): Record<string, unknown> | undefined {
  try {
    const cfg = config ?? loadConfigSync();
    const mag = cfg.mag as Record<string, unknown> | undefined;
    return mag?.orchestration as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Agent model / effort resolution (duplicated from t3code adapter — these are
// orchestration-generic but not yet extracted to a shared module)
// ---------------------------------------------------------------------------

interface ParsedAgentToken {
  name: string;
  provider: string;
  model: string;
  modelExplicit: boolean;
  role?: "coder" | "reviewer";
}

function resolveAgentModel(
  agent: ParsedAgentToken,
  index: number,
  orchCfg: Record<string, unknown> | undefined,
  coderOverride: string | undefined,
  reviewerOverride: string | undefined,
): string {
  const isCoderSlot = agent.role === "coder" || (!agent.role && index === 0);
  const isReviewerSlot = agent.role === "reviewer" || (!agent.role && index === 1);
  if (isCoderSlot && coderOverride) return coderOverride;
  if (isReviewerSlot && reviewerOverride) return reviewerOverride;
  if (agent.modelExplicit) return agent.model;
  if (isCoderSlot) {
    const cfgModel = orchCfg?.coder_model as string | undefined;
    if (cfgModel?.trim()) return cfgModel.trim();
  }
  if (isReviewerSlot) {
    const cfgModel = orchCfg?.reviewer_model as string | undefined;
    if (cfgModel?.trim()) return cfgModel.trim();
  }
  return agent.model;
}

function resolveAgentThinkingEffort(
  agent: ParsedAgentToken,
  index: number,
  orchCfg: Record<string, unknown> | undefined,
  coderEffort: string | undefined,
  reviewerEffort: string | undefined,
): string {
  const isCoderSlot = agent.role === "coder" || (!agent.role && index === 0);
  const isReviewerSlot = agent.role === "reviewer" || (!agent.role && index === 1);
  if (isCoderSlot && coderEffort) return coderEffort;
  if (isReviewerSlot && reviewerEffort) return reviewerEffort;
  if (isCoderSlot) {
    const cfgEffort = (orchCfg?.coder_effort ?? orchCfg?.coder_thinking_effort) as string | undefined;
    if (cfgEffort?.trim()) return cfgEffort.trim();
  }
  if (isReviewerSlot) {
    const cfgEffort = (orchCfg?.reviewer_effort ?? orchCfg?.reviewer_thinking_effort) as string | undefined;
    if (cfgEffort?.trim()) return cfgEffort.trim();
  }
  return "high";
}

// ---------------------------------------------------------------------------
// tmux window + ttyd setup
// ---------------------------------------------------------------------------

/** Create a dedicated tmux session for an agent. One session per agent for full isolation. */
function createTmuxAgentSession(slot: number, agentName: string, cwd: string, taskId?: string): void {
  const sessionName = tmuxSessionName(slot, agentName, taskId);
  // Kill existing session if present (stale from prior run)
  if (tmuxHasSession(sessionName)) {
    tmuxKillSession(sessionName);
  }
  // Create new session
  tmuxNewSession(sessionName, cwd);
  // Disable mouse to prevent copy-mode lockups
  safeSyncOutput(["tmux", "set-option", "-t", sessionName, "mouse", "off"]);
}

export function startTtyd(slot: number, agentName: string, role: "coder" | "reviewer", taskId?: string): number {
  const port = ttydPort(slot, role);
  const target = tmuxTarget(slot, agentName, taskId);

  // Kill any stale ttyd on this port
  safeSyncOutput(["pkill", "-f", `ttyd.*--port ${port}`]);

  // Use setsidWrap to detach ttyd into its own process session so it survives
  // when the parent (launchd oneshot keepalive) exits.
  const proc = Bun.spawn(
    setsidWrap(["ttyd", "--writable", "--port", String(port), "tmux", "attach", "-t", target]),
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if (typeof (proc as { unref?: () => void }).unref === "function") {
    (proc as { unref: () => void }).unref();
  }
  return proc.pid;
}

function killTtydForSlot(slot: number): void {
  for (const role of ["coder", "reviewer"] as const) {
    const port = ttydPort(slot, role);
    safeSyncOutput(["pkill", "-f", `ttyd.*--port ${port}`]);
  }
}

function killTmuxSessionsForSlot(slot: number, agentNames: string[], taskId?: string): void {
  for (const name of agentNames) {
    const session = tmuxSessionName(slot, name, taskId);
    if (tmuxHasSession(session)) {
      tmuxKillSession(session);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot persistent agent CLI in a tmux pane
// ---------------------------------------------------------------------------

/**
 * Start a persistent interactive agent CLI in the pane.
 * The CLI stays alive between turns; the transport injects prompts into it.
 */
function bootAgentCli(
  slot: number,
  agent: { name: string; provider: string; thinkingEffort?: string },
  peerSyncDir: string,
  _phaseToken: string,
  taskId?: string,
): void {
  const target = tmuxTarget(slot, agent.name, taskId);

  // Export environment variables needed by stop hooks.
  // Phase token is read from peer-sync/phase-token file, not env var.
  const envCmd = [
    `export LUDICS_SLOT=${slot}`,
    `LUDICS_AGENT=${agent.name}`,
    `LUDICS_PEER_SYNC_DIR="${peerSyncDir}"`,
  ].join(" ");
  tmuxSendCommand(target, envCmd);

  // Boot the CLI (runs persistently in the pane)
  tmuxSendCommand(target, agentCliCommand(agent));
}

// ---------------------------------------------------------------------------
// isAgentAlive — check if an agent CLI process is running in the tmux pane
// ---------------------------------------------------------------------------

export function isAgentAlive(slot: number, agentName: string, taskId?: string): boolean {
  const target = tmuxTarget(slot, agentName, taskId);
  const panePid = tmuxPanePid(target);
  if (!panePid) return false;

  // Check child processes of the pane shell for agent CLIs
  return safeSyncOutput(["pgrep", "-P", String(panePid), "-f", "(claude|codex)"]).ok;
}

/**
 * Capture tmux pane output and return its hash.
 * Returns null if capture fails. Used for stall detection:
 * if the hash hasn't changed between polls, the terminal is static.
 */
export function tmuxPaneOutputHash(target: string, lines: number = 50): string | null {
  const raw = tmuxCapture(target, lines);
  if (!raw) return null;
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(raw);
  return hasher.digest("hex");
}

/**
 * Extract the "last message" region of a Claude Code pane: everything from
 * the last "⏺" (assistant message marker) up to the last "❯" (input prompt)
 * line, excluding the prompt itself and any "─────" separators. Deliberately
 * excludes the footer below the prompt (token counts, bypass-permissions
 * line, new-task hint) — those update for cosmetic reasons even when Claude
 * is idle, which is noise for stall/readiness detection.
 *
 * Requires the "❯" prompt marker to be present. Returns null if the capture
 * failed, no "❯" is found (splash/init, bare shell, crashed Claude), or the
 * extracted snippet is empty. Callers downstream (e.g. isMagReady) treat a
 * null result as "pane is not in a known-ready state", which prevents silent
 * queue delivery into a non-Claude pane.
 */
export function captureLastMessage(target: string, lines: number = 50): string | null {
  const raw = tmuxCapture(target, lines);
  if (!raw) return null;

  const allLines = raw.split("\n");

  let startIdx = 0;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (allLines[i]!.includes("⏺")) {
      startIdx = i;
      break;
    }
  }

  let endIdx = -1;
  for (let i = allLines.length - 1; i >= startIdx; i--) {
    if (allLines[i]!.includes("❯")) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const snippet = allLines
    .slice(startIdx, endIdx)
    .filter((l) => !l.match(/^[─]{4,}/))
    .join("\n")
    .trim();

  return snippet || null;
}

/**
 * Hash of the "last message" region — stable across cosmetic footer updates.
 * Preferred signal for Mag stall/readiness detection. Returns null if
 * capture fails or the extracted snippet is empty.
 */
export function captureLastMessageHash(target: string, lines: number = 50): string | null {
  const snippet = captureLastMessage(target, lines);
  if (!snippet) return null;
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(snippet);
  return hasher.digest("hex");
}

/**
 * Get the CLI launch command for an agent. If the agent has a thinkingEffort
 * set, it is translated through the unified ladder and passed as the
 * provider-specific flag (claude: --effort; codex: -c model_reasoning_effort).
 */
export function agentCliCommand(agent: { provider: string; thinkingEffort?: string }): string {
  const effortRaw = agent.thinkingEffort?.trim();
  if (agent.provider === "claude-code") {
    const base = "claude --dangerously-skip-permissions";
    if (!effortRaw) return base;
    const level = normaliseEffortLevel(effortRaw);
    return `${base} --effort ${claudeEffort(level)}`;
  }
  const base = "codex --yolo -c check_for_update_on_startup=false";
  if (!effortRaw) return base;
  const level = normaliseEffortLevel(effortRaw);
  return `${base} -c model_reasoning_effort="${codexEffort(level)}"`;
}

/**
 * Inject a prompt into a live agent CLI session.
 * Uses load-buffer + paste-buffer for all providers — atomic paste avoids the
 * garbling that chunked send-keys -l caused with Codex TUI input processing.
 * Handles copy-mode exit and provider-specific Enter timing.
 */
export async function sendPromptToAgent(
  target: string,
  message: string,
  provider: string,
): Promise<void> {
  // Exit copy mode if active (user may have scrolled)
  safeSyncOutput(["tmux", "send-keys", "-t", target, "-X", "cancel"]);
  await Bun.sleep(100);

  // Atomic paste via load-buffer + paste-buffer for all providers.
  const promptFile = `/tmp/ludics-prompt-${target}-${Date.now()}.txt`;
  const { writeFileSync, unlinkSync } = await import("fs");
  writeFileSync(promptFile, message);
  safeSyncOutput(["tmux", "load-buffer", promptFile]);
  safeSyncOutput(["tmux", "paste-buffer", "-t", target]);
  try { unlinkSync(promptFile); } catch { /* ignore */ }

  // Submit: sleep to let the TUI process the pasted input, then send C-m.
  // Scale delay with paste size — large pastes (8KB+) need more time for TUI processing.
  const baseDelay = provider === "codex" ? 1500 : 500;
  const sizeDelay = Math.min(Math.floor(message.length / 1000) * 500, 5000);
  await Bun.sleep(baseDelay + sizeDelay);
  safeSyncOutput(["tmux", "send-keys", "-t", target, "C-m"]);

  // Verify submission: if pane still shows "[Pasted Content" after Enter,
  // the TUI didn't accept it yet — retry with increasing delays.
  for (let attempt = 0; attempt < 3; attempt++) {
    await Bun.sleep(1500);
    const paneText = tmuxCapture(target, 5);
    if (!paneText || !paneText.includes("[Pasted Content")) break;
    // Still showing pasted content — resend Enter
    safeSyncOutput(["tmux", "send-keys", "-t", target, "C-m"]);
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

async function start(ctx: AdapterContext): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(ctx);
  const options = parseT3CodeAdapterArgs(ctx.adapterArgs);

  if (!options.orchestration) {
    throw new Error(
      `slot ${ctx.slot}: tmux adapter requires orchestration flags.\n` +
      `  Reassign with one of:\n` +
      `    ludics slot ${ctx.slot} assign <task> -a tmux --pair --coder <provider> --reviewer <provider>\n` +
      `    ludics slot ${ctx.slot} assign <task> -a tmux -A "<flags>"`
    );
  }

  const orchestration = options.orchestration;
  const taskId = ctx.taskId && ctx.taskId !== "null" ? ctx.taskId : undefined;
  if (!taskId) {
    throw new Error(`slot ${ctx.slot}: taskId is required for orchestration. Assign a task first.`);
  }
  const projectDir = orchestrationProjectDir(workspaceRoot);
  const existing = readTmuxSlotState(ctx.slot, ctx.harnessDir);

  if (existing?.orchestration?.pid) killPid(existing.orchestration.pid);

  // Load config once and thread through all helpers.
  const config = loadConfigSync();
  const orchCfg = loadConfigOrchestration(config);
  const configPhaseTimeouts = orchCfg?.phase_timeouts as Record<string, number> | undefined;
  if (configPhaseTimeouts && typeof configPhaseTimeouts === "object") {
    orchestration.config.timeouts = { ...configPhaseTimeouts, ...(orchestration.config.timeouts ?? {}) };
  }

  const setup = createWorktrees(projectDir, taskId, orchestration.agents, undefined, ctx.slot, orchestration.mode);
  symlinkPeerSync(setup.peerSyncDir, setup.agentWorktrees);

  const agents: AgentConfig[] = orchestration.agents.map((agent, index) => ({
    name: agent.name,
    provider: agent.provider,
    role: agent.role,
    model: resolveAgentModel(
      agent as ParsedAgentToken,
      index,
      orchCfg,
      orchestration.coderModelOverride,
      orchestration.reviewerModelOverride,
    ),
    thinkingEffort: resolveAgentThinkingEffort(
      agent as ParsedAgentToken,
      index,
      orchCfg,
      orchestration.coderThinkingEffort,
      orchestration.reviewerThinkingEffort,
    ),
    branch: setup.branches[agent.name]!,
    worktreePath: setup.agentWorktrees[agent.name]!,
  }));

  initPeerSync(
    setup.peerSyncDir,
    taskId,
    orchestration.mode,
    projectDir,
    agents,
    { root: setup.rootWorktree, ...setup.agentWorktrees },
    ctx.slot,
  );
  writeAgentMarkerFiles(setup.peerSyncDir, setup.agentWorktrees);

  // --- tmux-specific setup: create sessions + ttyd + boot agent CLIs ---
  const ttydPids: Record<string, number> = {};
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    createTmuxAgentSession(ctx.slot, agent.name, agent.worktreePath, taskId);
    const role = agentPortRole(agent, i);
    if (ctx.startTtyd !== false) ttydPids[agent.name] = startTtyd(ctx.slot, agent.name, role, taskId);
    // Boot persistent interactive agent CLI in the session
    bootAgentCli(ctx.slot, agent, setup.peerSyncDir, "setup", taskId);
  }

  // --- Build orchestration state (no t3code threadIds) ---
  const state: OrchestrationState = {
    slot: ctx.slot,
    taskId,
    mode: orchestration.mode,
    phase: "setup",
    round: 1,
    mergeRound: 0,
    agents,
    agentStates: initAgentRuntimeState(agents.map((a) => a.name)),
    config: defaultOrchestrationConfig(orchestration.config),
    phaseStartedAt: nowEpoch(),
    startedAt: isoNow(),
    projectDir,
    rootWorktree: setup.rootWorktree,
    peerSyncDir: setup.peerSyncDir,
    threadIds: {}, // tmux mode doesn't use t3code threads
    backend: "tmux",
    branches: setup.branches,
    slotTitle: options.title ?? slotSessionName(ctx.slot, undefined, taskId),
    duoPeerSlot: orchestration.duoPeerSlot ?? null,
    upstreamRepo: findProjectConfig(projectDir, config)?.upstream_repo || undefined,
  };
  persistState(state, ctx.harnessDir);

  const pid = await startOrchestrationProcess(ctx.slot, ctx.harnessDir, taskId);
  writeTmuxSlotState({
    slot: ctx.slot,
    ttydPids,
    orchestration: {
      stateFile: stateFilePath(ctx.slot, ctx.harnessDir),
      mode: orchestration.mode,
      pid,
    },
  }, ctx.harnessDir);

  const role0 = agents[0]?.role ?? "coder";
  const port0 = ttydPort(ctx.slot, role0 as "coder" | "reviewer");
  return `tmux slot ${ctx.slot} started — ttyd at http://localhost:${port0}`;
}

async function stop(ctx: AdapterContext, options?: { preserveState?: boolean }): Promise<string> {
  const slotState = readTmuxSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState) {
    return `tmux slot ${ctx.slot} already stopped`;
  }

  // Kill orchestration runner
  if (slotState.orchestration?.pid) killPid(slotState.orchestration.pid);

  const orchState = slotState.orchestration
    ? readOrchestrationState(ctx.slot, ctx.harnessDir)
    : null;

  // Kill ttyd processes
  killTtydForSlot(ctx.slot);

  // Defer artifact cleanup for post-mortem window (tmux sessions, worktrees, branches, peer-sync)
  if (orchState) {
    if (!options?.preserveState) {
      recordDeferredCleanup(buildCleanupEntry(orchState, ctx.slot, {
        tmuxSessionNames: orchState.agents.map((a) =>
          tmuxSessionName(ctx.slot, a.name, orchState.taskId)),
      }));
      removeOrchestrationState(ctx.slot, ctx.harnessDir);
    }
  }

  if (!options?.preserveState) {
    removeTmuxSlotState(ctx.slot, ctx.harnessDir);
  }
  return `tmux slot ${ctx.slot} stopped`;
}

async function readState(ctx: AdapterContext): Promise<string | null> {
  const slotState = readTmuxSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState) return null;

  const md = new MarkdownBuilder();
  const orchState = slotState.orchestration
    ? readOrchestrationState(ctx.slot, ctx.harnessDir)
    : null;

  md.keyValue("Mode", orchState ? `tmux ${orchState.mode}` : "tmux");

  if (orchState) {
    md.section("Orchestration");
    md.keyValue("Task", orchState.taskId);
    md.keyValue("Phase", orchState.phase);
    md.keyValue("Round", String(orchState.round));

    if (slotState.orchestration?.pid) {
      let alive = false;
      try { process.kill(slotState.orchestration.pid, 0); alive = true; } catch { /* dead */ }
      md.keyValue("Runner", alive ? `alive (pid ${slotState.orchestration.pid})` : `dead (pid ${slotState.orchestration.pid})`);
    }

    md.section("Agents");
    for (let i = 0; i < orchState.agents.length; i++) {
      const agent = orchState.agents[i]!;
      const role = agentPortRole(agent, i);
      const port = ttydPort(ctx.slot, role);
      const alive = isAgentAlive(ctx.slot, agent.name, orchState.taskId);
      md.bullet(`${agent.name} (${agent.provider}:${agent.model})`);
      md.detail(`Status: ${alive ? "running" : "idle"}`);
      md.detail(`Terminal: http://localhost:${port}`);
      md.detail(`Worktree: ${agent.worktreePath}`);
      if (agent.branch) md.detail(`Branch: ${agent.branch}`);

      const rs = orchState.agentStates[agent.name];
      if (rs) {
        const lc = rs.turnLifecycle;
        if (lc) md.detail(`Lifecycle: ${lc.state}`);
        if (rs.status) md.detail(`Status: ${rs.status}`);
      }
    }
  }

  // ttyd ports
  md.section("Terminals");
  for (const [agentName, pid] of Object.entries(slotState.ttydPids)) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
    md.bullet(`${agentName}: ttyd pid ${pid} (${alive ? "alive" : "dead"})`);
  }

  return md.toString();
}

async function lastActivity(ctx: AdapterContext): Promise<string | null> {
  const orchState = readOrchestrationState(ctx.slot, ctx.harnessDir);
  if (!orchState) return null;

  const candidates: string[] = [];

  // Check peer-sync directory mtime
  if (existsSync(orchState.peerSyncDir)) {
    const t = latestMtime([orchState.peerSyncDir]);
    if (t) candidates.push(t);
  }

  // Check orchestration state mtime
  const stateFile = stateFilePath(ctx.slot, ctx.harnessDir);
  if (existsSync(stateFile)) {
    const t = latestMtime([stateFile]);
    if (t) candidates.push(t);
  }

  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1]!;
}

const adapter = { readState, start, stop, lastActivity } satisfies Adapter;

export { readState, start, stop, lastActivity, readTmuxSlotState, writeTmuxSlotState, removeTmuxSlotState, agentPortRole };
export default adapter;
