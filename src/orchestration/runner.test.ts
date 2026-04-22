import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isAgentDone, pairReviewVerdict } from "./phases.ts";
import { updateTurnLifecycle, T3CodeTransport } from "./transport-t3code.ts";
import { refreshAgentStatuses, maybePostCodexReviewRequests, checkAndRedispatchPrComments, autoCommitAgent, autoCommitAllAgents, detectAndNudgeHungAgents, interruptAgent, applyPhaseSideEffects, verifyPhaseOutcome, PR_CREATE_GATE, FINAL_MERGE_GATE, handleVerifyFailure, getFirstPrUrl, preparePhaseRedispatch, skipToPhase, MAX_VERIFY_ATTEMPTS, checkZeroCommitsAutoBailOut, isWorktreeNoOp, validatePreviousPhaseArtifacts, validateAgentPrFiles, resetPrCommentsState, type PreviousPhaseContext } from "./runner.ts";
import { evaluateTransition } from "./phases.ts";
import * as notify from "../notify.ts";
import * as peerSync from "./peer-sync.ts";
import * as events from "../events.ts";
import * as github from "./github.ts";
import * as config from "../config.ts";
import * as spawn from "../spawn.ts";
import * as stateMod from "./state.ts";
import { orchOnStop } from "./index.ts";
import { readStopHookRecord, writeStopHookRecord, writeAgentMarkerFiles, readAgentMarkerFile } from "./peer-sync.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, persistState, type AgentTurnLifecycle, type OrchestrationState } from "./state.ts";
import type { T3Snapshot, T3ThreadSession, T3LatestTurn } from "../t3code/types.ts";
import type { OrchestrationTransport } from "./transport.ts";

setDefaultTimeout(20_000);

// Testing pattern: always use spyOn(module, 'fn').mockImplementation(...)
// and restore in afterEach(() => { spy.mockRestore(); }).
// Never use Bun's global module mocking — it leaks across test files.
// See docs/testing-patterns.md for the full guide.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ludics-runner-test-"));
}

/** Create a minimal git repo with one commit and an origin/main ref. */
function makeGitRepo(): string {
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

function makeLifecycle(overrides: Partial<AgentTurnLifecycle> = {}): AgentTurnLifecycle {
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

function makeState(
  overrides: Partial<OrchestrationState> = {},
  peerSyncDir?: string,
): OrchestrationState {
  const dir = peerSyncDir ?? makeTmpDir();
  mkdirSync(join(dir, "plans"), { recursive: true });
  mkdirSync(join(dir, "reviews"), { recursive: true });
  return {
    slot: 1,
    taskId: "feat",
    mode: "pair",
    phase: "work",
    round: 1,
    mergeRound: 0,
    agents: [
      { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
    ],
    agentStates: initAgentRuntimeState(["coder", "reviewer"]),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: Math.floor(Date.now() / 1000),
    startedAt: new Date().toISOString(),
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir: dir,
    threadIds: { coder: "t1", reviewer: "t2" },
    ...overrides,
  };
}

/**
 * Mark an agent as "done" for isAgentDone() by satisfying all three layers:
 * status, turn lifecycle, and phase artifact.
 */
function markAgentDone(
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
function makePeerSyncDir(
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
function makeSnapshot(
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
function makeMockTransport(snapshot: T3Snapshot | null): OrchestrationTransport {
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
const noopTransport: OrchestrationTransport = {
  async sendTurn() { return "cmd-noop"; },
  async sendEnter() {},
  async refreshAgentTransportState() {},
  async interruptAgent() {},
};

// ===========================================================================
// updateTurnLifecycle — direct tests of the state machine
// ===========================================================================

describe("updateTurnLifecycle", () => {
  test("dispatched → running when activeTurnId appears", () => {
    const lc = makeLifecycle({ state: "dispatched" });
    updateTurnLifecycle(lc, "running", "turn-abc", null);
    expect(lc.state).toBe("running");
    expect(lc.observedTurnId).toBe("turn-abc");
    expect(lc.turnStartedAt).not.toBeNull();
  });

  test("dispatched stays dispatched when no activeTurnId", () => {
    const lc = makeLifecycle({ state: "dispatched" });
    updateTurnLifecycle(lc, "idle", null, null);
    expect(lc.state).toBe("dispatched");
  });

  test("dispatched stays dispatched with completed latestTurn (no snapshot fast-complete)", () => {
    const lc = makeLifecycle({ state: "dispatched" });
    // A completed turn in the snapshot should NOT settle the lifecycle from dispatched.
    updateTurnLifecycle(lc, "idle", null, {
      turnId: "turn-completed",
      state: "completed",
      completedAt: new Date().toISOString(),
    });
    expect(lc.state).toBe("dispatched");
    expect(lc.observedTurnId).toBeNull();
  });

  test("running → settled when activeTurnId clears", () => {
    const lc = makeLifecycle({
      state: "running",
      observedTurnId: "turn-abc",
      turnStartedAt: new Date().toISOString(),
    });
    const completedAt = new Date().toISOString();
    updateTurnLifecycle(lc, "idle", null, {
      turnId: "turn-abc",
      state: "completed",
      completedAt,
    });
    expect(lc.state).toBe("settled");
    expect(lc.turnCompletedAt).toBe(completedAt);
    expect(lc.completionSource).toBe("snapshot");
  });

  test("running → error when session status is error", () => {
    const lc = makeLifecycle({
      state: "running",
      observedTurnId: "turn-abc",
    });
    updateTurnLifecycle(lc, "error", null, null);
    expect(lc.state).toBe("error");
    expect(lc.completionSource).toBe("snapshot");
  });

  test("running does NOT transition on null sessionStatus (snapshot fetch failure)", () => {
    const lc = makeLifecycle({
      state: "running",
      observedTurnId: "turn-abc",
    });
    updateTurnLifecycle(lc, null, null, null);
    expect(lc.state).toBe("running");
  });

  test("settled is a terminal state — no further transitions", () => {
    const lc = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-abc",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    updateTurnLifecycle(lc, "running", "turn-new", null);
    expect(lc.state).toBe("settled");
  });

  test("error is a terminal state — no further transitions", () => {
    const lc = makeLifecycle({
      state: "error",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    updateTurnLifecycle(lc, "running", "turn-new", null);
    expect(lc.state).toBe("error");
  });

  // --- Edge cases (task-41f81ece) ---

  test("dispatched stays dispatched with sessionStatus 'starting'", () => {
    const lc = makeLifecycle({ state: "dispatched" });
    updateTurnLifecycle(lc, "starting", null, null);
    expect(lc.state).toBe("dispatched");
  });

  test("dispatched stays dispatched with sessionStatus 'error' (never reached running)", () => {
    const lc = makeLifecycle({ state: "dispatched" });
    updateTurnLifecycle(lc, "error", null, null);
    expect(lc.state).toBe("dispatched");
    // The dispatched case only transitions on sessionStatus === "running" && activeTurnId.
    expect(lc.observedTurnId).toBeNull();
  });

  test("running → settled when sessionStatus is not 'running' despite activeTurnId present", () => {
    const lc = makeLifecycle({
      state: "running",
      observedTurnId: "turn-x",
      turnStartedAt: new Date().toISOString(),
    });
    // sessionStatus "ready" !== "running" triggers the guard even though activeTurnId is present.
    updateTurnLifecycle(lc, "ready", "turn-x", null);
    expect(lc.state).toBe("settled");
    expect(lc.completionSource).toBe("snapshot");
  });

  test("running → settled uses isoNow() when latestTurn is null", () => {
    const lc = makeLifecycle({
      state: "running",
      observedTurnId: "turn-y",
      turnStartedAt: new Date().toISOString(),
    });
    updateTurnLifecycle(lc, "idle", null, null);
    expect(lc.state).toBe("settled");
    expect(lc.turnCompletedAt).not.toBeNull();
    // Should be a valid ISO timestamp.
    expect(new Date(lc.turnCompletedAt!).getTime()).not.toBeNaN();
    expect(lc.completionSource).toBe("snapshot");
  });

  test("running stays running when activeTurnId present AND sessionStatus 'running'", () => {
    const lc = makeLifecycle({
      state: "running",
      observedTurnId: "turn-abc",
      turnStartedAt: new Date().toISOString(),
    });
    updateTurnLifecycle(lc, "running", "turn-abc", null);
    expect(lc.state).toBe("running");
  });
});

// ===========================================================================
// Stop-hook fast-complete path (refreshAgentStatuses logic)
// ===========================================================================

describe("stop-hook fast-complete path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stop-hook with matching phaseToken settles a dispatched lifecycle", () => {
    // Simulate the stop-hook settlement path from refreshAgentStatuses.
    // This is the code from runner.ts lines 83-103.
    const lc = makeLifecycle({
      state: "dispatched",
      phaseToken: "phase-match",
    });
    const latestTurn = {
      turnId: "turn-fast",
      state: "completed" as const,
      completedAt: new Date().toISOString(),
    };
    const activeTurnId: string | null = null;

    // First, updateTurnLifecycle won't settle it (no snapshot fast-complete).
    updateTurnLifecycle(lc, "idle", activeTurnId, latestTurn);
    expect(lc.state).toBe("dispatched");

    // Now simulate the stop-hook record check.
    const stopRecord = {
      agent: "coder",
      provider: "unknown",
      phase: "work",
      phaseToken: "phase-match",
      observedAt: new Date().toISOString(),
      cwd: "/tmp/a",
      hookEventName: "Stop",
    };

    // This mirrors the logic in refreshAgentStatuses:
    if (stopRecord.phaseToken === lc.phaseToken) {
      lc.lastStopHookAt = stopRecord.observedAt;
      if (lc.state === "dispatched" && latestTurn.state === "completed" && !activeTurnId) {
        lc.observedTurnId = latestTurn.turnId;
        lc.state = "settled";
        lc.turnCompletedAt = latestTurn.completedAt;
        lc.completionSource = "stop-hook";
      }
    }

    expect(lc.state).toBe("settled");
    expect(lc.observedTurnId).toBe("turn-fast");
    expect(lc.completionSource).toBe("stop-hook");
  });

  test("stop-hook with wrong phaseToken does NOT settle lifecycle", () => {
    const lc = makeLifecycle({
      state: "dispatched",
      phaseToken: "phase-current",
    });

    const stopRecord = {
      phaseToken: "phase-stale",
      observedAt: new Date().toISOString(),
    };

    // Stale stop hook should not trigger settlement.
    if (stopRecord.phaseToken === lc.phaseToken) {
      lc.state = "settled"; // This should NOT execute.
    }

    expect(lc.state).toBe("dispatched");
  });
});

// ===========================================================================
// orchOnStop — real handler tests
// ===========================================================================

describe("orchOnStop handler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Clean up env vars.
    delete process.env.LUDICS_AGENT_NAME;
  });

  test("worktree path matching writes stop record for correct agent", () => {
    const agentWorktree = join(tmpDir, "worktree-alpha");
    mkdirSync(agentWorktree, { recursive: true });

    const peerSyncDir = makePeerSyncDir({
      root: tmpDir,
      "agent-alpha": agentWorktree,
      "agent-beta": join(tmpDir, "worktree-beta"),
    });

    orchOnStop([agentWorktree, peerSyncDir, "Stop"]);

    const record = readStopHookRecord(peerSyncDir, "agent-alpha");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-alpha");
    expect(record!.phaseToken).toBe("phase-test-token");
    expect(record!.cwd).toBe(agentWorktree);
  });

  test("nested cwd under worktree resolves to correct agent", () => {
    const agentWorktree = join(tmpDir, "worktree-beta");
    const nestedCwd = join(agentWorktree, "src", "components");
    mkdirSync(nestedCwd, { recursive: true });

    const peerSyncDir = makePeerSyncDir({
      root: tmpDir,
      "agent-alpha": join(tmpDir, "worktree-alpha"),
      "agent-beta": agentWorktree,
    });

    orchOnStop([nestedCwd, peerSyncDir, "Stop"]);

    const record = readStopHookRecord(peerSyncDir, "agent-beta");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-beta");
  });

  test("marker-file attribution resolves agent name", () => {
    const agentWorktree = join(tmpDir, "shared-worktree");
    mkdirSync(agentWorktree, { recursive: true });

    const peerSyncDir = makePeerSyncDir({
      root: agentWorktree,
      coder: agentWorktree,
      reviewer: agentWorktree,
    }, {
      coder: "work-active|1|coding",
      reviewer: "idle|0|awaiting",
    });

    // Both agents share the same worktree (pair mode).
    // Write a marker file to disambiguate.
    writeAgentMarkerFiles(peerSyncDir, { coder: agentWorktree });

    orchOnStop([agentWorktree, peerSyncDir, "Stop"]);

    // In pair mode with shared worktree, path matching matches both.
    // The first match wins (coder comes before reviewer alphabetically
    // in Object.entries). But marker file provides the coder name too.
    const coderRecord = readStopHookRecord(peerSyncDir, "coder");
    expect(coderRecord).not.toBeNull();
    expect(coderRecord!.agent).toBe("coder");
  });

  test("env var LUDICS_AGENT_NAME resolves when path matching fails", () => {
    const unknownCwd = join(tmpDir, "unknown-dir");
    mkdirSync(unknownCwd, { recursive: true });

    const peerSyncDir = makePeerSyncDir({
      root: join(tmpDir, "root"),
      "agent-x": join(tmpDir, "worktree-x"),
    });

    // Set env var for attribution.
    process.env.LUDICS_AGENT_NAME = "agent-x";

    orchOnStop([unknownCwd, peerSyncDir, "Stop"]);

    const record = readStopHookRecord(peerSyncDir, "agent-x");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-x");
  });

  test("ambiguous multi-agent: no stop record when both active and path unmatched", () => {
    const unknownCwd = join(tmpDir, "unknown-dir");
    mkdirSync(unknownCwd, { recursive: true });

    const peerSyncDir = makePeerSyncDir(
      {
        root: join(tmpDir, "root"),
        "agent-a": join(tmpDir, "worktree-a"),
        "agent-b": join(tmpDir, "worktree-b"),
      },
      {
        "agent-a": "work-active|1|working",
        "agent-b": "work-active|1|working",
      },
    );

    orchOnStop([unknownCwd, peerSyncDir, "Stop"]);

    // With two active agents and no path match, no stop record should be written.
    expect(readStopHookRecord(peerSyncDir, "agent-a")).toBeNull();
    expect(readStopHookRecord(peerSyncDir, "agent-b")).toBeNull();
  });

  test("single active agent fallback writes stop record when path unmatched", () => {
    const unknownCwd = join(tmpDir, "unknown-dir");
    mkdirSync(unknownCwd, { recursive: true });

    const peerSyncDir = makePeerSyncDir(
      {
        root: join(tmpDir, "root"),
        "agent-a": join(tmpDir, "worktree-a"),
        "agent-b": join(tmpDir, "worktree-b"),
      },
      {
        "agent-a": "work-active|1|working",
        "agent-b": "idle|0|awaiting",
      },
    );

    orchOnStop([unknownCwd, peerSyncDir, "Stop"]);

    const record = readStopHookRecord(peerSyncDir, "agent-a");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-a");
  });

  test("no phase file → no stop record", () => {
    const cwd = join(tmpDir, "cwd");
    mkdirSync(cwd, { recursive: true });
    const peerSyncDir = makeTmpDir();
    // No phase file written.
    writeFileSync(join(peerSyncDir, "phase-token"), "token");

    orchOnStop([cwd, peerSyncDir, "Stop"]);

    // No stop record should be written when there's no active phase.
    expect(existsSync(join(peerSyncDir, "coder.stop.json"))).toBe(false);
  });
});

// ===========================================================================
// refreshAgentStatuses — integration tests (task-41f81ece)
// ===========================================================================

describe("refreshAgentStatuses", () => {
  let tmpDir: string;
  let origHarnessDir: string | undefined;
  let eventSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = join(tmpDir, "harness");
    // Mock emitEvent to prevent test events leaking into production journal
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
    eventSpy.mockRestore();
  });

  test("null snapshot does not crash or transition dispatched lifecycle", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched" });

    await refreshAgentStatuses(state, makeMockTransport(null));

    expect(state.agentStates.coder.turnLifecycle!.state).toBe("dispatched");
  });

  test("null snapshot does not downgrade running lifecycle", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date().toISOString(),
    });

    await refreshAgentStatuses(state, makeMockTransport(null));

    // Null sessionStatus triggers the null guard — lifecycle stays running.
    expect(state.agentStates.coder.turnLifecycle!.state).toBe("running");
  });

  test("snapshot with running session transitions dispatched → running", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched" });

    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "running", activeTurnId: "turn-1" },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.state).toBe("running");
    expect(lc.observedTurnId).toBe("turn-1");
  });

  test("snapshot with settled session transitions running → settled", async () => {
    const completedAt = new Date().toISOString();
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date().toISOString(),
    });

    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "ready", activeTurnId: null },
      latestTurn: { turnId: "turn-1", state: "completed", completedAt },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.state).toBe("settled");
    expect(lc.completionSource).toBe("snapshot");
    expect(lc.turnCompletedAt).toBe(completedAt);
  });

  test("stop-hook record with matching phaseToken settles dispatched lifecycle", async () => {
    const completedAt = new Date().toISOString();
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    const phaseToken = "phase-test";
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched", phaseToken });

    // Write stop-hook record with matching phaseToken.
    writeStopHookRecord(peerSyncDir, {
      agent: "coder",
      provider: "unknown",
      phase: "work",
      phaseToken,
      observedAt: new Date().toISOString(),
      cwd: tmpDir,
      hookEventName: "Stop",
    });

    // Snapshot shows completed turn with no active turn.
    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "ready", activeTurnId: null },
      latestTurn: { turnId: "turn-fast", state: "completed", completedAt },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.state).toBe("settled");
    expect(lc.completionSource).toBe("stop-hook");
    expect(lc.observedTurnId).toBe("turn-fast");
  });

  test("stop-hook record with wrong phaseToken is ignored", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "dispatched",
      phaseToken: "phase-current",
    });

    // Write stop-hook record with WRONG phaseToken.
    writeStopHookRecord(peerSyncDir, {
      agent: "coder",
      provider: "unknown",
      phase: "work",
      phaseToken: "phase-stale",
      observedAt: new Date().toISOString(),
      cwd: tmpDir,
      hookEventName: "Stop",
    });

    // Use a requestedAt BEFORE the dispatch time to simulate a turn from a prior
    // phase/dispatch. This ensures the snapshot reconciliation guard (which checks
    // requestedAt >= dispatchedAt) correctly rejects this stale turn.
    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: "turn-x",
        state: "completed",
        completedAt: new Date().toISOString(),
        requestedAt: new Date(Date.now() - 120_000).toISOString(), // before dispatchedAt
      },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    // Stale phaseToken AND stale requestedAt — lifecycle stays dispatched.
    expect(state.agentStates.coder.turnLifecycle!.state).toBe("dispatched");
  });

  test("fast-complete with latestTurn.completedAt null uses isoNow() fallback", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    const phaseToken = "phase-test";
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched", phaseToken });

    writeStopHookRecord(peerSyncDir, {
      agent: "coder",
      provider: "unknown",
      phase: "work",
      phaseToken,
      observedAt: new Date().toISOString(),
      cwd: tmpDir,
      hookEventName: "Stop",
    });

    // latestTurn has completedAt: null.
    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "ready", activeTurnId: null },
      latestTurn: { turnId: "turn-fast", state: "completed", completedAt: null },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.state).toBe("settled");
    expect(lc.turnCompletedAt).not.toBeNull();
    // Should be a valid ISO timestamp (from isoNow() fallback).
    expect(new Date(lc.turnCompletedAt!).getTime()).not.toBeNaN();
  });

  test("merge marker overrides agent status to 'merged'", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);

    // Write merge marker.
    writeFileSync(join(peerSyncDir, "coder.merged"), "1");

    await refreshAgentStatuses(state, makeMockTransport(null));

    expect(state.agentStates.coder.status).toBe("merged");
  });

  test("terminal lifecycle states remain terminal after refresh", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-old",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });

    // Snapshot shows a new running session — should NOT revert settled state.
    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "running", activeTurnId: "turn-new" },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    expect(state.agentStates.coder.turnLifecycle!.state).toBe("settled");
  });

  test("inconsistency: peer-sync done + lifecycle dispatched emits warning", async () => {
    // This test verifies actual event emission to the journal file,
    // so restore the real emitEvent for this test only.
    eventSpy.mockRestore();

    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched" });

    await refreshAgentStatuses(state, makeMockTransport(null));

    // Read the events journal to verify a warning was emitted.
    const eventsPath = join(tmpDir, "harness", "journal", "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    const eventsData = readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const warning = eventsData.find((e: { event_type?: string }) => e.event_type === "orchestration_warning");
    expect(warning).toBeDefined();
    expect(warning.message).toContain('peer-sync says "done"');
    expect(warning.message).toContain('"dispatched"');

    // Re-enable mock for afterEach cleanup
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });
});

