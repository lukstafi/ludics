// tmux+ttyd adapter — implements the Adapter interface for tmux orchestration mode.
// The existing src/adapters/tmux.ts holds shared tmux helpers; this file is the adapter entry point.

import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import { getMainRepoFromWorktree, latestMtime, resolveProjectDir } from "./base.ts";
import { MarkdownBuilder } from "./markdown.ts";
import type { Adapter, AdapterContext } from "./types.ts";
import { loadConfigSync } from "../config.ts";
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
import { createWorktrees, cleanupWorktrees, symlinkPeerSync } from "../orchestration/worktrees.ts";
import { isoNow, makeId, nowEpoch, slugify } from "../orchestration/util.ts";
import { startOrchestrationProcess } from "../orchestration/process.ts";
import { parseT3CodeAdapterArgs } from "./t3code.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMUX_SESSION = "ludics";
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

function tmuxWindowName(slot: number, agentName: string): string {
  return `slot-${slot}-${agentName}`;
}

function tmuxTarget(slot: number, agentName: string): string {
  return `${TMUX_SESSION}:${tmuxWindowName(slot, agentName)}`;
}

function ttydPort(slot: number, role: "coder" | "reviewer"): number {
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

function makeOrchestrationFeature(ctx: AdapterContext, requested?: string): string {
  if (requested?.trim()) return slugify(requested);
  if (ctx.taskId?.trim()) return slugify(ctx.taskId);
  if (ctx.process?.trim()) return slugify(ctx.process);
  return `slot-${ctx.slot}`;
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

function loadConfigOrchestration(): Record<string, unknown> | undefined {
  try {
    const config = loadConfigSync();
    const mag = config.mag as Record<string, unknown> | undefined;
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

function ensureTmuxSession(): void {
  if (!tmuxHasSession(TMUX_SESSION)) {
    tmuxNewSession(TMUX_SESSION);
    // Disable mouse to prevent copy-mode lockups
    Bun.spawnSync(["tmux", "set-option", "-t", TMUX_SESSION, "mouse", "off"], {
      stdout: "pipe", stderr: "pipe",
    });
  }
}

function createTmuxWindow(slot: number, agentName: string, cwd: string): void {
  const windowName = tmuxWindowName(slot, agentName);
  // Kill existing window if present (stale from prior run)
  Bun.spawnSync(["tmux", "kill-window", "-t", `${TMUX_SESSION}:${windowName}`], {
    stdout: "pipe", stderr: "pipe",
  });
  // Create new window
  const result = Bun.spawnSync(
    ["tmux", "new-window", "-t", TMUX_SESSION, "-n", windowName, "-c", cwd],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`tmux new-window failed for ${windowName}: ${result.stderr.toString().trim()}`);
  }
}

function startTtyd(slot: number, agentName: string, role: "coder" | "reviewer"): number {
  const port = ttydPort(slot, role);
  const target = tmuxTarget(slot, agentName);

  // Kill any stale ttyd on this port
  Bun.spawnSync(["pkill", "-f", `ttyd.*--port ${port}`], {
    stdout: "pipe", stderr: "pipe",
  });

  const proc = Bun.spawn(
    ["ttyd", "--writable", "--port", String(port), "tmux", "attach", "-t", target],
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
    Bun.spawnSync(["pkill", "-f", `ttyd.*--port ${port}`], {
      stdout: "pipe", stderr: "pipe",
    });
  }
}

function killTmuxWindowsForSlot(slot: number, agentNames: string[]): void {
  for (const name of agentNames) {
    Bun.spawnSync(["tmux", "kill-window", "-t", tmuxTarget(slot, name)], {
      stdout: "pipe", stderr: "pipe",
    });
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
  agent: { name: string; provider: string },
  peerSyncDir: string,
  phaseToken: string,
): void {
  const target = tmuxTarget(slot, agent.name);

  // Export environment variables needed by stop hooks
  const envCmd = [
    `export LUDICS_SLOT=${slot}`,
    `LUDICS_AGENT=${agent.name}`,
    `LUDICS_PEER_SYNC_DIR="${peerSyncDir}"`,
    `LUDICS_PHASE_TOKEN="${phaseToken}"`,
  ].join(" ");
  tmuxSendCommand(target, envCmd);

  // Determine CLI command based on provider
  let cliCmd: string;
  if (agent.provider === "claude-code") {
    cliCmd = "claude --dangerously-skip-permissions";
  } else {
    // codex — interactive full-auto mode
    cliCmd = "codex --full-auto";
  }

  // Boot the CLI (runs persistently in the pane)
  tmuxSendCommand(target, cliCmd);
}

// ---------------------------------------------------------------------------
// isAgentAlive — check if an agent CLI process is running in the tmux pane
// ---------------------------------------------------------------------------

function isAgentAlive(slot: number, agentName: string): boolean {
  const target = tmuxTarget(slot, agentName);
  const panePid = tmuxPanePid(target);
  if (!panePid) return false;

  // Check child processes of the pane shell for agent CLIs
  const result = Bun.spawnSync(
    ["pgrep", "-P", String(panePid), "-f", "(claude|codex)"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return result.exitCode === 0;
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
  const feature = makeOrchestrationFeature(ctx, orchestration.feature);
  const projectDir = orchestrationProjectDir(workspaceRoot);
  const existing = readTmuxSlotState(ctx.slot, ctx.harnessDir);

  if (existing?.orchestration?.pid) killPid(existing.orchestration.pid);

  // Load config.yaml orchestration defaults and merge with adapter arg overrides.
  const orchCfg = loadConfigOrchestration();
  const configPhaseTimeouts = orchCfg?.phase_timeouts as Record<string, number> | undefined;
  if (configPhaseTimeouts && typeof configPhaseTimeouts === "object") {
    orchestration.config.timeouts = { ...configPhaseTimeouts, ...(orchestration.config.timeouts ?? {}) };
  }

  const setup = createWorktrees(projectDir, feature, orchestration.agents, undefined, ctx.slot, orchestration.mode);
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
    feature,
    orchestration.mode,
    projectDir,
    agents,
    { root: setup.rootWorktree, ...setup.agentWorktrees },
  );
  writeAgentMarkerFiles(setup.peerSyncDir, setup.agentWorktrees);

  // --- tmux-specific setup: create windows + ttyd + boot agent CLIs ---
  ensureTmuxSession();
  const ttydPids: Record<string, number> = {};
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    createTmuxWindow(ctx.slot, agent.name, agent.worktreePath);
    const role = agentPortRole(agent, i);
    ttydPids[agent.name] = startTtyd(ctx.slot, agent.name, role);
    // Boot persistent interactive agent CLI in the pane
    bootAgentCli(ctx.slot, agent, setup.peerSyncDir, "setup");
  }

  // --- Build orchestration state (no t3code threadIds) ---
  const state: OrchestrationState = {
    slot: ctx.slot,
    feature,
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
    taskId: ctx.taskId || undefined,
    slotTitle: options.title ?? `s${ctx.slot}.${ctx.taskId || feature}`,
    stagingRepo: (() => {
      const cfg = loadConfigSync();
      const proj = cfg.projects?.find((p) => {
        if (p.path) {
          const expanded = (String(p.path).startsWith("~/")
            ? join(process.env.HOME ?? "~", String(p.path).slice(2))
            : String(p.path)).replace(/\/+$/, "");
          if (projectDir === expanded || projectDir.startsWith(expanded + "/")) return true;
        }
        const dir = basename(projectDir).toLowerCase();
        const repoTail = String(p.repo ?? "").split("/").pop()?.toLowerCase() ?? "";
        return dir === String(p.name ?? "").toLowerCase() || dir === repoTail;
      });
      return proj?.staging_repo || undefined;
    })(),
  };
  persistState(state, ctx.harnessDir);

  const pid = await startOrchestrationProcess(ctx.slot, ctx.harnessDir, feature);
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

async function stop(ctx: AdapterContext): Promise<string> {
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

  // Kill tmux windows
  if (orchState) {
    killTmuxWindowsForSlot(ctx.slot, orchState.agents.map((a) => a.name));
    removePeerSyncSession(orchState.projectDir, orchState.feature);
    cleanupWorktrees(orchState.projectDir, orchState.feature, orchState.agents, ctx.slot, orchState.mode);
    removeOrchestrationState(ctx.slot, ctx.harnessDir);
  }

  removeTmuxSlotState(ctx.slot, ctx.harnessDir);
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
    md.keyValue("Feature", orchState.feature);
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
      const alive = isAgentAlive(ctx.slot, agent.name);
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

export { readState, start, stop, lastActivity, readTmuxSlotState, writeTmuxSlotState, removeTmuxSlotState };
export default adapter;
