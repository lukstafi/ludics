import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isAgentDone, pairReviewVerdict } from "./phases.ts";
import { updateTurnLifecycle, T3CodeTransport } from "./transport-t3code.ts";
import { refreshAgentStatuses, maybePostCodexReviewRequests, autoCommitAgent, autoCommitAllAgents, detectAndNudgeHungAgents, interruptAgent } from "./runner.ts";
import * as events from "../events.ts";
import * as github from "./github.ts";
import { orchOnStop } from "./index.ts";
import { readStopHookRecord, writeStopHookRecord, writeAgentMarkerFiles, readAgentMarkerFile } from "./peer-sync.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type AgentTurnLifecycle, type OrchestrationState } from "./state.ts";
import type { T3Snapshot, T3ThreadSession, T3LatestTurn } from "../t3code/types.ts";
import type { OrchestrationTransport } from "./transport.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ludics-runner-test-"));
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
    feature: "feat",
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
                task: state.feature,
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
                task: state.feature,
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
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "dispatched" });

    await refreshAgentStatuses(state, makeMockTransport(null));

    // Read the events journal to verify a warning was emitted.
    const eventsPath = join(tmpDir, "harness", "journal", "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const warning = events.find((e: { event_type?: string }) => e.event_type === "orchestration_warning");
    expect(warning).toBeDefined();
    expect(warning.message).toContain('peer-sync says "done"');
    expect(warning.message).toContain('"dispatched"');
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
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-123",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "done";
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
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
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-plan",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "plan-done";
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("plan phase: plan file exists → done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-plan",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "plan-done";
    writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), "# Plan\n");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("plan-review phase: requires review file (not plan file)", () => {
    // planMergeRound defaults to 0, so the required file is plan-merge-0-reviewer.md
    const state = makeState({ phase: "plan-review", planMergeRound: 0 }, tmpDir);
    const reviewer = state.agents[1]!;
    state.agentStates.reviewer.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-plan-review",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.reviewer.status = "plan-review-done";

    // Plan file exists but review file doesn't — should NOT be done.
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Plan\n");
    expect(isAgentDone(state, reviewer)).toBe(false);

    // Now create the per-iteration review file — should be done.
    writeFileSync(join(tmpDir, "reviews", "plan-merge-0-reviewer.md"), "APPROVE\n");
    expect(isAgentDone(state, reviewer)).toBe(true);
  });

  test("review phase: missing review file → not done", () => {
    const state = makeState({ phase: "review" }, tmpDir);
    const reviewer = state.agents[1]!;
    state.agentStates.reviewer.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-review",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.reviewer.status = "review-done";
    expect(isAgentDone(state, reviewer)).toBe(false);
  });

  test("review phase: review file exists → done", () => {
    const state = makeState({ phase: "review" }, tmpDir);
    const reviewer = state.agents[1]!;
    state.agentStates.reviewer.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-review",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.reviewer.status = "review-done";
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "# Review\nAPPROVE\n");
    expect(isAgentDone(state, reviewer)).toBe(true);
  });

  test("pr-create phase: missing .pr file → not done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-pr",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "pr-create-done";
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("pr-create phase: .pr file with valid URL → done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-pr",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "pr-create-done";
    writeFileSync(join(tmpDir, "coder.pr"), "https://github.com/org/repo/pull/1\n");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("pr-create phase: .pr file with malformed body (not a URL) → not done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-pr",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "pr-create-done";
    writeFileSync(join(tmpDir, "coder.pr"), "# My PR\n\nThis is a PR body, not a URL.\n");
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("work phase: no artifact required → done with just done status", () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-work",
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
    });
    state.agentStates.coder.status = "done";
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
  let postSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    postSpy = spyOn(github, "postCodexReviewComment").mockReturnValue(true);
  });

  afterEach(() => {
    postSpy.mockRestore();
  });

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

  test("posts on pr-create -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "pr-create" });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![0]).toBe("https://github.com/test/repo/pull/42");
  });

  test("posts on update-docs -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "update-docs" });
    maybePostCodexReviewRequests(state, "update-docs", "pr-comments");
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test("posts on review -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "review" });
    maybePostCodexReviewRequests(state, "review", "pr-comments");
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test("does NOT post on merge-review -> pr-comments", () => {
    const state = makeCodexState({ phase: "merge-review" });
    maybePostCodexReviewRequests(state, "merge-review", "pr-comments");
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("does NOT post when reviewer provider is claude-code", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("does NOT post when coder is codex but reviewer is claude-code", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "codex", role: "coder", model: "o3-pro", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("does NOT post when next phase is not pr-comments", () => {
    const state = makeCodexState({ phase: "pr-create" });
    maybePostCodexReviewRequests(state, "pr-create", "work");
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("de-duplicates identical PR URLs", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agentStates: {
        coder: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
        },
        reviewer: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
        },
      },
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test("posts once per distinct PR URL", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agentStates: {
        coder: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
        },
        reviewer: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/43", interrupted: false,
        },
      },
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  test("skips agents without a prUrl", () => {
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
    expect(postSpy).not.toHaveBeenCalled();
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

  test("commit message format: '<agent> <phase>: <statusMessage>'", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "msg-fmt");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "implemented tensor syntax", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("coder work: implemented tensor syntax");
  });

  test("falls back to WIP when statusMessage is empty", () => {
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
    expect(gitLastCommitMsg(repo)).toBe("reviewer review: WIP");
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
    expect(gitLastCommitMsg(repo)).toBe("coder work: line1 line2 line3");
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
    expect(gitLastCommitMsg(repo)).toBe("reviewer work: reviewed it");
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
    expect(gitLastCommitMsg(repo1)).toBe("coder work: coded");
    expect(gitLastCommitMsg(repo2)).toBe("reviewer work: reviewed");
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
      nudgeAttempts: 2, // >= MAX_NUDGE_ATTEMPTS
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
