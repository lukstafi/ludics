import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { harnessDir as defaultHarnessDir } from "../config.ts";
import type { T3ProviderKind } from "../t3code/types.ts";
import { nowEpoch, readJsonFile, writeJsonFile } from "./util.ts";
import type { Phase } from "./phases.ts";

export interface OrchestrationRef {
  stateFile: string;
  mode: "duo" | "pair";
  pid?: number;
}

export interface AgentConfig {
  name: string;
  provider: T3ProviderKind;
  role?: "coder" | "reviewer";
  model: string;
  branch: string;
  worktreePath: string;
}

export interface AgentRuntimeState {
  status: string;
  statusEpoch: number;
  statusMessage: string;
  prUrl: string | null;
  interrupted: boolean;
  latestTurnState?: "running" | "interrupted" | "completed" | "error" | "missing";
  latestTurnCompletedAt?: string | null;
}

export interface OrchestrationConfig {
  timeouts: Record<string, number>;
  pollInterval: number;
  enableClarify: boolean;
  enablePushback: boolean;
  enablePlan: boolean;
  enableGather: boolean;
  autoFinish: boolean;
  autoFinishTimeout: number;
  learningInterval: number;
  learningProductiveRoundsGap: number;
  useMagTailoring: boolean;
}

export interface OrchestrationState {
  slot: number;
  feature: string;
  mode: "duo" | "pair";
  phase: Phase;
  round: number;
  mergeRound: number;
  agents: AgentConfig[];
  agentStates: Record<string, AgentRuntimeState>;
  config: OrchestrationConfig;
  phaseStartedAt: number;
  startedAt: string;
  projectDir: string;
  rootWorktree: string;
  peerSyncDir: string;
  threadIds: Record<string, string>;
  mergeWinner?: string;
  taskId?: string;
  slotTitle?: string;
  lastLearningAt?: number;
  lastLearningRound?: number;
  confirmedPhase?: Phase | null;
  phaseDispatched?: boolean;
}

export const DEFAULT_TIMEOUTS: Record<string, number> = {
  work: 3600,
  review: 1800,
  gather: 600,
  clarify: 600,
  pushback: 600,
  plan: 600,
  "plan-review": 600,
  "update-docs": 600,
  "pr-create": 600,
  "merge-vote": 600,
  "merge-debate": 600,
  "merge-execute": 1800,
  "merge-review": 600,
  "merge-amend": 600,
  "suggest-refactor": 600,
  "final-merge": 1800,
};

export const DEFAULT_POLL_INTERVAL = 10;
export const DEFAULT_LEARNING_INTERVAL = 3600;
export const DEFAULT_LEARNING_PRODUCTIVE_ROUNDS_GAP = 3;
export const DEFAULT_AUTO_FINISH_TIMEOUT = 1800;

export function defaultOrchestrationConfig(
  overrides: Partial<OrchestrationConfig> = {},
): OrchestrationConfig {
  return {
    timeouts: { ...DEFAULT_TIMEOUTS, ...(overrides.timeouts ?? {}) },
    pollInterval: overrides.pollInterval ?? DEFAULT_POLL_INTERVAL,
    enableClarify: overrides.enableClarify ?? false,
    enablePushback: overrides.enablePushback ?? false,
    enablePlan: overrides.enablePlan ?? false,
    enableGather: overrides.enableGather ?? false,
    autoFinish: overrides.autoFinish ?? false,
    autoFinishTimeout: overrides.autoFinishTimeout ?? DEFAULT_AUTO_FINISH_TIMEOUT,
    learningInterval: overrides.learningInterval ?? DEFAULT_LEARNING_INTERVAL,
    learningProductiveRoundsGap:
      overrides.learningProductiveRoundsGap ?? DEFAULT_LEARNING_PRODUCTIVE_ROUNDS_GAP,
    useMagTailoring: overrides.useMagTailoring ?? false,
  };
}

export function orchestrationDir(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "orchestration");
}

export function stateFilePath(slot: number, harnessDir: string = defaultHarnessDir()): string {
  return join(orchestrationDir(harnessDir), `slot-${slot}.json`);
}

export function readOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): OrchestrationState | null {
  return readJsonFile<OrchestrationState>(stateFilePath(slot, harnessDir));
}

export function persistState(
  state: OrchestrationState,
  harnessDir: string = defaultHarnessDir(),
): void {
  writeJsonFile(stateFilePath(state.slot, harnessDir), state);
}

export function removeOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): void {
  const path = stateFilePath(slot, harnessDir);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function initAgentRuntimeState(names: string[]): Record<string, AgentRuntimeState> {
  const out: Record<string, AgentRuntimeState> = {};
  for (const name of names) {
    out[name] = {
      status: "idle",
      statusEpoch: nowEpoch(),
      statusMessage: "",
      prUrl: null,
      interrupted: false,
      latestTurnState: "missing",
      latestTurnCompletedAt: null,
    };
  }
  return out;
}