// ===========================================================================
// orchOnStop env-var fallback tests (task-41f81ece)
// ===========================================================================

describe("orchOnStop env-var fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LUDICS_AGENT_NAME;
    delete process.env.LUDICS_PEER_SYNC_DIR;
  });

  test("LUDICS_PEER_SYNC_DIR env var used when CLI peerSyncDir is empty string", () => {
    const agentWorktree = join(tmpDir, "worktree-alpha");
    mkdirSync(agentWorktree, { recursive: true });

    const peerSyncDir = makePeerSyncDir({
      root: tmpDir,
      "agent-alpha": agentWorktree,
    });

    process.env.LUDICS_PEER_SYNC_DIR = peerSyncDir;

    // Pass empty string for peerSyncDir — should fall back to env var.
    orchOnStop([agentWorktree, "", "Stop"]);

    const record = readStopHookRecord(peerSyncDir, "agent-alpha");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-alpha");
    expect(record!.phaseToken).toBe("phase-test-token");
  });

  test("LUDICS_PEER_SYNC_DIR env var used when CLI peerSyncDir has no phase file", () => {
    const agentWorktree = join(tmpDir, "worktree-beta");
    mkdirSync(agentWorktree, { recursive: true });

    const stalePeerSync = makeTmpDir();
    // No phase file in stalePeerSync — it's stale.
    writeFileSync(join(stalePeerSync, "phase-token"), "stale-token");

    const validPeerSync = makePeerSyncDir({
      root: tmpDir,
      "agent-beta": agentWorktree,
    });

    process.env.LUDICS_PEER_SYNC_DIR = validPeerSync;

    orchOnStop([agentWorktree, stalePeerSync, "Stop"]);

    const record = readStopHookRecord(validPeerSync, "agent-beta");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-beta");
  });

  test("CLI peerSyncDir takes precedence over env var", () => {
    const agentWorktree = join(tmpDir, "worktree-gamma");
    mkdirSync(agentWorktree, { recursive: true });

    const cliPeerSync = makePeerSyncDir({
      root: tmpDir,
      "agent-gamma": agentWorktree,
    });

    const envPeerSync = makePeerSyncDir({
      root: tmpDir,
      "agent-gamma": agentWorktree,
    });
    // Give the env peer-sync a different phase token.
    writeFileSync(join(envPeerSync, "phase-token"), "env-token");

    process.env.LUDICS_PEER_SYNC_DIR = envPeerSync;

    orchOnStop([agentWorktree, cliPeerSync, "Stop"]);

    // Should use CLI arg's peer-sync dir (with "phase-test-token").
    const record = readStopHookRecord(cliPeerSync, "agent-gamma");
    expect(record).not.toBeNull();
    expect(record!.phaseToken).toBe("phase-test-token");

    // Should NOT have written to env peer-sync dir.
    expect(readStopHookRecord(envPeerSync, "agent-gamma")).toBeNull();
  });

  test("invalid env var falls back to CLI arg", () => {
    const agentWorktree = join(tmpDir, "worktree-delta");
    mkdirSync(agentWorktree, { recursive: true });

    const cliPeerSync = makePeerSyncDir({
      root: tmpDir,
      "agent-delta": agentWorktree,
    });

    // Env var points to nonexistent dir.
    process.env.LUDICS_PEER_SYNC_DIR = "/tmp/nonexistent-ludics-test-dir";

    orchOnStop([agentWorktree, cliPeerSync, "Stop"]);

    const record = readStopHookRecord(cliPeerSync, "agent-delta");
    expect(record).not.toBeNull();
    expect(record!.agent).toBe("agent-delta");
  });

  test("neither env var nor CLI arg valid → no stop record", () => {
    const cwd = join(tmpDir, "cwd");
    mkdirSync(cwd, { recursive: true });

    process.env.LUDICS_PEER_SYNC_DIR = "/tmp/nonexistent-ludics-test-dir";

    orchOnStop([cwd, "", "Stop"]);

    // No stop record should be created anywhere.
    expect(existsSync(join(tmpDir, "coder.stop.json"))).toBe(false);
  });
});

