import { readFileSync } from "fs";
import { join } from "path";
import { harnessDir } from "../config.ts";
import type { Phase } from "./phases.ts";
import { readAgentStatus, readPhaseToken, writeStopHookRecord } from "./peer-sync.ts";
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
    console.log(
      `${agent.name}: status=${runtime?.status ?? "unknown"} provider=${agent.provider} model=${agent.model}${effort} pr=${runtime?.prUrl ?? "-"}${lcInfo}`,
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
 * Usage: ludics orch on-stop <cwd> <peer-sync-dir> <hook-event-name>
 *
 * Writes a stop-hook record to .peer-sync/<agent>.stop.json so the runner
 * can detect turn completion via push rather than waiting for the next poll.
 */
function orchOnStop(args: string[]): void {
  const [cwd, peerSyncDir, hookEventName] = args;
  if (!cwd || !peerSyncDir) {
    console.error("usage: ludics orch on-stop <cwd> <peer-sync-dir> [hook-event-name]");
    process.exit(1);
  }

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
  try {
    const worktrees = JSON.parse(readFileSync(join(peerSyncDir, "worktrees.json"), "utf-8"));
    for (const [name, path] of Object.entries(worktrees)) {
      if (name === "root") continue;
      if (typeof path === "string" && cwd.startsWith(path)) {
        agentName = name;
        break;
      }
    }
  } catch {
    // Can't read worktrees — try to identify by status files.
  }

  // Fallback: check coder.status and reviewer.status, pick whichever is active.
  if (!agentName) {
    for (const candidate of ["coder", "reviewer"]) {
      const status = readAgentStatus(peerSyncDir, candidate);
      if (status.status !== "unknown" && status.status !== "idle") {
        agentName = candidate;
        break;
      }
    }
  }

  if (!agentName) return; // Unable to identify agent.

  writeStopHookRecord(peerSyncDir, {
    agent: agentName,
    provider: "unknown", // We don't know the provider from the hook context.
    phase,
    phaseToken,
    observedAt: isoNow(),
    cwd,
    hookEventName: hookEventName ?? "",
  });
}

function readFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
