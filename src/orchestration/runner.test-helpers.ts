// Testing pattern: always use spyOn(module, 'fn').mockImplementation(...)
// and restore in afterEach(() => { spy.mockRestore(); }).
// Never use Bun's global module mocking — it leaks across test files.
// See docs/testing-patterns.md for the full guide.
//
// Shared helpers for the `runner.*.test.ts` cluster files. Cluster files
// import whatever they need from this module; production imports remain in
// each cluster file alongside the describe blocks that use them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeJsonFile } from "../json.ts";
import { updateTurnLifecycle } from "./transport-t3code.ts";
import {
  defaultOrchestrationConfig,
  initAgentRuntimeState,
  orchestrationDir,
  stateFilePath,
  type AgentConfig,
  type AgentTurnLifecycle,
  type OrchestrationState,
} from "./state.ts";
import type { T3Snapshot, T3ThreadSession, T3LatestTurn } from "../t3code/types.ts";
import type { OrchestrationTransport } from "./transport.ts";

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ludics-runner-test-"));
}

/** Create a minimal git repo with one commit and an origin/main ref. */
export function makeGitRepo(): string {
  const tmpDir = makeTmpDir();
  const repoDir = join(tmpDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  Bun.spawnSync(["git", "init", "--initial-branch", "main"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "file.txt"), "hello");
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir });
  // Create origin/main ref pointing to current HEAD
  Bun.spawnSync(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir });
  return repoDir;
}

export function makeLifecycle(overrides: Partial<AgentTurnLifecycle> = {}): AgentTurnLifecycle {
  return {
    dispatchCommandId: "cmd-test",
    dispatchedAt: new Date(Date.now() - 60_000).toISOString(),
    phaseToken: "phase-test",
    observedTurnId: null,
    state: "dispatched",
    turnStartedAt: null,
    turnCompletedAt: null,
    completionSource: null,
    statusFileFingerprint: null,
    lastStopHookAt: null,
    stallDetectedAt: null,
    nudgeAttempts: 0,
    lastNudgeAt: null,
    preNudgeAssistantMessageId: null,
    ...overrides,
  };
}

/**
 * Options for the unified `makeState` factory.
 *
 * `setupOrchTestState` and the orch-CLI tests (`index.test.ts`) construct
 * states via this options-object form. Pre-existing positional callers
 * (`makeState({...overrides}, peerSyncDir?)`) keep working because the
 * implementation accepts unknown top-level fields as `Partial<OrchestrationState>`
 * overrides — so legacy `makeState({ phase: "plan", planMergeRound: 0 }, dir)`
 * continues to set `state.phase = "plan"` and `state.planMergeRound = 0`.
 */
export interface MakeStateOpts {
  slot?: number;
  agents?: AgentConfig[];
  phase?: OrchestrationState["phase"];
  taskId?: string;
  /**
   * If true (default), creates the peer-sync dir + `plans/` + `reviews/`
   * sub-dirs on disk. Set false for orch-CLI tests that don't exercise the
   * peer-sync pipeline.
   */
  preparePeerSync?: boolean;
  peerSyncDir?: string;
  overrides?: Partial<OrchestrationState>;
}

const MAKE_STATE_KNOWN_KEYS = new Set([
  "slot",
  "agents",
  "phase",
  "taskId",
  "preparePeerSync",
  "peerSyncDir",
  "overrides",
]);

/**
 * Unified `makeState` factory. Two call shapes:
 *
 *   - Unified (preferred): `makeState({ slot, agents, phase, taskId, preparePeerSync, peerSyncDir, overrides })`
 *   - Legacy positional:    `makeState(overrides, peerSyncDir?)` — kept for back-compat
 *     with ~70 existing callers in `runner.*.test.ts` / `phases.test.ts` / `skills.test.ts` /
 *     `wrong-filename-recovery.test.ts`. The implementation extracts unified-shape keys via
 *     destructuring; any remaining top-level fields are treated as `Partial<OrchestrationState>`
 *     overrides, preserving legacy semantics.
 */