// ===========================================================================
// AgentTurnLifecycle state transitions (via isAgentDone)
// ===========================================================================

describe("AgentTurnLifecycle state machine via isAgentDone", () => {
  test("dispatched state → not done regardless of peer-sync status", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched" });
    state.agentStates.coder.status = "done";
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("running state → not done regardless of peer-sync status", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-123",
    });
    state.agentStates.coder.status = "done";
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("settled + done status → done (no artifact for work phase)", () => {
    const state = makeState({ phase: "work" });
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("settled + done status + stale fingerprint → not done", () => {
    const state = makeState({ phase: "work" });
    const staleFingerprint = "done|1234567890";
    state.agentStates.coder.dispatchStatusFingerprint = staleFingerprint;
    markAgentDone(state, "coder");
    // Make statusFileFingerprint return the same value as baseline → stale
    const fpSpy = spyOn(peerSync, "statusFileFingerprint").mockReturnValue(staleFingerprint);
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
    fpSpy.mockRestore();
  });

  test("settled + done status + fresh fingerprint → done", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.dispatchStatusFingerprint = "old|111";
    markAgentDone(state, "coder");
    // Make statusFileFingerprint return a different value → fresh
    const fpSpy = spyOn(peerSync, "statusFileFingerprint").mockReturnValue("new|222");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
    fpSpy.mockRestore();
  });

  test("error state → done (terminal)", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "error",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("interrupted → done regardless of lifecycle", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "running" });
    state.agentStates.coder.interrupted = true;
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });
});

// ===========================================================================
// Phase-specific artifact validation (blocking)
// ===========================================================================

describe("phase-specific artifact validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("plan phase: missing plan file → not done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    markAgentDone(state, "coder", { skipArtifact: true });
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("plan phase: plan file exists → done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("plan-review phase: requires review file (not plan file)", () => {
    // planMergeRound defaults to 0, so the required file is plan-merge-0-reviewer.md
    const state = makeState({ phase: "plan-review", planMergeRound: 0 }, tmpDir);
    const reviewer = state.agents[1]!;

    // Set up lifecycle+status but skip artifact — plan file exists but review doesn't.
    markAgentDone(state, "reviewer", { skipArtifact: true });
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Plan\n");
    expect(isAgentDone(state, reviewer)).toBe(false);

    // Now create the per-iteration review file — should be done.
    writeFileSync(join(tmpDir, "reviews", "plan-merge-0-reviewer.md"), "APPROVE\n");
    expect(isAgentDone(state, reviewer)).toBe(true);
  });

  test("review phase: missing review file → not done", () => {
    const state = makeState({ phase: "review" }, tmpDir);
    const reviewer = state.agents[1]!;
    markAgentDone(state, "reviewer", { skipArtifact: true });
    expect(isAgentDone(state, reviewer)).toBe(false);
  });

  test("review phase: review file exists → done", () => {
    const state = makeState({ phase: "review" }, tmpDir);
    const reviewer = state.agents[1]!;
    markAgentDone(state, "reviewer");
    expect(isAgentDone(state, reviewer)).toBe(true);
  });

  test("pr-create phase: missing .pr file → not done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    markAgentDone(state, "coder", { skipArtifact: true });
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("pr-create phase: .pr file with valid URL → done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("pr-create phase: .pr file with malformed body (not a URL) → not done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    markAgentDone(state, "coder", { artifactContent: "# My PR\n\nThis is a PR body, not a URL.\n" });
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("work phase: no artifact required → done with just done status", () => {
    const state = makeState({ phase: "work" }, tmpDir);
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("grace-period done with missing artifact → not done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-plan",
      turnCompletedAt: new Date(Date.now() - 120_000).toISOString(),
      completionSource: "snapshot",
      statusFileFingerprint: "same",
    });
    writeFileSync(join(tmpDir, "coder.status"), "plan-active|0|working\n");
    state.agentStates.coder.status = "plan-active";
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });
});

// ===========================================================================
// Agent marker file read/write
// ===========================================================================

