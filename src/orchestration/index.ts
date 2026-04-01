import { readFileSync } from "fs";
import { join } from "path";
import { harnessDir } from "../config.ts";
import type { Phase } from "./phases.ts";
import { readAgentMarkerFile, readAgentStatus, readPhaseToken, writeStopHookRecord } from "./peer-sync.ts";
import { confirmPhase, interruptCurrentPhase, runOrchestrationForSlot, skipToPhase } from "./runner.ts";
import { readOrchestrationState } from "./state.ts";
import { isoNow } from "./util.ts";

function requireSlot(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error("slot number required");
  return parseInt(raw, 10);
}

function orchStatus(slot: number): void {
  const state = readOrchestrationState(slot);
  if (!state) throw new Error(`orchestration state not found for slot ${slot}`);
  console.log(`slot: ${state.slot}`);
  console.log(`feature: ${state.feature}`);
  console.log(`mode: ${state.mode}`);
  console.log(`phase: ${state.phase}`);
  console.log(`round: ${state.round}`);
  console.log(`mergeRound: ${state.mergeRound}`);
  for (const agent of state.agents) {
    const runtime = state.agentStates[agent.name];
    const effort = agent.thinkingEffort ? ` thinking=${agent.thinkingEffort}` : "";
    const lc = runtime?.turnLifecycle;
    const lcInfo = lc ? ` turn=${lc.state}${lc.observedTurnId ? ` id=${lc.observedTurnId.slice(0, 8)}` : ""}` : "";
    const stallInfo = lc?.stallDetectedAt
      ? ` STALL(nudges=${lc.nudgeAttempts ?? 0}, since=${lc.stallDetectedAt})`
      : "";
    console.log(
      `${agent.name}: status=${runtime?.status ?? "unknown"} provider=${agent.provider} model=${agent.model}${effort} pr=${runtime?.prUrl ?? "-"}${lcInfo}${stallInfo}`,
    );
  }
  console.log("timeouts:");
  for (const [phase, secs] of Object.entries(state.config.timeouts)) {
    console.log(`  ${phase}: ${secs}s`);
  }
}

function orchLog(slot: number): void {
  const file = join(harnessDir(), "journal", "events.jsonl");
  const content = readFileSync(file, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event_type !== "phase_transition") continue;
      if (event.slot !== slot) continue;
      console.log(line);
    } catch {
      // ignore malformed lines
    }
  }
}

export async function runOrchestrationCli(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status":
      orchStatus(requireSlot(args[1]));
      return;
    case "confirm": {
      const state = confirmPhase(requireSlot(args[1]));
      console.log(`confirmed ${state.phase} for slot ${state.slot}`);
      return;
    }
    case "interrupt": {
      const state = await interruptCurrentPhase(requireSlot(args[1]));
      console.log(`interrupted ${state.phase} for slot ${state.slot}`);
      return;
    }
    case "skip": {
      const phase = args[2] as Phase | undefined;
      if (!phase) throw new Error("phase required");
      const state = skipToPhase(requireSlot(args[1]), phase);
      console.log(`slot ${state.slot} now in ${state.phase}`);
      return;
    }
    case "log":
      orchLog(requireSlot(args[1]));
      return;
    case "run-internal":
      await runOrchestrationForSlot(requireSlot(args[1]));
      return;
    case "on-stop":
      orchOnStop(args.slice(1));
      return;
    default:
      throw new Error(`unknown orch subcommand: ${sub}`);
  }
}

/**
 * Handle a stop-hook invocation from an orchestration agent.
 * Usage: ludics orch on-stop <cwd> [peer-sync-dir] [hook-event-name]
 *
 * Writes a stop-hook record to .peer-sync/<agent>.stop.json so the runner
 * can detect turn completion via push rather than waiting for the next poll.
 *
 * Peer-sync directory resolution: CLI arg (if valid) > LUDICS_PEER_SYNC_DIR
 * env var > give up.  The shell hook passes an empty-string placeholder for
 * the CLI arg when it couldn't resolve the dir, so the env var kicks in.
 */
