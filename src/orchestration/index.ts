import { readFileSync } from "fs";
import { join } from "path";
import { harnessDir } from "../config.ts";
import type { Phase } from "./phases.ts";
import { confirmPhase, interruptCurrentPhase, runOrchestrationForSlot, skipToPhase } from "./runner.ts";
import { readOrchestrationState } from "./state.ts";

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
    console.log(
      `${agent.name}: status=${runtime?.status ?? "unknown"} provider=${agent.provider} model=${agent.model}${effort} pr=${runtime?.prUrl ?? "-"}`,
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
    default:
      throw new Error(`unknown orch subcommand: ${sub}`);
  }
}