describe("agent marker files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writeAgentMarkerFiles creates marker and readAgentMarkerFile reads it", () => {
    const peerSyncDir = join(tmpDir, ".peer-sync");
    mkdirSync(peerSyncDir, { recursive: true });
    writeAgentMarkerFiles(peerSyncDir, { coder: tmpDir });
    const marker = readAgentMarkerFile(tmpDir);
    expect(marker).toEqual({ agentName: "coder", peerSyncDir });
  });

  test("writeAgentMarkerFiles creates .claude/settings.local.json with SessionStart hook", () => {
    const peerSyncDir = join(tmpDir, ".peer-sync");
    mkdirSync(peerSyncDir, { recursive: true });
    writeAgentMarkerFiles(peerSyncDir, { coder: tmpDir });

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);

    const hookCommand = settings.hooks.SessionStart[0].hooks[0].command;
    expect(hookCommand).toContain("LUDICS_PEER_SYNC_DIR");
    expect(hookCommand).toContain("LUDICS_AGENT_NAME");
    expect(hookCommand).toContain(peerSyncDir);
    expect(hookCommand).toContain("coder");
    expect(hookCommand).toContain("CLAUDE_ENV_FILE");
  });

  test("writeAgentMarkerFiles merges with existing settings.local.json", () => {
    const peerSyncDir = join(tmpDir, ".peer-sync");
    mkdirSync(peerSyncDir, { recursive: true });

    // Pre-populate settings with an existing Stop hook.
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");
    const existing = {
      permissions: { allow: ["bash"] },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo bye" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    writeAgentMarkerFiles(peerSyncDir, { coder: tmpDir });

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Existing permissions preserved.
    expect(settings.permissions).toEqual({ allow: ["bash"] });
    // Existing Stop hook preserved.
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo bye");
    // SessionStart hook added.
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("LUDICS_PEER_SYNC_DIR");
  });

  test("writeAgentMarkerFiles is idempotent — deduplicates ludics SessionStart hooks", () => {
    const peerSyncDir = join(tmpDir, ".peer-sync");
    mkdirSync(peerSyncDir, { recursive: true });

    writeAgentMarkerFiles(peerSyncDir, { coder: tmpDir });
    writeAgentMarkerFiles(peerSyncDir, { coder: tmpDir });

    const settingsPath = join(tmpDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Should only have one SessionStart hook, not two.
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  test("readAgentMarkerFile returns null when no marker file", () => {
    expect(readAgentMarkerFile(tmpDir)).toBeNull();
  });
});

// ===========================================================================
// Crash-recovery dispatch dedup via currentPhaseToken
// ===========================================================================

describe("crash-recovery dispatch dedup", () => {
  test("pre-existing turnLifecycle with matching phaseToken is not re-dispatched", () => {
    // Simulates the skip guard in enterPhase().
    // The logic: if existing.phaseToken === phaseToken && existing.state === "dispatched", skip.
    const phaseToken = "phase-crash-recovery";
    const existing = makeLifecycle({
      state: "dispatched",
      phaseToken,
      dispatchCommandId: "cmd-original",
    });

    // The guard check from enterPhase():
    const shouldSkip = existing && existing.state === "dispatched" && existing.phaseToken === phaseToken;
    expect(shouldSkip).toBe(true);
  });

  test("pre-existing turnLifecycle with different phaseToken is re-dispatched", () => {
    const phaseToken = "phase-new";
    const existing = makeLifecycle({
      state: "dispatched",
      phaseToken: "phase-old",
      dispatchCommandId: "cmd-original",
    });

    const shouldSkip = existing && existing.state === "dispatched" && existing.phaseToken === phaseToken;
    expect(shouldSkip).toBe(false);
  });

  test("settled turnLifecycle is not skipped (allows re-entry for new phase)", () => {
    const phaseToken = "phase-reuse";
    const existing = makeLifecycle({
      state: "settled",
      phaseToken,
      dispatchCommandId: "cmd-original",
    });

    const shouldSkip = existing && existing.state === "dispatched" && existing.phaseToken === phaseToken;
    expect(shouldSkip).toBe(false);
  });

  test("currentPhaseToken is reused on re-entry (crash recovery scenario)", () => {
    // Simulates the logic: if state.currentPhaseToken exists, reuse it.
    const state = makeState({ phase: "work" });
    state.currentPhaseToken = "phase-persisted";

    // On re-entry, enterPhase() should use this token instead of generating new one.
    const phaseToken = state.currentPhaseToken ?? "phase-fresh-should-not-be-used";
    expect(phaseToken).toBe("phase-persisted");
  });

  test("currentPhaseToken is generated fresh when not set", () => {
    const state = makeState({ phase: "work" });
    // No currentPhaseToken set — simulates fresh entry
    expect(state.currentPhaseToken).toBeUndefined();

    // enterPhase() would generate a new token
    const phaseToken = state.currentPhaseToken ?? "phase-fresh";
    expect(phaseToken).toBe("phase-fresh");
  });
});

// ===========================================================================
// pairReviewVerdict — verdict file parsing and timeout handling
// ===========================================================================

describe("pairReviewVerdict", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no review file exists (review timeout path)", () => {
    // No review file written — simulates a timed-out review phase.
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    expect(pairReviewVerdict(state)).toBeNull();
  });

  test("returns 'approve' when review file contains APPROVE", () => {
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "**Verdict**: APPROVE\n\nLooks good!\n");
    expect(pairReviewVerdict(state)).toBe("approve");
  });

  test("returns 'request_changes' when review file contains REQUEST_CHANGES", () => {
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "**Verdict**: REQUEST_CHANGES\n\nFix X.\n");
    expect(pairReviewVerdict(state)).toBe("request_changes");
  });

  test("returns 'request_changes' when file contains both APPROVE and REQUEST_CHANGES", () => {
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "do NOT APPROVE — REQUEST_CHANGES instead\n");
    expect(pairReviewVerdict(state)).toBe("request_changes");
  });

  test("uses correct round number for the review file lookup", () => {
    const state = makeState({ phase: "review", round: 3 }, tmpDir);
    // Write verdict for round 3 only — rounds 1 and 2 have no files.
    writeFileSync(join(tmpDir, "reviews", "round-3-reviewer.md"), "**Verdict**: APPROVE\n");
    expect(pairReviewVerdict(state)).toBe("approve");
  });

  test("timed-out review produces null verdict (regression: was falsely APPROVE)", () => {
    // This is the regression case: review phase timed out → evaluateTransition returns
    // "update-docs" (same as APPROVE), but no review file was written. The notification
    // logic must NOT label this transition as "APPROVE".
    const state = makeState({ phase: "review", round: 2 }, tmpDir);
    // No review file for round 2 — timeout scenario.
    const verdict = pairReviewVerdict(state);
    expect(verdict).toBeNull();
    // Verify the label that would be used in the notification is "timeout", not "APPROVE".
    const verdictLabel = verdict === "approve" ? "APPROVE"
      : verdict === "request_changes" ? "REQUEST_CHANGES"
      : "timeout";
    expect(verdictLabel).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// maybePostCodexReviewRequests — @codex review comment decision logic
// ---------------------------------------------------------------------------

describe("maybePostCodexReviewRequests", () => {
  function makeCodexState(
    overrides: Partial<OrchestrationState> = {},
  ): OrchestrationState {
    const state = makeState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
        },
        reviewer: {
          status: "idle", statusEpoch: 0, statusMessage: "",
          prUrl: null, interrupted: false,
        },
      },
      ...overrides,
    });
    return state;
  }

  test("arms deferral on pr-create -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "pr-create" });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeGreaterThan(0);
  });

  test("arms deferral on update-docs -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "update-docs" });
    maybePostCodexReviewRequests(state, "update-docs", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeGreaterThan(0);
  });

  test("arms deferral on review -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "review" });
    maybePostCodexReviewRequests(state, "review", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeGreaterThan(0);
  });

  test("does NOT arm on merge-review -> pr-comments", () => {
    const state = makeCodexState({ phase: "merge-review" });
    maybePostCodexReviewRequests(state, "merge-review", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when reviewer provider is claude-code", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when coder is codex but reviewer is claude-code", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "codex", role: "coder", model: "o3-pro", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when next phase is not pr-comments", () => {
    const state = makeCodexState({ phase: "pr-create" });
    maybePostCodexReviewRequests(state, "pr-create", "work");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when no agents have a prUrl", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agentStates: {
        coder: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: null, interrupted: false,
        },
        reviewer: {
          status: "idle", statusEpoch: 0, statusMessage: "",
          prUrl: null, interrupted: false,
        },
      },
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkAndRedispatchPrComments — deferred Codex review fallback logic
// ---------------------------------------------------------------------------

describe("checkAndRedispatchPrComments deferred review fallback", () => {
  let reviewSpy: ReturnType<typeof spyOn>;
  let commentSpy: ReturnType<typeof spyOn>;
  let postSpy: ReturnType<typeof spyOn>;
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;

  const nowSec = Math.floor(Date.now() / 1000);

  const dummyTransport: OrchestrationTransport = {
    sendTurn: async () => "cmd-1",
    sendEnter: async () => {},
    refreshAgentTransportState: async () => {},
    interruptAgent: async () => {},
  };

  function makePrCommentsState(
    overrides: Partial<OrchestrationState> = {},
  ): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120, // 2 min ago
      prCommentsLastCheckAt: nowSec - 120, // force poll eligibility
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "idle", statusEpoch: nowSec, statusMessage: "",
          prUrl: null, interrupted: false,
          turnLifecycle: null,
        },
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(false);
    commentSpy = spyOn(github, "hasCodexPostedComment").mockReturnValue(false);
    postSpy = spyOn(github, "postCodexReviewComment").mockReturnValue(true);
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(false);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    reviewSpy.mockRestore();
    commentSpy.mockRestore();
    postSpy.mockRestore();
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    eventSpy.mockRestore();
  });

  test("clears deferral early when all PRs have submitted reviews", async () => {
    reviewSpy.mockReturnValue(true);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60, // armed 60s ago (within window)
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("posts fallback after deadline when no review exists, keeps deferral armed", async () => {
    reviewSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 700, // 700s ago, past 600s deadline
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![0]).toBe("https://github.com/test/repo/pull/42");
    // Deferral stays armed — blocks shortcut until review actually arrives
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 700);
    expect(state.prCodexReviewFallbackPosted).toBe(true);
  });

  test("does not re-post fallback once already posted, keeps waiting for review", async () => {
    reviewSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 800,
      prCodexReviewFallbackPosted: true,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).not.toHaveBeenCalled();
    // Still armed — waiting for review
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 800);
  });

  test("clears deferral after fallback posted and review arrives", async () => {
    reviewSpy.mockReturnValue(true);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 800,
      prCodexReviewFallbackPosted: true,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
  });

  test("keeps waiting within deferral window when no review yet", async () => {
    reviewSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60, // only 60s, well within 600s window
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).not.toHaveBeenCalled();
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 60); // unchanged
  });

  test("posts fallback only for PRs missing review (per-PR resolution)", async () => {
    // PR 42 has review, PR 43 does not
    reviewSpy.mockImplementation((url: string) =>
      url.includes("pull/42")
    );
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 700,
      mode: "duo",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/43", interrupted: false,
          turnLifecycle: null,
        },
      },
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![0]).toBe("https://github.com/test/repo/pull/43");
    // Still armed — PR 43 review hasn't arrived yet
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 700);
    expect(state.prCodexReviewFallbackPosted).toBe(true);
  });

  test("does nothing when prCodexReviewDeferredSince is not set", async () => {
    const state = makePrCommentsState(); // no deferral armed
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(reviewSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("clears deferral when Codex posts issue comment (no formal review)", async () => {
    reviewSpy.mockReturnValue(false);
    commentSpy.mockReturnValue(true); // Codex responded with a comment
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("keeps deferral armed when no Codex review or comment", async () => {
    reviewSpy.mockReturnValue(false);
    commentSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 60);
  });
});

// ---------------------------------------------------------------------------
// autoCommitAgent / autoCommitAllAgents
// ---------------------------------------------------------------------------

function initGitRepo(dir: string): void {
  const { mkdirSync, writeFileSync } = require("fs");
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  writeFileSync(join(dir, "README.md"), "init\n");
  Bun.spawnSync(["git", "add", "README.md"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
}

function gitLastCommitMsg(dir: string): string {
  return Bun.spawnSync(["git", "log", "--format=%s", "-1"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  }).stdout.toString().trim();
}

function gitCommitCount(dir: string): number {
  const out = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  }).stdout.toString().trim();
  return parseInt(out, 10);
}

describe("autoCommitAgent", () => {
  afterEach(() => {
    rmSync(join(import.meta.dir, ".test-tmp-autocommit"), { recursive: true, force: true });
  });

  test("commit message format: '[round N] <statusMessage>'", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "msg-fmt");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      round: 3,
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "implemented tensor syntax", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 3] implemented tensor syntax");
  });

  test("falls back to slotTitle when statusMessage is empty", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "title-fallback");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "review",
      round: 2,
      slotTitle: "add widget support",
      agents: [{ name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 2] add widget support");
  });

  test("falls back to WIP when both statusMessage and slotTitle are empty", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "wip-fallback");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "review",
      agents: [{ name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 1] WIP");
  });

  test("collapses multiline statusMessage to single line", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "multiline");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "line1\nline2\n  line3", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 1] line1 line2 line3");
  });

  test("no-op on clean worktree", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "clean");
    initGitRepo(repo);

    const state = makeState({
      phase: "work",
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "done", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitCommitCount(repo)).toBe(1); // only the init commit
  });
});

describe("autoCommitAllAgents", () => {
  afterEach(() => {
    rmSync(join(import.meta.dir, ".test-tmp-autocommit"), { recursive: true, force: true });
  });

  test("pair mode: commits once for shared worktree", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "pair-dedup");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      mode: "pair",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo },
      ],
      agentStates: {
        coder: { status: "done", statusEpoch: 200, statusMessage: "coded it", prUrl: null, interrupted: false },
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "reviewed", prUrl: null, interrupted: false },
      },
    });

    autoCommitAllAgents(state, state.agents, false);
    // Only 1 new commit (init + auto-commit = 2 total), not 2 new commits
    expect(gitCommitCount(repo)).toBe(2);
  });

  test("pair mode: attributes to agent with newest statusEpoch", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "pair-attr");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      mode: "pair",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo },
      ],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "coded", prUrl: null, interrupted: false },
        reviewer: { status: "done", statusEpoch: 200, statusMessage: "reviewed it", prUrl: null, interrupted: false },
      },
    });

    autoCommitAllAgents(state, state.agents, false);
    // Reviewer has higher epoch → commit attributed to reviewer
    expect(gitLastCommitMsg(repo)).toBe("[round 1] reviewed it");
  });

  test("duo mode: commits independently per worktree", () => {
    if (!Bun.which("git")) return;
    const repo1 = join(import.meta.dir, ".test-tmp-autocommit", "duo-1");
    const repo2 = join(import.meta.dir, ".test-tmp-autocommit", "duo-2");
    initGitRepo(repo1);
    initGitRepo(repo2);
    writeFileSync(join(repo1, "code.ts"), "coder work\n");
    writeFileSync(join(repo2, "review.md"), "reviewer notes\n");

    const state = makeState({
      phase: "work",
      mode: "duo",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo1 },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo2 },
      ],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "coded", prUrl: null, interrupted: false },
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "reviewed", prUrl: null, interrupted: false },
      },
    });

    autoCommitAllAgents(state, state.agents, false);
    expect(gitCommitCount(repo1)).toBe(2);
    expect(gitCommitCount(repo2)).toBe(2);
    expect(gitLastCommitMsg(repo1)).toBe("[round 1] coded");
    expect(gitLastCommitMsg(repo2)).toBe("[round 1] reviewed");
  });
});

// ===========================================================================
// Snapshot reconciliation for stuck dispatched lifecycles
// ===========================================================================

describe("snapshot reconciliation for stuck dispatched", () => {
  let tmpDir: string;
  let origHarnessDir: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = join(tmpDir, "harness");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
  });

  test("dispatched + completed latestTurn with requestedAt >= dispatchedAt → settled", async () => {
    const dispatchedAt = new Date(Date.now() - 60_000).toISOString();
    const requestedAt = new Date(Date.now() - 30_000).toISOString();
    const completedAt = new Date(Date.now() - 10_000).toISOString();

    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "dispatched",
      dispatchedAt,
    });

    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "idle", activeTurnId: null },
      latestTurn: { turnId: "turn-reconcile", state: "completed", requestedAt, completedAt },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.state).toBe("settled");
    expect(lc.observedTurnId).toBe("turn-reconcile");
    expect(lc.completionSource).toBe("snapshot");
  });

  test("dispatched + completed latestTurn with requestedAt < dispatchedAt → stays dispatched", async () => {
    const dispatchedAt = new Date(Date.now() - 10_000).toISOString();
    const requestedAt = new Date(Date.now() - 60_000).toISOString(); // before dispatch

    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "dispatched",
      dispatchedAt,
    });

    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "idle", activeTurnId: null },
      latestTurn: { turnId: "turn-old", state: "completed", requestedAt, completedAt: new Date().toISOString() },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    expect(state.agentStates.coder.turnLifecycle!.state).toBe("dispatched");
  });

  test("dispatched + null sessionStatus (snapshot fetch failure) → stays dispatched", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched" });

    // null snapshot → sessionStatus will be undefined/null
    await refreshAgentStatuses(state, makeMockTransport(null));

    expect(state.agentStates.coder.turnLifecycle!.state).toBe("dispatched");
  });

  test("dispatched + error latestTurn with requestedAt >= dispatchedAt → error", async () => {
    const dispatchedAt = new Date(Date.now() - 60_000).toISOString();
    const requestedAt = new Date(Date.now() - 30_000).toISOString();

    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "work-active|0|coding" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "dispatched",
      dispatchedAt,
    });

    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "idle", activeTurnId: null },
      latestTurn: { turnId: "turn-err", state: "error", requestedAt },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.state).toBe("error");
    expect(lc.observedTurnId).toBe("turn-err");
    expect(lc.completionSource).toBe("snapshot");
  });
});

// ===========================================================================
// detectAndNudgeHungAgents — stall detection and nudge logic
// ===========================================================================