export function orchOnStop(args: string[]): void {
  const [cwd, cliPeerSyncDir, hookEventName] = args;
  if (!cwd) {
    console.error("usage: ludics orch on-stop <cwd> [peer-sync-dir] [hook-event-name]");
    process.exit(1);
  }

  // Resolve peerSyncDir: CLI arg (if valid) > env var > give up.
  let peerSyncDir = cliPeerSyncDir || undefined;
  if (!peerSyncDir || !readFileIfExists(join(peerSyncDir, "phase"))) {
    const envDir = process.env.LUDICS_PEER_SYNC_DIR;
    if (envDir && readFileIfExists(join(envDir, "phase"))) {
      peerSyncDir = envDir;
    }
  }
  if (!peerSyncDir) return; // No active orchestration found.

  // Determine which agent this stop belongs to by checking which agent's
  // worktree matches the cwd.
  const phase = readFileIfExists(join(peerSyncDir, "phase"));
  const phaseToken = readPhaseToken(peerSyncDir);
  if (!phase || !phaseToken) return; // Not an active orchestration session.

  // Try to identify the agent: read worktrees.json and match cwd.
  // Skip the "root" entry — it's typically a prefix of all worktree paths
  // and would incorrectly match every cwd, producing a "root.stop.json"
  // that the runner never reads.
  let agentName: string | null = null;
  let worktreeAgentNames: string[] = [];
  try {
    const worktrees = JSON.parse(readFileSync(join(peerSyncDir, "worktrees.json"), "utf-8")) as Record<string, unknown>;
    worktreeAgentNames = Object.keys(worktrees).filter((n) => n !== "root");
    for (const [name, path] of Object.entries(worktrees)) {
      if (name === "root") continue;
      if (typeof path === "string" && cwd.startsWith(path)) {
        agentName = name;
        break;
      }
    }
  } catch {
    // Can't read worktrees — fall through to env-var check.
  }

  // Marker-file attribution: .ludics-orchestration.json written by orchestration setup.
  if (!agentName) {
    const marker = readAgentMarkerFile(cwd);
    if (marker && worktreeAgentNames.includes(marker.agentName)) {
      agentName = marker.agentName;
    }
  }

  // Env-var attribution: the agent name set externally (e.g. testing).
  if (!agentName) {
    const envAgent = process.env.LUDICS_AGENT_NAME;
    if (envAgent && worktreeAgentNames.includes(envAgent)) {
      agentName = envAgent;
    }
  }

  // Last resort: check status files, but ONLY accept if exactly one agent is
  // non-idle.  When multiple agents are active, attribution is ambiguous and
  // we refuse to write — the runner will detect completion via snapshot polling.
  if (!agentName && worktreeAgentNames.length > 0) {
    const activeAgents: string[] = [];
    for (const candidate of worktreeAgentNames) {
      const status = readAgentStatus(peerSyncDir, candidate);
      if (status.status !== "unknown" && status.status !== "idle") {
        activeAgents.push(candidate);
      }
    }
    if (activeAgents.length === 1) {
      agentName = activeAgents[0]!;
    }
    // If 0 or 2+ agents are active, attribution is ambiguous — refuse.
  }

  if (!agentName) return; // Unable to unambiguously identify agent.

  writeStopHookRecord(peerSyncDir, {
    agent: agentName,
    provider: "unknown", // We don't know the provider from the hook context.
    phase,
    phaseToken,
    observedAt: isoNow(),
    cwd,
    hookEventName: hookEventName ?? "",
  });

  // Auto-commit agent changes at end of turn (all adapters).
  try {
    autoCommitOnStop(cwd, agentName, phase);
  } catch {
    // Non-critical: don't break the stop hook if auto-commit fails
  }
}

/**
 * Auto-commit all changes in the agent's worktree at end of turn.
 * Ported from agent-duo's `lib_commit_round()` pattern.
 */
function autoCommitOnStop(cwd: string, agent: string, phase: string): void {
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
  const output = status.stdout.toString().trim();
  if (!output) return; // nothing to commit

  Bun.spawnSync(["git", "add", "-A"], { cwd, stdout: "pipe", stderr: "pipe" });
  const msg = `ludics: auto-commit after ${phase} (${agent})`;
  Bun.spawnSync(["git", "commit", "-m", msg, "--no-verify"], { cwd, stdout: "pipe", stderr: "pipe" });
}

function readFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