export function makeState(
  opts: MakeStateOpts | Partial<OrchestrationState> = {},
  peerSyncDirArg?: string,
): OrchestrationState {
  const optsRecord = opts as Record<string, unknown>;
  const slot = (optsRecord.slot as number | undefined) ?? 1;
  const agents = (optsRecord.agents as AgentConfig[] | undefined) ?? [
    { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
    { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
  ];
  const phase = (optsRecord.phase as OrchestrationState["phase"] | undefined) ?? "work";
  const taskId = (optsRecord.taskId as string | undefined) ?? "feat";
  const preparePeerSync = (optsRecord.preparePeerSync as boolean | undefined) ?? true;
  const explicitPeerSyncDir =
    peerSyncDirArg ?? (optsRecord.peerSyncDir as string | undefined);
  const explicitOverrides =
    (optsRecord.overrides as Partial<OrchestrationState> | undefined) ?? {};

  // Any top-level keys not in MAKE_STATE_KNOWN_KEYS are treated as legacy-style
  // Partial<OrchestrationState> overrides, applied before explicit `overrides`.
  const legacyOverrides: Partial<OrchestrationState> = {};
  for (const k of Object.keys(optsRecord)) {
    if (!MAKE_STATE_KNOWN_KEYS.has(k)) {
      (legacyOverrides as Record<string, unknown>)[k] = optsRecord[k];
    }
  }

  let dir: string;
  if (preparePeerSync) {
    dir = explicitPeerSyncDir ?? makeTmpDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    mkdirSync(join(dir, "reviews"), { recursive: true });
  } else {
    dir = explicitPeerSyncDir ?? "/tmp/peer-sync";
  }

  const agentNames = agents.map((a) => a.name);

  return {
    slot,
    taskId,
    mode: "pair",
    phase,
    round: 1,
    mergeRound: 0,
    agents,
    agentStates: initAgentRuntimeState(agentNames),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: Math.floor(Date.now() / 1000),
    startedAt: new Date().toISOString(),
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir: dir,
    threadIds: agentNames.length === 2 && agentNames[0] === "coder" && agentNames[1] === "reviewer"
      ? { coder: "t1", reviewer: "t2" }
      : {},
    ...legacyOverrides,
    ...explicitOverrides,
  };
}

export interface SetupOrchTestStateResult {
  /** Tmp harness dir; also assigned to `process.env.LUDICS_HARNESS_DIR`. */
  harness: string;
  /** Parent of `harness`; available for test-side fixtures (e.g. worktrees). */
  tmpRoot: string;
  /** The state that was persisted to `stateFilePath(slot, harness)`. */
  state: OrchestrationState;
  /** Restores `LUDICS_HARNESS_DIR` (conditionally — never unconditional `delete`,
   *  per `lint-test-isolation` Rule 1) and `rmSync`'s only this call's `tmpRoot`. */
  cleanup: () => void;
}

/**
 * Set up scratch orch state for `runOrchestrationCli` / `orchDiff` /
 * `orchStatus` / `orchLog` tests: creates a tmp harness dir, sets
 * `LUDICS_HARNESS_DIR`, persists a minimal `OrchestrationState` to
 * `stateFilePath(slot, harness)`, and returns paths + a cleanup callback.
 *
 * Env capture happens at call time (not at module load), so multiple calls per
 * test stay independent.
 *
 * If the test needs `tmpRoot` to construct agent worktree paths *before* the
 * state is built, pre-create one with `makeTmpDir()` and pass it in via
 * `tmpRoot`; otherwise the helper allocates its own.
 */
export function setupOrchTestState(opts: {
  slot: number;
  agents: AgentConfig[];
  taskId?: string;
  phase?: OrchestrationState["phase"];
  preparePeerSync?: boolean;
  peerSyncDir?: string;
  overrides?: Partial<OrchestrationState>;
  /** Optional pre-existing root; if omitted the helper allocates via `mkdtempSync`. */
  tmpRoot?: string;
}): SetupOrchTestStateResult {
  const prevHarness = process.env.LUDICS_HARNESS_DIR;
  const tmpRoot = opts.tmpRoot ?? mkdtempSync(join(tmpdir(), "ludics-orch-test-"));
  const harness = join(tmpRoot, "harness");
  mkdirSync(orchestrationDir(harness), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = harness;

  const state = makeState({
    slot: opts.slot,
    agents: opts.agents,
    taskId: opts.taskId,
    phase: opts.phase,
    preparePeerSync: opts.preparePeerSync ?? false,
    peerSyncDir: opts.peerSyncDir,
    overrides: opts.overrides,
  });

  writeJsonFile(stateFilePath(state.slot, harness), state);

  const cleanup = (): void => {
    if (prevHarness === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = prevHarness;
    rmSync(tmpRoot, { recursive: true, force: true });
  };

  return { harness, tmpRoot, state, cleanup };
}

/**
 * Mark an agent as "done" for isAgentDone() by satisfying all three layers:
 * status, turn lifecycle, and phase artifact.
 */
export function markAgentDone(
  state: OrchestrationState,
  agentName: string,
  opts: {
    status?: string;
    artifactContent?: string;
    skipArtifact?: boolean;
    skipLifecycle?: boolean;
  } = {},
): void {
  const defaultStatus: Record<string, string> = {
    plan: "plan-done",
    "plan-merge": "plan-merge-done",
    "plan-review": "plan-review-done",
    review: "review-done",
    "pr-create": "pr-create-done",
  };
  state.agentStates[agentName].status = opts.status ?? defaultStatus[state.phase] ?? "done";

  if (!opts.skipLifecycle) {
    state.agentStates[agentName].turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-auto",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
  }

  if (!opts.skipArtifact) {
    const dir = state.peerSyncDir;
    const round = state.round;
    const pmr = state.planMergeRound ?? 0;
    let artifactPath: string | null = null;
    let defaultContent = "";

    switch (state.phase) {
      case "plan":
        artifactPath = join(dir, "plans", `round-${round}-${agentName}.md`);
        defaultContent = "# Plan\n";
        break;
      case "plan-merge":
        artifactPath = join(dir, "plans", `round-${round}-merged-${pmr}.md`);
        defaultContent = "# Merged Plan\n";
        break;
      case "plan-review":
        artifactPath = join(dir, "reviews", `plan-merge-${pmr}-${agentName}.md`);
        defaultContent = "APPROVE\n";
        break;
      case "review":
        artifactPath = join(dir, "reviews", `round-${round}-${agentName}.md`);
        defaultContent = "APPROVE\n";
        break;
      case "pr-create":
        artifactPath = join(dir, `${agentName}.pr`);
        defaultContent = "https://github.com/org/repo/pull/1\n";
        break;
    }

    if (artifactPath) {
      mkdirSync(join(artifactPath, ".."), { recursive: true });
      writeFileSync(artifactPath, opts.artifactContent ?? defaultContent);
    }
  }
}

/** Create a fully-initialized peer-sync dir for orchOnStop tests. */
export function makePeerSyncDir(
  worktrees: Record<string, string>,
  agentStatuses?: Record<string, string>,
): string {
  const dir = makeTmpDir();
  writeFileSync(join(dir, "phase"), "work");
  writeFileSync(join(dir, "phase-token"), "phase-test-token");
  writeFileSync(join(dir, "worktrees.json"), JSON.stringify(worktrees, null, 2));
  if (agentStatuses) {
    for (const [name, status] of Object.entries(agentStatuses)) {
      writeFileSync(join(dir, `${name}.status`), `${status}\n`);
    }
  }
  return dir;
}

/** Build a minimal T3Snapshot with the given threads. */
export function makeSnapshot(
  threads: Array<{
    id: string;
    session?: Partial<T3ThreadSession>;
    latestTurn?: Partial<T3LatestTurn> | null;
  }>,
): T3Snapshot {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 1,
    projects: [],
    threads: threads.map((t) => ({
      id: t.id,
      projectId: "p1",
      title: "test",
      modelSelection: { provider: "claudeAgent" as const, model: "opus-4" },
      runtimeMode: "full-access" as const,
      createdAt: now,
      updatedAt: now,
      session: t.session ? {
        threadId: t.id,
        status: "idle" as const,
        runtimeMode: "full-access" as const,
        updatedAt: now,
        ...t.session,
      } satisfies T3ThreadSession : null,
      latestTurn: t.latestTurn === undefined ? null : t.latestTurn ? {
        turnId: "turn-default",
        state: "completed" as const,
        requestedAt: now,
        ...t.latestTurn,
      } satisfies T3LatestTurn : null,
    })),
    updatedAt: now,
  };
}

/**
 * Create a mock OrchestrationTransport that wraps a T3Snapshot for testing.
 * The refreshAgentTransportState method replicates the T3CodeTransport behavior
 * using the provided snapshot data.
 */
export function makeMockTransport(snapshot: T3Snapshot | null): OrchestrationTransport {
  return {
    async sendTurn() { return "cmd-mock"; },
    async sendEnter() {},
    async refreshAgentTransportState(state: OrchestrationState) {
      // Replicate T3CodeTransport.refreshAgentTransportState using the snapshot
      const { agentParticipatesInPhase } = await import("./phases.ts");
      const { readStopHookRecord } = await import("./peer-sync.ts");
      const { emitEvent } = await import("../events.ts");

      for (const agent of state.agents) {
        if (!agentParticipatesInPhase(state, agent)) continue;

        const thread = snapshot?.threads.find((t) => t.id === state.threadIds[agent.name]) ?? null;
        const sessionStatus = thread?.session?.status ?? null;
        const activeTurnId = thread?.session?.activeTurnId ?? null;
        const latestTurn = thread?.latestTurn ?? null;

        const runtime = state.agentStates[agent.name]!;
        const lc = runtime.turnLifecycle;
        if (lc) {
          updateTurnLifecycle(lc, sessionStatus, activeTurnId, latestTurn);

          const stopRecord = readStopHookRecord(state.peerSyncDir, agent.name);
          if (stopRecord && stopRecord.phaseToken === lc.phaseToken) {
            lc.lastStopHookAt = stopRecord.observedAt;
            if (lc.state === "dispatched" && latestTurn?.state === "completed" && !activeTurnId) {
              lc.observedTurnId = latestTurn.turnId;
              lc.state = "settled";
              lc.turnCompletedAt = latestTurn.completedAt ?? new Date().toISOString();
              lc.completionSource = "stop-hook";
            }
          }

          // Snapshot reconciliation for stuck dispatched lifecycles
          if (lc.state === "dispatched" && !activeTurnId && latestTurn
              && (latestTurn.state === "completed" || latestTurn.state === "error")
              && sessionStatus !== null && sessionStatus !== undefined) {
            const turnRequested = latestTurn.requestedAt
              ? new Date(latestTurn.requestedAt).getTime()
              : 0;
            const dispatched = new Date(lc.dispatchedAt).getTime();
            if (turnRequested >= dispatched) {
              lc.observedTurnId = latestTurn.turnId;
              lc.state = latestTurn.state === "error" ? "error" : "settled";
              lc.turnCompletedAt = latestTurn.completedAt ?? new Date().toISOString();
              lc.completionSource = "snapshot";
              emitEvent({
                event_type: "orchestration_snapshot_reconcile",
                source: "orchestration",
                scope: "slot",
                slot: state.slot,
                task: state.taskId,
                agent: agent.name,
                message: `${agent.name}: reconciled stuck dispatched lifecycle via snapshot`,
              });
            }
          }

          // Post-nudge outcome classification
          if ((lc.stallDetectedAt ?? null) !== null && lc.state === "settled") {
            const nudgeAttempts = lc.nudgeAttempts ?? 0;
            if (nudgeAttempts > 0) {
              const currentAMId = latestTurn?.assistantMessageId ?? null;
              const preAMId = lc.preNudgeAssistantMessageId ?? null;
              const agentResponded = currentAMId !== null && currentAMId !== preAMId;
              emitEvent({
                event_type: agentResponded
                  ? "orchestration_nudge_settled_alive"
                  : "orchestration_nudge_settled_dead",
                source: "orchestration",
                scope: "slot",
                slot: state.slot,
                task: state.taskId,
                agent: agent.name,
                nudgeAttempts,
                message: `${agent.name}: stall resolved (${agentResponded ? "alive" : "dead"}) after ${nudgeAttempts} nudge(s)`,
              });
            }
            lc.stallDetectedAt = null;
            lc.nudgeAttempts = 0;
            lc.lastNudgeAt = null;
            lc.preNudgeAssistantMessageId = null;
          }
        }
      }
    },
    async interruptAgent() {},
  };
}

/** Noop transport for tests that don't need transport behavior. */
export const noopTransport: OrchestrationTransport = {
  async sendTurn() { return "cmd-noop"; },
  async sendEnter() {},
  async refreshAgentTransportState() {},
  async interruptAgent() {},
};