describe("detectAndNudgeHungAgents", () => {
  let tmpDir: string;
  let emitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    emitSpy = spyOn(events, "emitEvent");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    emitSpy.mockRestore();
  });

  test("running stall: done status + running lifecycle + age > threshold → stall detected", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(), // 400s ago > 300s threshold
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.stallDetectedAt).not.toBeNull();
    // Nudge attempt won't succeed (readServerRecord returns null) so nudgeAttempts stays 0
    // but stall is detected
    const stallEvent = emitSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { event_type?: string }).event_type === "orchestration_hung_detected",
    );
    expect(stallEvent).toBeDefined();
  });

  test("dispatch stall: dispatched lifecycle + age > threshold → stall detected", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "dispatched",
      dispatchedAt: new Date(Date.now() - 200_000).toISOString(), // 200s > 120s threshold
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.stallDetectedAt).not.toBeNull();
  });

  test("below threshold: no stall detected", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 60_000).toISOString(), // 60s < 180s threshold
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.stallDetectedAt).toBeNull();
  });

  test("nudge cooldown respected: recent lastNudgeAt → no nudge", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(),
      stallDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      nudgeAttempts: 1,
      lastNudgeAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago < 300s cooldown
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    // nudgeAttempts should stay at 1 (cooldown prevented another nudge)
    expect(state.agentStates.coder.turnLifecycle!.nudgeAttempts).toBe(1);
  });

  test("force-settle after MAX_NUDGE_ATTEMPTS: interruptAgent called", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(),
      stallDetectedAt: new Date(Date.now() - 1500_000).toISOString(),
      nudgeAttempts: 3, // >= MAX_NUDGE_ATTEMPTS
      lastNudgeAt: new Date(Date.now() - 400_000).toISOString(),
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    // interruptAgent sets interrupted = true and status = "interrupted"
    expect(state.agentStates.coder.interrupted).toBe(true);
    expect(state.agentStates.coder.status).toBe("interrupted");
    const forceEvent = emitSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { event_type?: string }).event_type === "orchestration_hung_force_settle",
    );
    expect(forceEvent).toBeDefined();
  });

  test("settled lifecycle is skipped", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-1",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    expect(state.agentStates.coder.turnLifecycle!.stallDetectedAt).toBeNull();
  });

  test("interrupted agent is skipped", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.interrupted = true;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 200_000).toISOString(),
    });
    state.agentStates.coder.status = "done";

    await detectAndNudgeHungAgents(state, noopTransport);

    expect(state.agentStates.coder.turnLifecycle!.stallDetectedAt).toBeNull();
  });
});

// ===========================================================================
// Post-nudge outcome classification
// ===========================================================================

describe("post-nudge outcome classification", () => {
  let tmpDir: string;
  let origHarnessDir: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = join(tmpDir, "harness");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
  });

  test("settlement after nudge with changed assistantMessageId → alive", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 200_000).toISOString(),
      stallDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      nudgeAttempts: 1,
      lastNudgeAt: new Date(Date.now() - 50_000).toISOString(),
      preNudgeAssistantMessageId: "msg-old",
    });

    // Snapshot shows settled session with new assistant message
    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "idle", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        completedAt: new Date().toISOString(),
        assistantMessageId: "msg-new", // changed
      },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    // Stall should be cleared after settlement
    expect(lc.stallDetectedAt).toBeNull();
    expect(lc.nudgeAttempts).toBe(0);

    // Check events journal
    const eventsPath = join(tmpDir, "harness", "journal", "events.jsonl");
    if (existsSync(eventsPath)) {
      const evts = readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const aliveEvent = evts.find((e: { event_type?: string }) => e.event_type === "orchestration_nudge_settled_alive");
      expect(aliveEvent).toBeDefined();
    }
  });

  test("settlement after nudge with unchanged assistantMessageId → dead", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 200_000).toISOString(),
      stallDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      nudgeAttempts: 1,
      lastNudgeAt: new Date(Date.now() - 50_000).toISOString(),
      preNudgeAssistantMessageId: "msg-same",
    });

    // Snapshot shows settled with same assistant message
    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "idle", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        completedAt: new Date().toISOString(),
        assistantMessageId: "msg-same", // unchanged
      },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.stallDetectedAt).toBeNull();
    expect(lc.nudgeAttempts).toBe(0);

    const eventsPath = join(tmpDir, "harness", "journal", "events.jsonl");
    if (existsSync(eventsPath)) {
      const evts = readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const deadEvent = evts.find((e: { event_type?: string }) => e.event_type === "orchestration_nudge_settled_dead");
      expect(deadEvent).toBeDefined();
    }
  });

  test("settlement without any nudge (nudgeAttempts=0) → no outcome event, stall cleared", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 200_000).toISOString(),
      stallDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      nudgeAttempts: 0, // no nudge was sent
    });

    const snapshot = makeSnapshot([{
      id: "t1",
      session: { status: "idle", activeTurnId: null },
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        completedAt: new Date().toISOString(),
      },
    }]);

    await refreshAgentStatuses(state, makeMockTransport(snapshot));

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.stallDetectedAt).toBeNull();
    expect(lc.nudgeAttempts).toBe(0);

    // No nudge outcome event should be emitted
    const eventsPath = join(tmpDir, "harness", "journal", "events.jsonl");
    if (existsSync(eventsPath)) {
      const evts = readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const outcomeEvent = evts.find((e: { event_type?: string }) =>
        e.event_type === "orchestration_nudge_settled_alive" || e.event_type === "orchestration_nudge_settled_dead",
      );
      expect(outcomeEvent).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// checkAndRedispatchPrComments — PR conflict detection
// ---------------------------------------------------------------------------

describe("checkAndRedispatchPrComments conflict detection", () => {
  let verificationSpy: ReturnType<typeof spyOn>;
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;
  let reviewSpy: ReturnType<typeof spyOn>;

  const nowSec = Math.floor(Date.now() / 1000);

  function makeConflictTransport(): OrchestrationTransport & { sendTurnCalls: Array<{ agent: string }> } {
    const calls: Array<{ agent: string }> = [];
    return {
      sendTurnCalls: calls,
      sendTurn: async (_state: OrchestrationState, agent: { name: string }) => {
        calls.push({ agent: agent.name });
        return "cmd-conflict";
      },
      sendEnter: async () => {},
      refreshAgentTransportState: async () => {},
      interruptAgent: async () => {},
    };
  }

  function makeConflictState(
    overrides: Partial<OrchestrationState> = {},
  ): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120,
      prCommentsLastCheckAt: nowSec - 120, // force poll eligibility
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "idle", statusEpoch: nowSec, statusMessage: "",
          prUrl: null, interrupted: false,
          turnLifecycle: null,
        },
      },
      prMergeableStates: {},
      ...overrides,
    });
  }

  beforeEach(() => {
    verificationSpy = spyOn(github, "getPrVerification");
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(false);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(false);
  });

  afterEach(() => {
    verificationSpy.mockRestore();
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    eventSpy.mockRestore();
    reviewSpy.mockRestore();
  });

  test("clean → dirty triggers one redispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "clean" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(1);
    expect(transport.sendTurnCalls[0]!.agent).toBe("coder");
    expect(state.prMergeableStates!.coder).toBe("dirty");
  });

  test("dirty → dirty does NOT redispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "dirty" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
  });

  test("dirty → clean → dirty redispatches again", async () => {
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "dirty" } });

    // First poll: dirty → clean
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "clean", reason: "ok",
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates!.coder).toBe("clean");

    // Reset poll eligibility and agent done status
    state.prCommentsLastCheckAt = nowSec - 120;
    state.agentStates.coder!.status = "pr-comments-done";
    state.agentStates.coder!.turnLifecycle = null;

    // Second poll: clean → dirty
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(1);
    expect(transport.sendTurnCalls[0]!.agent).toBe("coder");
  });

  test("unknown does not dispatch and does not overwrite prior state", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "unknown", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "clean" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates!.coder).toBe("clean"); // preserved
  });

  test("behind does not dispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "behind", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "clean" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates!.coder).toBe("behind");
  });

  test("only affected agent redispatched in duo mode", async () => {
    verificationSpy.mockImplementation((url: string) => {
      if (url.includes("pull/42")) {
        return { exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok" };
      }
      return { exists: true, state: "open", merged: false, mergeableState: "clean", reason: "ok" };
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({
      mode: "duo",
      prMergeableStates: { coder: "clean", reviewer: "clean" },
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/43", interrupted: false,
          turnLifecycle: null,
        },
      },
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(1);
    expect(transport.sendTurnCalls[0]!.agent).toBe("coder");
  });

  test("does NOT advance prCommentsLastCheckAt on conflict dispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const originalCheckAt = nowSec - 120;
    const state = makeConflictState({
      prMergeableStates: { coder: "clean" },
      prCommentsLastCheckAt: originalCheckAt,
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(state.prCommentsLastCheckAt).toBe(originalCheckAt);
  });

  test("resets prCommentsQuietSince on conflict dispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({
      prMergeableStates: { coder: "clean" },
      prCommentsQuietSince: nowSec - 60,
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(state.prCommentsQuietSince).toBe(0);
  });

  test("resume preserves prMergeableStates during conflict check", async () => {
    // Simulate resume scenario: prMergeableStates already populated with "dirty"
    // from a prior poll. dirty→dirty should NOT redispatch — proving the map survived.
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "dirty" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates).toEqual({ coder: "dirty" });
  });

  test("defensive init creates prMergeableStates when undefined (legacy state)", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "clean", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: undefined });
    await checkAndRedispatchPrComments(state, transport);
    expect(state.prMergeableStates).toBeDefined();
    expect(state.prMergeableStates!.coder).toBe("clean");
  });

  test("fresh re-entry resets prMergeableStates via applyPhaseSideEffects", () => {
    const state = makeConflictState({
      phase: "pr-create",
      prMergeableStates: { coder: "dirty" },
    });
    applyPhaseSideEffects(state, "pr-comments");
    expect(state.prMergeableStates).toEqual({});
  });

  test("applyPhaseSideEffects resets all pr-comments fields via resetPrCommentsState", () => {
    const state = makeConflictState({
      phase: "pr-create",
      prCommentsLastCheckAt: 999,
      prCommentsQuietSince: 888,
      prCommentsCoderDispatched: true,
      prMergeableStates: { coder: "dirty" },
      prCodexReviewFallbackPosted: true,
    });
    applyPhaseSideEffects(state, "pr-comments");
    expect(state.prCommentsLastCheckAt).toBe(state.phaseStartedAt - 600);
    expect(state.prCommentsQuietSince).toBeUndefined();
    expect(state.prCommentsCoderDispatched).toBe(false);
    expect(state.prMergeableStates).toEqual({});
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
  });
});

describe("checkAndRedispatchPrComments merge detection", () => {
  // Regression for the simplified upstream workflow (task-d1932b8f): when
  // isPrMerged returns true during pr-comments, the runner must take the
  // uniform merged path — write `<agent>.merged`, set status to "merged",
  // emit `pr_merged`, and notify. The former upstream-aware three-way split
  // (upstream-merged marker / upstream_pr_merged event / forwarding warning)
  // must be gone. We exercise this with an upstream-configured fixture so
  // the test specifically guards the behavior this task simplified.
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let reviewSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let emittedEvents: Array<{ event_type?: string; message?: string }>;
  const nowSec = Math.floor(Date.now() / 1000);

  const dummyTransport: OrchestrationTransport = {
    sendTurn: async () => "cmd-merge",
    sendEnter: async () => {},
    refreshAgentTransportState: async () => {},
    interruptAgent: async () => {},
  };

  function makeMergeState(peerSyncDir: string, overrides: Partial<OrchestrationState> = {}): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120,
      prCommentsLastCheckAt: nowSec - 120,
      projectDir: "/tmp/upstream-configured-project",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/lukstafi/ocannl-staging/pull/451", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "idle", statusEpoch: nowSec, statusMessage: "",
          prUrl: null, interrupted: false,
          turnLifecycle: null,
        },
      },
      ...overrides,
    }, peerSyncDir);
  }

  beforeEach(() => {
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(true);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(true);
    emittedEvents = [];
    eventSpy = spyOn(events, "emitEvent").mockImplementation((ev: unknown) => {
      emittedEvents.push(ev as { event_type?: string; message?: string });
    });
    // notifyAgents is invoked on the uniform merged path; stub to avoid noise.
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
  });

  afterEach(() => {
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    reviewSpy.mockRestore();
    eventSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("merged PR on upstream-configured project: writes .merged, sets status, emits pr_merged — no upstream-specific artifacts", async () => {
    const dir = makeTmpDir();
    const state = makeMergeState(dir);
    await checkAndRedispatchPrComments(state, dummyTransport);

    // 1. `<coder>.merged` marker is written (uniform path).
    const mergedMarker = join(dir, "coder.merged");
    expect(existsSync(mergedMarker)).toBe(true);
    expect(readFileSync(mergedMarker, "utf-8")).toBe("merged\n");

    // 2. Agent status flips to "merged".
    expect(state.agentStates.coder!.status).toBe("merged");
    expect(state.agentStates.coder!.statusMessage).toBe("PR merged externally");

    // 3. `pr_merged` event is emitted exactly once; NO `upstream_pr_merged`
    //    event and NO "orchestration_warning" about forwarding.
    const merged = emittedEvents.filter((e) => e.event_type === "pr_merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toContain("https://github.com/lukstafi/ocannl-staging/pull/451");
    expect(emittedEvents.some((e) => e.event_type === "upstream_pr_merged")).toBe(false);
    expect(emittedEvents.some((e) =>
      e.event_type === "orchestration_warning"
      && typeof e.message === "string"
      && e.message.includes("before forwarding")
    )).toBe(false);

    // 4. No `<coder>.upstream-merged` or `<coder>.forwarded` sidecar markers
    //    are written by the runner.
    expect(existsSync(join(dir, "coder.upstream-merged"))).toBe(false);
    expect(existsSync(join(dir, "coder.forwarded"))).toBe(false);

    // 5. notifyAgents was called (uniform path includes notification).
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  test("merged PR is idempotent: second invocation does not re-emit or rewrite the marker", async () => {
    const dir = makeTmpDir();
    const state = makeMergeState(dir);
    await checkAndRedispatchPrComments(state, dummyTransport);
    const firstEventCount = emittedEvents.filter((e) => e.event_type === "pr_merged").length;
    expect(firstEventCount).toBe(1);

    // Reset polling eligibility so the loop re-evaluates. The marker file
    // already exists; the runner must not emit pr_merged a second time.
    state.prCommentsLastCheckAt = nowSec - 120;
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(emittedEvents.filter((e) => e.event_type === "pr_merged")).toHaveLength(1);
  });
});

describe("resetPrCommentsState", () => {
  test("resets all pr-comments phase-entry fields", () => {
    const state = makeState({
      phase: "pr-comments",
      prCommentsLastCheckAt: 999,
      prCommentsQuietSince: 888,
      prCommentsCoderDispatched: true,
      prMergeableStates: { coder: "dirty" },
      prCodexReviewFallbackPosted: true,
      prCodexReviewDeferredSince: 777,
    });
    resetPrCommentsState(state);
    expect(state.prCommentsLastCheckAt).toBe(state.phaseStartedAt - 600);
    expect(state.prCommentsQuietSince).toBeUndefined();
    expect(state.prCommentsCoderDispatched).toBe(false);
    expect(state.prMergeableStates).toEqual({});
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
    // prCodexReviewDeferredSince has independent lifecycle — must NOT be touched
    expect(state.prCodexReviewDeferredSince).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// handleVerifyFailure
// ---------------------------------------------------------------------------

describe("handleVerifyFailure", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("increments attempt counter and returns redispatch on first failure", () => {
    const state = makeState({ phase: "pr-create", prCreateVerifyAttempts: 0 });
    const result = handleVerifyFailure(state, "prCreate", "No PR");
    expect(result).toBe("redispatch");
    expect(state.prCreateVerifyAttempts).toBe(1);
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].event_type).toBe("pr_missing");
  });

  test("emits finalMerge event type for finalMerge gate", () => {
    const state = makeState({ phase: "final-merge", finalMergeVerifyAttempts: 0 });
    const result = handleVerifyFailure(state, "finalMerge", "not merged");
    expect(result).toBe("redispatch");
    expect(state.finalMergeVerifyAttempts).toBe(1);
    expect(eventSpy.mock.calls[0][0].event_type).toBe("merge_failed");
  });

  test("emits manual_intervention_required and notifies at MAX_VERIFY_ATTEMPTS boundary", () => {
    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1,
    });
    const result = handleVerifyFailure(state, "prCreate", "still missing");
    expect(result).toBe("hold");
    expect(state.prCreateVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
    // Two events: the failure event + the manual_intervention_required event
    expect(eventSpy).toHaveBeenCalledTimes(2);
    expect(eventSpy.mock.calls[1][0].event_type).toBe("manual_intervention_required");
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  test("returns hold silently when already at max retries (event spam guard)", () => {
    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS,
    });
    const result = handleVerifyFailure(state, "prCreate", "still missing");
    expect(result).toBe("hold");
    // No events or notifications should be emitted
    expect(eventSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    // Counter should NOT increase further
    expect(state.prCreateVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
  });

  test("returns hold silently when above max retries", () => {
    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS + 5,
    });
    const result = handleVerifyFailure(state, "prCreate", "still missing");
    expect(result).toBe("hold");
    expect(eventSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleVerifyFailure — has_questions surfacing
// ---------------------------------------------------------------------------

describe("handleVerifyFailure — has_questions", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let harnessSpy: ReturnType<typeof spyOn>;
  let tmpHarness: string;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    tmpHarness = makeTmpDir();
    mkdirSync(join(tmpHarness, "tasks"), { recursive: true });
    harnessSpy = spyOn(config, "harnessDir").mockReturnValue(tmpHarness);
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
    harnessSpy.mockRestore();
  });

  test("sets has_questions and appends to Questions section on max attempts", () => {
    const taskFile = join(tmpHarness, "tasks", "feat.md");
    writeFileSync(taskFile, "---\ntitle: test\nstatus: in-progress\n---\n\n## Questions\n\nNone.\n");

    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1,
    });
    handleVerifyFailure(state, "prCreate", "still missing");

    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("has_questions: true");
    expect(content).toContain("Manual intervention required (slot 1)");
    expect(content).not.toContain("None.");
  });

  test("does not duplicate question on repeated calls", () => {
    const taskFile = join(tmpHarness, "tasks", "feat.md");
    writeFileSync(taskFile, "---\ntitle: test\nstatus: in-progress\n---\n\n## Questions\n\nNone.\n");

    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1,
    });
    handleVerifyFailure(state, "prCreate", "still missing");

    // Second call (already at max — returns hold silently, but test idempotency of appendToSection)
    const { appendToSection } = require("../tasks/markdown.ts");
    appendToSection(taskFile, "Questions",
      `- **Manual intervention required (slot 1)**: pr-create failed after ${MAX_VERIFY_ATTEMPTS} attempts`);

    const content = readFileSync(taskFile, "utf-8");
    const count = content.split("Manual intervention required").length - 1;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkZeroCommitsAutoBailOut
// ---------------------------------------------------------------------------

describe("checkZeroCommitsAutoBailOut", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let persistSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    persistSpy = spyOn(stateMod, "persistState").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test("returns false when phase is not pr-create", () => {
    const state = makeState({ phase: "work" });
    expect(checkZeroCommitsAutoBailOut(state)).toBe(false);
    expect(state.phase).toBe("work");
  });

  test("auto-bails when coder worktree has 0 commits ahead", () => {
    const repoDir = makeGitRepo();

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "pr-create",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(true);
    expect(state.phase).toBe("done");
    expect(state.agentStates.coder!.status).toBe("bail-out");
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].event_type).toBe("bail_out");
  });

  test("does not bail when coder worktree has commits ahead", () => {
    const repoDir = makeGitRepo();
    // Add another commit (1 ahead)
    writeFileSync(join(repoDir, "file2.txt"), "world");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "extra"], { cwd: repoDir });

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "pr-create",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(false);
    expect(state.phase).toBe("pr-create");
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("fast-paths to done when isPairBailedOut already true", () => {
    const state = makeState({ phase: "pr-create" });
    state.agentStates.coder!.status = "bail-out";
    state.agentStates.reviewer!.status = "bail-out-confirmed";
    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(true);
    expect(state.phase).toBe("done");
    // No event emitted — fast path doesn't re-emit
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("fast-paths to done for solo bail-out (single coder, no reviewer)", () => {
    // Solo mode: lone coder "bail-out" must trigger the same fast-path to done
    // that pair's coder+reviewer handshake triggers. Regression for task-da8b6dff.
    const state = makeState({
      phase: "pr-create",
      mode: "solo",
      duoPeerSlot: null,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "claude-sonnet-4-6", branch: "a", worktreePath: "/tmp/a" },
      ],
    });
    state.agentStates = { coder: { ...state.agentStates.coder!, status: "bail-out" } };
    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(true);
    expect(state.phase).toBe("done");
    // No event emitted — fast path doesn't re-emit
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("idempotent: event emitted only once on repeated calls", () => {
    const repoDir = makeGitRepo();

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "pr-create",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    checkZeroCommitsAutoBailOut(state);
    expect(eventSpy).toHaveBeenCalledTimes(1);

    // Reset phase to pr-create for second call
    state.phase = "pr-create" as any;
    eventSpy.mockClear();
    checkZeroCommitsAutoBailOut(state);
    // Coder already has bail-out status — no new event
    expect(eventSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isWorktreeNoOp
// ---------------------------------------------------------------------------

describe("isWorktreeNoOp", () => {
  test("returns true when zero commits ahead and clean worktree", () => {
    const repoDir = makeGitRepo();
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(true);
  });

  test("returns false when commits ahead", () => {
    const repoDir = makeGitRepo();
    writeFileSync(join(repoDir, "file2.txt"), "world");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "extra"], { cwd: repoDir });
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(false);
  });

  test("returns false with uncommitted diffs but zero commits", () => {
    const repoDir = makeGitRepo();
    writeFileSync(join(repoDir, "dirty.txt"), "uncommitted");
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(false);
  });

  test("returns false with staged-but-uncommitted changes", () => {
    const repoDir = makeGitRepo();
    writeFileSync(join(repoDir, "staged.txt"), "staged");
    Bun.spawnSync(["git", "add", "staged.txt"], { cwd: repoDir });
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(false);
  });

  test("returns true when origin/HEAD missing but origin/main exists", () => {
    const repoDir = makeGitRepo();
    // Verify origin/HEAD is NOT set (makeGitRepo only sets origin/main)
    const headCheck = Bun.spawnSync(
      ["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { cwd: repoDir },
    );
    expect(headCheck.exitCode).not.toBe(0); // origin/HEAD should not exist
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(true);
  });

  test("returns false on git error (nonexistent path)", () => {
    expect(isWorktreeNoOp("/nonexistent/path", "/nonexistent/path")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Early work-phase no-op detection regression (AC2 flow)
// ---------------------------------------------------------------------------

describe("early work-phase no-op detection", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let persistSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    persistSpy = spyOn(stateMod, "persistState").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test("work-phase no-op detection sets coder to bail-out", () => {
    const repoDir = makeGitRepo();
    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    // Simulate the early detection logic from runOrchestration
    const coder = state.agents.find(a => a.role === "coder")!;
    if (isWorktreeNoOp(coder.worktreePath, state.projectDir)) {
      const runtime = state.agentStates[coder.name]!;
      runtime.status = "bail-out";
      runtime.statusMessage = "no-op: zero commits ahead of base, no uncommitted diffs";
    }

    expect(state.agentStates.coder!.status).toBe("bail-out");
  });

  test("work-phase bail-out transitions to review, not directly to done", () => {
    const repoDir = makeGitRepo();
    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);
    state.agentStates.coder!.status = "bail-out";

    // evaluateTransition for work: isPairBailedOut = false → review
    expect(evaluateTransition(state)).toBe("review");
  });

  test("review-phase bail-out-confirmed transitions to done", () => {
    const state = makeState({ phase: "review" });
    state.agentStates.coder!.status = "bail-out";
    state.agentStates.reviewer!.status = "bail-out-confirmed";

    expect(evaluateTransition(state)).toBe("done");
  });

  test("early detection path never touches verification retry budget", () => {
    const repoDir = makeGitRepo();
    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    // Simulate full AC2 flow: early detection → review → done
    state.agentStates.coder!.status = "bail-out";
    expect(evaluateTransition(state)).toBe("review"); // work → review

    state.phase = "review";
    state.agentStates.reviewer!.status = "bail-out-confirmed";
    expect(evaluateTransition(state)).toBe("done"); // review → done

    // Verification retry budget was never consumed
    expect(state.prCreateVerifyAttempts).toBeUndefined();
  });

  test("work-phase no-op detection does NOT fire when coder has commits", () => {
    const repoDir = makeGitRepo();
    // Add a commit to put the worktree ahead
    writeFileSync(join(repoDir, "feature.txt"), "new feature");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "feature"], { cwd: repoDir });

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    const coder = state.agents.find(a => a.role === "coder")!;
    // isWorktreeNoOp should return false — no bail-out
    expect(isWorktreeNoOp(coder.worktreePath, state.projectDir)).toBe(false);
    expect(state.agentStates.coder!.status).not.toBe("bail-out");
  });
});

// ---------------------------------------------------------------------------
// preparePhaseRedispatch
// ---------------------------------------------------------------------------

describe("preparePhaseRedispatch", () => {
  test("resets participating agents and clears phase flags", () => {
    const state = makeState({ phase: "pr-create", phaseDispatched: true, currentPhaseToken: "tok-1" });
    // Set coder to done state (coder participates in pr-create)
    state.agentStates.coder!.turnLifecycle = makeLifecycle({ state: "settled" });
    state.agentStates.coder!.status = "done";
    state.agentStates.coder!.statusEpoch = 1000;
    state.agentStates.coder!.statusMessage = "finished";
    state.agentStates.coder!.interrupted = true;
    // Set reviewer to done state (reviewer does NOT participate in pr-create)
    state.agentStates.reviewer!.turnLifecycle = makeLifecycle({ state: "settled" });
    state.agentStates.reviewer!.status = "done";
    state.agentStates.reviewer!.statusEpoch = 1000;
    state.agentStates.reviewer!.statusMessage = "finished review";

    preparePhaseRedispatch(state);

    // Coder (participating) should be reset
    expect(state.agentStates.coder!.turnLifecycle).toBeNull();
    expect(state.agentStates.coder!.status).toBe("idle");
    expect(state.agentStates.coder!.statusEpoch).not.toBe(1000);
    expect(state.agentStates.coder!.statusMessage).toBe("verification failed — retry pending");
    expect(state.agentStates.coder!.interrupted).toBe(false);

    // Reviewer (non-participating) should be untouched
    expect(state.agentStates.reviewer!.turnLifecycle).not.toBeNull();
    expect(state.agentStates.reviewer!.status).toBe("done");
    expect(state.agentStates.reviewer!.statusEpoch).toBe(1000);
    expect(state.agentStates.reviewer!.statusMessage).toBe("finished review");

    // Phase flags should be cleared
    expect(state.phaseDispatched).toBe(false);
    expect(state.currentPhaseToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getFirstPrUrl
// ---------------------------------------------------------------------------

describe("getFirstPrUrl", () => {
  test("returns prUrl from agentStates when available", () => {
    const state = makeState();
    state.agentStates.coder!.prUrl = "https://github.com/org/repo/pull/42";
    expect(getFirstPrUrl(state)).toBe("https://github.com/org/repo/pull/42");
  });

  test("falls back to peer-sync .pr file", () => {
    const dir = makeTmpDir();
    const state = makeState({}, dir);
    // No prUrl in agentStates — write a .pr file instead
    writeFileSync(join(dir, "coder.pr"), "https://github.com/org/repo/pull/99\n");
    // Mock isPrUrl to return true for our URL
    const isPrUrlSpy = spyOn(github, "isPrUrl").mockReturnValue(true);
    expect(getFirstPrUrl(state)).toBe("https://github.com/org/repo/pull/99");
    isPrUrlSpy.mockRestore();
  });

  test("returns null when no PR URL exists anywhere", () => {
    const state = makeState();
    expect(getFirstPrUrl(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyPhaseOutcome — PR_CREATE_GATE
// ---------------------------------------------------------------------------

describe("verifyPhaseOutcome (PR_CREATE_GATE)", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let verificationSpy: ReturnType<typeof spyOn>;
  let isPrUrlSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    verificationSpy = spyOn(github, "getPrVerification");
    isPrUrlSpy = spyOn(github, "isPrUrl").mockReturnValue(true);
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
    verificationSpy.mockRestore();
    isPrUrlSpy.mockRestore();
  });

  test("returns skip when phase is not pr-create", () => {
    const state = makeState({ phase: "work" });
    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("skip");
  });

  test("returns skip when agents are not done", () => {
    const state = makeState({ phase: "pr-create" });
    // Agents default to idle/not-done, so this should skip
    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("skip");
  });

  function makePrCreateDoneState(overrides: Partial<OrchestrationState> = {}) {
    const dir = makeTmpDir();
    const prUrl = "https://github.com/org/repo/pull/1";
    // Write the .pr artifact so hasRequiredArtifact passes
    writeFileSync(join(dir, "coder.pr"), prUrl);
    const state = makeState({ phase: "pr-create", ...overrides }, dir);
    state.agentStates.coder!.status = "done";
    state.agentStates.coder!.prUrl = prUrl;
    state.agentStates.coder!.turnLifecycle = makeLifecycle({ state: "settled" });
    // Reviewer doesn't participate in pr-create — not checked by allAgentsDone
    return state;
  }

  test("returns advance when PR is verified", () => {
    const state = makePrCreateDoneState();
    verificationSpy.mockReturnValue({ exists: true, state: "open" });

    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("advance");
    expect(eventSpy.mock.calls.some((c: any[]) => c[0].event_type === "pr_verified")).toBe(true);
  });

  test("returns redispatch on first verification failure", () => {
    const state = makePrCreateDoneState({ prCreateVerifyAttempts: 0 });
    verificationSpy.mockReturnValue({ exists: false, reason: "not found" });

    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("redispatch");
    expect(state.prCreateVerifyAttempts).toBe(1);
  });

  test("returns hold at max retries", () => {
    const state = makePrCreateDoneState({ prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1 });
    verificationSpy.mockReturnValue({ exists: false, reason: "not found" });

    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("hold");
    expect(state.prCreateVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
  });
});

// ---------------------------------------------------------------------------
// verifyPhaseOutcome — FINAL_MERGE_GATE
// ---------------------------------------------------------------------------

describe("verifyPhaseOutcome (FINAL_MERGE_GATE)", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let verificationSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    verificationSpy = spyOn(github, "getPrVerification");
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
    verificationSpy.mockRestore();
  });

  test("returns skip when phase is not final-merge", () => {
    const state = makeState({ phase: "work" });
    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("skip");
  });

  test("returns skip when agents are not done", () => {
    const state = makeState({ phase: "final-merge" });
    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("skip");
  });

  function makeFinalMergeDoneState(overrides: Partial<OrchestrationState> = {}) {
    const state = makeState({ phase: "final-merge", ...overrides });
    state.agentStates.coder!.status = "done";
    state.agentStates.coder!.prUrl = "https://github.com/org/repo/pull/1";
    state.agentStates.coder!.turnLifecycle = makeLifecycle({ state: "settled" });
    // Reviewer doesn't participate in final-merge
    return state;
  }

  test("returns advance when PR is merged", () => {
    const state = makeFinalMergeDoneState();
    verificationSpy.mockReturnValue({ exists: true, merged: true, state: "closed" });

    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("advance");
    expect(eventSpy.mock.calls.some((c: any[]) => c[0].event_type === "merge_verified")).toBe(true);
  });

  test("returns redispatch when PR exists but is not merged", () => {
    const state = makeFinalMergeDoneState({ finalMergeVerifyAttempts: 0 });
    verificationSpy.mockReturnValue({ exists: true, merged: false, state: "open", mergeableState: "dirty" });

    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("redispatch");
    expect(state.finalMergeVerifyAttempts).toBe(1);
    // Check the failure reason includes mergeableState detail
    expect(eventSpy.mock.calls[0][0].message).toContain("mergeable_state: dirty");
  });

  test("returns hold at max retries for final-merge", () => {
    const state = makeFinalMergeDoneState({ finalMergeVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1 });
    verificationSpy.mockReturnValue({ exists: false, reason: "404" });

    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("hold");
    expect(state.finalMergeVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
  });
});

// ===========================================================================
// skipToPhase — lifecycle cleanup
// ===========================================================================

describe("skipToPhase", () => {
  test("clears turnLifecycle and resets status for all agents", () => {
    const harnessDir = makeTmpDir();
    const slot = 99;
    mkdirSync(join(harnessDir, "orchestration"), { recursive: true });

    const state: OrchestrationState = {
      ...makeState({ phase: "work" }),
      slot,
    };
    // Give both agents stale settled lifecycles
    for (const agent of state.agents) {
      const runtime = state.agentStates[agent.name];
      runtime.status = "done";
      runtime.turnLifecycle = makeLifecycle({
        state: "settled",
        observedTurnId: "turn-old",
        turnCompletedAt: new Date().toISOString(),
        completionSource: "snapshot",
      });
    }
    persistState(state, harnessDir);

    const result = skipToPhase(slot, "review", harnessDir);

    expect(result.phase).toBe("review");
    expect(result.phaseDispatched).toBe(false);

    for (const agent of result.agents) {
      const runtime = result.agentStates[agent.name];
      expect(runtime.turnLifecycle).toBeNull();
      expect(runtime.status).toBe("idle");
      expect(runtime.statusMessage).toBe("skip to review");
    }
  });
});

// ---------------------------------------------------------------------------
// gh-ludics-242: Peer-sync state reliability
// ---------------------------------------------------------------------------

describe("validatePreviousPhaseArtifacts", () => {
  let emitSpy: ReturnType<typeof spyOn>;
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("warns on missing review file", () => {
    const state = makeState({ phase: "work", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(1);
    expect((warnings[0][0] as { message: string }).message).toContain("Missing artifact from review");
    expect((warnings[0][0] as { message: string }).message).toContain("reviewer");
  });

  test("no warning when review file exists", () => {
    const state = makeState({ phase: "work", round: 1 }, dir);
    // Write the expected review file: reviews/round-1-reviewer.md
    writeFileSync(join(dir, "reviews", "round-1-reviewer.md"), "APPROVE\n");
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(0);
  });

  test("no warning for phase without required artifact (work)", () => {
    const state = makeState({ phase: "review", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "work", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(0);
  });

  test("warns on malformed .pr file after pr-create", () => {
    const state = makeState({ phase: "pr-comments", round: 1 }, dir);
    writeFileSync(join(dir, "coder.pr"), "# My PR\nSome markdown body\n");
    const ctx: PreviousPhaseContext = { phase: "pr-create", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(1);
    expect((warnings[0][0] as { message: string }).message).toContain("Invalid artifact from pr-create");
    expect((warnings[0][0] as { message: string }).message).toContain("non-URL content");
  });

  test("skips non-participating agents", () => {
    // Coder does not participate in review phase
    const state = makeState({ phase: "work", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    // Only reviewer participates in review — only one warning for reviewer's missing artifact
    expect(warnings.length).toBe(1);
    expect((warnings[0][0] as { message: string }).message).toContain("reviewer");
    expect((warnings[0][0] as { message: string }).message).not.toContain("coder");
  });

  test("uses ctx.round not state.round for artifact path", () => {
    // Simulate review→work transition where state.round was incremented to 2
    // but the review artifact was written for round 1.
    const state = makeState({ phase: "work", round: 2 }, dir);
    // Write review file for round 1 (the ctx round)
    writeFileSync(join(dir, "reviews", "round-1-reviewer.md"), "APPROVE\n");
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    // Should find the file at round 1, no warning
    expect(warnings.length).toBe(0);
  });
});

describe("validateAgentPrFiles (eager repair)", () => {
  let fixSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let configSpy: ReturnType<typeof spyOn>;
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    configSpy = spyOn(config, "findProjectConfig").mockReturnValue({ repo: "org/test-repo", name: "test" } as any);
  });
  afterEach(() => {
    fixSpy?.mockRestore();
    notifySpy.mockRestore();
    configSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("eagerly repairs malformed .pr file even when turn not settled", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue("https://github.com/org/repo/pull/1");
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    // Agent has no lifecycle (not settled)
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "# My PR\nSome markdown body\n");
    validateAgentPrFiles(state);
    expect(fixSpy).toHaveBeenCalled();
    expect(fixSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "org/test-repo"
    );
    expect(state.agentStates.coder.prUrl).toBe("https://github.com/org/repo/pull/1");
  });

  test("does not call repair for valid URL", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue("https://github.com/org/repo/pull/1");
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "https://github.com/org/repo/pull/1\n");
    validateAgentPrFiles(state);
    // Valid URL — eager path skips, settled-mode also skips (not settled)
    expect(fixSpy).not.toHaveBeenCalled();
  });

  test("does not call repair when .pr doesn't exist and turn not settled", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    // No .pr file written
    validateAgentPrFiles(state);
    expect(fixSpy).not.toHaveBeenCalled();
  });

  test("calls repair when .pr doesn't exist but turn is settled", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "settled" });
    state.agentStates.coder.status = "pr-create-done";
    validateAgentPrFiles(state);
    expect(fixSpy).toHaveBeenCalled();
    expect(fixSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "org/test-repo"
    );
  });

  test("skips empty .pr file", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "");
    validateAgentPrFiles(state);
    // Empty file — eager path skips (content falsy), settled-mode skips (not settled)
    expect(fixSpy).not.toHaveBeenCalled();
  });

  test("repair failure does not set prUrl or notify", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "# Bad PR body\n");
    validateAgentPrFiles(state);
    expect(fixSpy).toHaveBeenCalled();
    expect(fixSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "org/test-repo"
    );
    expect(state.agentStates.coder.prUrl).toBeFalsy();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe("validateAndFixPrFile --repo argument", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => {
    spawnSpy?.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes --repo when repo argument provided", () => {
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: true, stdout: "https://github.com/org/repo/pull/42", stderr: "",
    } as any);
    const prFile = join(dir, "test.pr");
    writeFileSync(prFile, "# My PR\nSome description\n");

    const result = github.validateAndFixPrFile(prFile, "/tmp/wt", "my-branch", "org/repo");

    const ghCall = spawnSpy.mock.calls.find(
      (call: any) => Array.isArray(call[0]) && call[0][0] === "gh"
    );
    expect(ghCall).toBeDefined();
    expect(ghCall![0]).toContain("--repo");
    expect(ghCall![0]).toContain("org/repo");
    expect(result).toBe("https://github.com/org/repo/pull/42");
  });

  test("omits --repo when repo argument not provided", () => {
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: true, stdout: "https://github.com/org/repo/pull/42", stderr: "",
    } as any);
    const prFile = join(dir, "test.pr");
    writeFileSync(prFile, "# My PR\nSome description\n");

    github.validateAndFixPrFile(prFile, "/tmp/wt", "my-branch");

    const ghCall = spawnSpy.mock.calls.find(
      (call: any) => Array.isArray(call[0]) && call[0][0] === "gh"
    );
    expect(ghCall).toBeDefined();
    expect(ghCall![0]).not.toContain("--repo");
  });
});

describe("phase-entry status reset", () => {
  test("status file written with {phase}-pending on phase entry", () => {
    const dir = makeTmpDir();
    try {
      const state = makeState({ phase: "work", round: 1 }, dir);
      // Write a stale status file from previous phase
      writeFileSync(join(dir, "coder.status"), "plan-done|1713000000000|completed\n");
      writeFileSync(join(dir, "reviewer.status"), "plan-done|1713000000000|completed\n");

      // Simulate what enterPhase does: reset participating agents' status files.
      // Since enterPhase is private, we test the observable filesystem effect
      // by running the same logic inline.
      const { agentParticipatesInPhase } = require("./phases.ts");
      if (state.phase !== "pr-comments") {
        for (const agent of state.agents) {
          if (!agentParticipatesInPhase(state, agent)) continue;
          const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
          const nowSec = Math.floor(Date.now() / 1000);
          const resetValue = `${state.phase}-pending|${nowSec}|awaiting`;
          writeFileSync(statusPath, resetValue);
        }
      }

      // Coder participates in work → status should be reset
      const coderStatus = readFileSync(join(dir, "coder.status"), "utf-8");
      expect(coderStatus).toMatch(/^work-pending\|\d+\|awaiting$/);

      // Reviewer does NOT participate in work → status should be unchanged
      const reviewerStatus = readFileSync(join(dir, "reviewer.status"), "utf-8");
      expect(reviewerStatus).toContain("plan-done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pr-comments phase resets then writes done status for participating agents", () => {
    const dir = makeTmpDir();
    try {
      const state = makeState({ phase: "pr-comments", round: 1 }, dir);
      // Write stale status from previous phase
      writeFileSync(join(dir, "coder.status"), "pr-create-done|1713000000000|done\n");

      // Simulate what enterPhase does for pr-comments:
      // 1. Reset all participating agents (same as every other phase)
      const { agentParticipatesInPhase } = require("./phases.ts");
      for (const agent of state.agents) {
        if (!agentParticipatesInPhase(state, agent)) continue;
        const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
        const nowSec = Math.floor(Date.now() / 1000);
        writeFileSync(statusPath, `${state.phase}-pending|${nowSec}|awaiting`);
      }
      // 2. pr-comments early return writes done status so agents appear done
      for (const agent of state.agents) {
        if (!agentParticipatesInPhase(state, agent)) continue;
        const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
        const nowSec = Math.floor(Date.now() / 1000);
        writeFileSync(statusPath, `pr-comments-done|${nowSec}|awaiting-comments`);
      }

      // Status should be pr-comments-done (not the stale pr-create-done)
      const coderStatus = readFileSync(join(dir, "coder.status"), "utf-8");
      expect(coderStatus).toMatch(/^pr-comments-done\|\d+\|awaiting-comments$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fingerprint after reset differs from pre-reset fingerprint", () => {
    const dir = makeTmpDir();
    try {
      // Write stale status
      writeFileSync(join(dir, "coder.status"), "plan-done|1713000000000|completed\n");
      const { statusFileFingerprint } = require("./peer-sync.ts");
      const preResetFp = statusFileFingerprint(dir, "coder");

      // Reset
      const nowSec = Math.floor(Date.now() / 1000);
      writeFileSync(join(dir, "coder.status"), `work-pending|${nowSec}|awaiting`);
      const postResetFp = statusFileFingerprint(dir, "coder");

      expect(postResetFp).not.toBe(preResetFp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crash recovery: does not clobber done status for already-dispatched agents", () => {
    const dir = makeTmpDir();
    try {
      const phaseToken = "phase-crash-test";
      const state = makeState({ phase: "work", round: 1 }, dir);
      // Simulate: agent was dispatched for this phaseToken, then orchestrator crashed.
      // While down, the agent wrote a done status.
      state.agentStates.coder.turnLifecycle = makeLifecycle({
        phaseToken,
        state: "dispatched",
      });
      const doneStatus = "work-done|1713000099|coder work complete";
      writeFileSync(join(dir, "coder.status"), doneStatus);

      // Simulate the new dispatch loop logic: status reset happens AFTER dedup
      // checks, so agents that pass the dedup check (already dispatched) are
      // skipped entirely — their status files are never touched.
      const { agentParticipatesInPhase } = require("./phases.ts");
      for (const agent of state.agents) {
        if (!agentParticipatesInPhase(state, agent)) continue;
        // Dedup check: skip agents already dispatched for this phase token
        const existing = state.agentStates[agent.name]?.turnLifecycle;
        if (existing && existing.state === "dispatched" && existing.phaseToken === phaseToken) {
          continue;
        }
        // Only reset status for agents that will actually be (re)dispatched
        const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
        const nowSec = Math.floor(Date.now() / 1000);
        writeFileSync(statusPath, `${state.phase}-pending|${nowSec}|awaiting`);
      }

      // Coder was already dispatched → done status must be preserved
      const coderStatus = readFileSync(join(dir, "coder.status"), "utf-8");
      expect(coderStatus).toBe(doneStatus);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crash recovery: resets status for agents NOT yet dispatched under current token", () => {
    const dir = makeTmpDir();
    try {
      const phaseToken = "phase-partial-crash";
      // Use "plan" phase where both agents participate
      const state = makeState({ phase: "plan", round: 1 }, dir);

      // Coder was dispatched, reviewer was not (crash happened between dispatches)
      state.agentStates.coder.turnLifecycle = makeLifecycle({
        phaseToken,
        state: "dispatched",
      });
      // Reviewer has no lifecycle for this token (wasn't dispatched yet)
      state.agentStates.reviewer.turnLifecycle = null;

      // Coder finished while orchestrator was down
      const coderDone = "plan-done|1713000099|plan written";
      writeFileSync(join(dir, "coder.status"), coderDone);
      // Reviewer has stale status from previous phase
      writeFileSync(join(dir, "reviewer.status"), "setup-done|1713000000|completed");

      // Simulate the new dispatch loop logic: dedup check then reset
      const { agentParticipatesInPhase } = require("./phases.ts");
      for (const agent of state.agents) {
        if (!agentParticipatesInPhase(state, agent)) continue;
        const existing = state.agentStates[agent.name]?.turnLifecycle;
        if (existing && existing.state === "dispatched" && existing.phaseToken === phaseToken) {
          continue;
        }
        const statusPath = join(state.peerSyncDir, `${agent.name}.status`);
        const nowSec = Math.floor(Date.now() / 1000);
        writeFileSync(statusPath, `${state.phase}-pending|${nowSec}|awaiting`);
      }

      // Coder: dispatched → preserved
      expect(readFileSync(join(dir, "coder.status"), "utf-8")).toBe(coderDone);
      // Reviewer: not dispatched → reset
      expect(readFileSync(join(dir, "reviewer.status"), "utf-8")).toMatch(/^plan-pending\|\d+\|awaiting$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("previousPhaseCtx persistence", () => {
  test("previousPhaseCtx survives persist/read round-trip", () => {
    const dir = makeTmpDir();
    const harnessDir = makeTmpDir();
    try {
      const state = makeState({ phase: "work", round: 2 }, dir);
      state.previousPhaseCtx = { phase: "review", round: 1, planMergeRound: 0 };

      // Persist to temp harness dir and read back
      const { readOrchestrationState } = require("./state.ts");
      persistState(state, harnessDir);
      const restored = readOrchestrationState(state.slot, harnessDir);

      expect(restored).not.toBeNull();
      expect(restored!.previousPhaseCtx).toEqual({ phase: "review", round: 1, planMergeRound: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  test("validatePreviousPhaseArtifacts reads from state.previousPhaseCtx", () => {
    const dir = makeTmpDir();
    const emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    try {
      // State is in "work" phase round 2, but previousPhaseCtx points to "review" round 1
      const state = makeState({ phase: "work", round: 2 }, dir);
      state.previousPhaseCtx = { phase: "review", round: 1, planMergeRound: 0 };

      // No review file for round 1 → should warn
      validatePreviousPhaseArtifacts(state, state.previousPhaseCtx);
      const warnings = emitSpy.mock.calls.filter(
        (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
      );
      expect(warnings.length).toBe(1);
      expect((warnings[0][0] as { message: string }).message).toContain("Missing artifact from review");
    } finally {
      emitSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
