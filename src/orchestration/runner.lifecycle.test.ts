import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isAgentDone } from "./phases.ts";
import * as phases from "./phases.ts";
import { updateTurnLifecycle } from "./transport-t3code.ts";
import { detectAndNudgeSettledNoSignal, detectAndRecoverVanishedTmuxSessions, ensureTtydAlive, refreshAgentStatuses, runOrchestration, runWrongFilenameRecovery, __resetTtydCheckGateForTests, __resetVanishedRecoveryStateForTests } from "./runner.ts";
import * as tmuxAdapter from "../adapters/tmux-adapter.ts";
import * as tmux from "../adapters/tmux.ts";
import * as notify from "../notify.ts";
import * as t3codeServer from "../t3code/server.ts";
import * as orchUtil from "./util.ts";
import * as wfr from "./wrong-filename-recovery.ts";
import * as peerSync from "./peer-sync.ts";
import * as events from "../events.ts";
import { orchOnStop } from "./index.ts";
import { readStopHookRecord, writeStopHookRecord, writeAgentMarkerFiles, readAgentMarkerFile } from "./peer-sync.ts";
import type { T3Snapshot } from "../t3code/types.ts";
import type { OrchestrationTransport } from "./transport.ts";
import {
  makeTmpDir,
  makeLifecycle,
  makeState,
  markAgentDone,
  makePeerSyncDir,
  makeSnapshot,
  makeMockTransport,
  noopTransport,
} from "./runner.test-helpers.ts";

setDefaultTimeout(20_000);

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
// resolvePrUrl — gh pr list fallback when .pr file is missing/blank/markdown
// (task-bce80781 AC (a)). Heals all three failure hypotheses: no .pr written,
// validateAgentPrFiles not invoked, gh pr create silent fail.
// ===========================================================================

describe("resolvePrUrl — branch-name fallback (gh-bce80781)", () => {
  let tmpDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("blank .pr file falls back to gh pr list and persists URL to disk", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "pr-comments-done|0|done" });
    // Write a blank .pr file — simulates the "PR exists on GitHub but the
    // agent never wrote the markdown body" hypothesis.
    writeFileSync(join(peerSyncDir, "coder.pr"), "");
    const recoveredUrl = "https://github.com/lukstafi/ludics/pull/482";
    const spawn = await import("../spawn.ts");
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: true, exitCode: 0, stdout: recoveredUrl, stderr: "", timedOut: false,
    });

    const state = makeState({ phase: "pr-comments" }, peerSyncDir);
    state.agents[0]!.branch = "ludics/task-4028c493-s2/root";
    state.agents[0]!.worktreePath = tmpDir;

    // Drive the real refreshAgentStatuses path (which calls resolvePrUrl).
    await refreshAgentStatuses(state, makeMockTransport(null));

    // Invariant 1: runtime.prUrl is the recovered URL.
    expect(state.agentStates.coder.prUrl).toBe(recoveredUrl);
    // Invariant 2: .pr file on disk now contains the URL (so subsequent polls
    // hit the fast path and never re-shell-out).
    expect(readFileSync(join(peerSyncDir, "coder.pr"), "utf-8").trim()).toBe(recoveredUrl);
    // Invariant 3: the gh pr list call was issued exactly once with --head <branch>.
    const ghCalls = spawnSpy.mock.calls.filter((c: any) =>
      Array.isArray(c[0]) && c[0][0] === "gh" && c[0][2] === "list"
      && c[0].includes("--head") && c[0].includes(state.agents[0]!.branch));
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]![0]).toContain("--head");
    expect(ghCalls[0]![0]).toContain("ludics/task-4028c493-s2/root");
  });

  test("missing .pr file falls back to gh pr list", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "pr-comments-done|0|done" });
    // No .pr file written at all — the "agent never wrote the file" hypothesis.
    const recoveredUrl = "https://github.com/lukstafi/ludics/pull/482";
    const spawn = await import("../spawn.ts");
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: true, exitCode: 0, stdout: recoveredUrl, stderr: "", timedOut: false,
    });

    const state = makeState({ phase: "pr-comments" }, peerSyncDir);
    state.agents[0]!.branch = "feat/something";
    state.agents[0]!.worktreePath = tmpDir;

    await refreshAgentStatuses(state, makeMockTransport(null));

    expect(state.agentStates.coder.prUrl).toBe(recoveredUrl);
    expect(readFileSync(join(peerSyncDir, "coder.pr"), "utf-8").trim()).toBe(recoveredUrl);
  });

  test("valid .pr file fast path: no shell-out", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "pr-comments-done|0|done" });
    const existingUrl = "https://github.com/lukstafi/ludics/pull/100";
    writeFileSync(join(peerSyncDir, "coder.pr"), existingUrl + "\n");
    const spawn = await import("../spawn.ts");
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: false, exitCode: -1, stdout: "", stderr: "should not be called", timedOut: false,
    });

    const state = makeState({ phase: "pr-comments" }, peerSyncDir);
    state.agents[0]!.branch = "feat/something";
    state.agents[0]!.worktreePath = tmpDir;

    await refreshAgentStatuses(state, makeMockTransport(null));

    expect(state.agentStates.coder.prUrl).toBe(existingUrl);
    // No `gh pr list` call: the fast path returned the URL.
    const ghCalls = spawnSpy.mock.calls.filter((c: any) =>
      Array.isArray(c[0]) && c[0][0] === "gh" && c[0][2] === "list"
      && c[0].includes("--head") && c[0].includes(state.agents[0]!.branch));
    expect(ghCalls).toHaveLength(0);
  });

  test("gh pr list non-zero exit returns null and preserves prior runtime.prUrl", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "pr-comments-done|0|done" });
    writeFileSync(join(peerSyncDir, "coder.pr"), "");
    const spawn = await import("../spawn.ts");
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: false, exitCode: 1, stdout: "", stderr: "auth failure", timedOut: false,
    });

    const state = makeState({ phase: "pr-comments" }, peerSyncDir);
    state.agents[0]!.branch = "feat/something";
    state.agents[0]!.worktreePath = tmpDir;
    state.agentStates.coder.prUrl = "https://github.com/o/r/pull/77"; // pre-existing in-memory value

    await refreshAgentStatuses(state, makeMockTransport(null));

    // Invariant: caller's `?? runtime.prUrl` preserves the previous value
    // when fallback fails — error path is neutral, no exception.
    expect(state.agentStates.coder.prUrl).toBe("https://github.com/o/r/pull/77");
    // .pr file remains blank (no successful URL to write back).
    expect(readFileSync(join(peerSyncDir, "coder.pr"), "utf-8")).toBe("");
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
// runOrchestration self-guard — exits when sibling slot state is reaped
// ===========================================================================


describe("runOrchestration self-guard (task-72a318c3)", () => {
  let origHarnessDir: string | undefined;
  let origStartupGrace: string | undefined;
  let harness: string;
  let peerSyncDir: string;

  beforeEach(() => {
    const tmpDir = makeTmpDir();
    harness = join(tmpDir, "harness");
    peerSyncDir = join(tmpDir, "peer-sync");
    mkdirSync(join(harness, "orchestration"), { recursive: true });
    mkdirSync(join(harness, "t3code"), { recursive: true });
    mkdirSync(join(peerSyncDir, "plans"), { recursive: true });
    mkdirSync(join(peerSyncDir, "reviews"), { recursive: true });
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = harness;
    // Disable startup grace for these unit tests — the grace window exists for
    // the production startup race between spawn and writeTmuxSlotState, not for
    // the reap-mid-run scenario these tests cover.
    origStartupGrace = process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "0";
  });

  afterEach(() => {
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
    if (origStartupGrace !== undefined) process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = origStartupGrace;
    else delete process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
  });

  function stubTransport(): OrchestrationTransport {
    // Minimal transport that would satisfy runOrchestration if called — but the
    // self-guard fires before enterPhase, so these methods should not be hit.
    return {
      sendPrompt: async () => {},
      pollOnce: async () => ({ turns: [], snapshot: null as unknown as T3Snapshot }),
      cleanup: async () => {},
    } as unknown as OrchestrationTransport;
  }

  test("exits after grace window when tmux sibling state is missing", async () => {
    const state = makeState({ slot: 3, backend: "tmux", phase: "work" }, peerSyncDir);
    // No tmux-slot-3.json written + grace=0 → guard should fire immediately.
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runOrchestration(state, stubTransport());
      const msgs = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(msgs.some((m: string) => m.includes("sibling state missing"))).toBe(true);
      expect(msgs.some((m: string) => m.includes("slot 3"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("waits for the startup grace window before exiting on missing sibling state", async () => {
    // With grace=600ms and the file never appearing, the runner must wait
    // roughly 600ms before logging "exiting" — not fire immediately.
    // This is the fix for the P1 startup-race (PR #357 review): the adapter
    // writes tmux-slot-<N>.json AFTER startOrchestrationProcess returns, so
    // the child must tolerate a brief absence.
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "600";
    const state = makeState({ slot: 7, backend: "tmux", phase: "work" }, peerSyncDir);

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const before = Date.now();
    try {
      await runOrchestration(state, stubTransport());
      const elapsed = Date.now() - before;
      // Must have waited at least most of the grace window.
      expect(elapsed).toBeGreaterThan(400);
      const msgs = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(msgs.some((m: string) => m.includes("sibling state missing after"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("resumes normally when sibling state appears during the startup grace window", async () => {
    // Grace=600ms; write the file after 150ms with our own PID. The guard
    // must accept the file on a subsequent re-check and proceed past it.
    // We prove "proceeded past" by observing that the "sibling state missing"
    // log never fired. (Full loop execution after the guard is covered by
    // other tests; here we only care the guard doesn't kill a healthy runner.)
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "600";
    const state = makeState({ slot: 9, backend: "tmux", phase: "work" }, peerSyncDir);

    const writeAfter = setTimeout(() => {
      writeFileSync(
        join(harness, "orchestration", "tmux-slot-9.json"),
        JSON.stringify({
          orchestration: { pid: process.pid, stateFile: "x", mode: "pair" },
          sessionNames: { coder: "s", reviewer: "r" },
          ttydPids: {},
        }),
      );
    }, 150);

    // Once past the guard, runOrchestration calls enterPhase and beyond. That
    // touches a lot of state — simplest way to end the test deterministically
    // is to let runOrchestration throw or hang briefly, then cancel.
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const runPromise = runOrchestration(state, stubTransport()).catch(() => {});
    // Race against a 1.5s timeout — if the guard kills the runner, runPromise
    // resolves within ~600ms with the "exiting" log. If it proceeds, it will
    // hang or throw somewhere in enterPhase.
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 1500))]);

    try {
      const msgs = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(msgs.some((m: string) => m.includes("slot 9") && m.includes("sibling state missing"))).toBe(false);
      expect(msgs.some((m: string) => m.includes("slot 9") && m.includes("PID mismatch"))).toBe(false);
    } finally {
      clearTimeout(writeAfter);
      errSpy.mockRestore();
    }
  });

  test("exits early when tmux sibling state has a mismatched PID", async () => {
    const state = makeState({ slot: 4, backend: "tmux", phase: "work" }, peerSyncDir);
    const wrongPid = process.pid + 1;
    const tmuxSlotPath = join(harness, "orchestration", "tmux-slot-4.json");
    writeFileSync(
      tmuxSlotPath,
      JSON.stringify({
        orchestration: { pid: wrongPid, stateFile: "x", mode: "pair" },
        sessionNames: { coder: "s", reviewer: "r" },
        ttydPids: {},
      }),
    );
    // gh-ludics-509: ensure the seeded wrong PID is treated as live so the
    // reclaim path doesn't fire (defends against host PID-recycling flakes).
    const aliveSpy = spyOn(t3codeServer, "processAlive").mockImplementation(() => true);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runOrchestration(state, stubTransport());
      const msgs = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(msgs.some((m: string) => m.includes("PID mismatch"))).toBe(true);
      expect(msgs.some((m: string) => m.includes(String(process.pid)))).toBe(true);
    } finally {
      errSpy.mockRestore();
      aliveSpy.mockRestore();
    }
    // AC2 invariant: a live mismatch must NOT rewrite the sibling state.
    // (A mutation that wrote `process.pid` and then logged/returned would
    // still fire the "PID mismatch" log above; this assertion catches it.)
    const persisted = JSON.parse(readFileSync(tmuxSlotPath, "utf-8"));
    expect(persisted.orchestration.pid).toBe(wrongPid);
  });

  test("PID mismatch exits immediately even during the startup grace window", async () => {
    // Grace only covers missing-file races; a live PID mismatch is a real
    // conflict (parent always writes our own pid) and must exit without waiting.
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "60000";
    const state = makeState({ slot: 8, backend: "tmux", phase: "work" }, peerSyncDir);
    const wrongPid = process.pid + 1;
    const tmuxSlotPath = join(harness, "orchestration", "tmux-slot-8.json");
    writeFileSync(
      tmuxSlotPath,
      JSON.stringify({
        orchestration: { pid: wrongPid, stateFile: "x", mode: "pair" },
        sessionNames: { coder: "s", reviewer: "r" },
        ttydPids: {},
      }),
    );
    const aliveSpy = spyOn(t3codeServer, "processAlive").mockImplementation(() => true);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const before = Date.now();
    try {
      await runOrchestration(state, stubTransport());
      const elapsed = Date.now() - before;
      expect(elapsed).toBeLessThan(1000); // definitely did not wait 60s
      const msgs = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(msgs.some((m: string) => m.includes("PID mismatch"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      aliveSpy.mockRestore();
    }
    // AC2 invariant: live mismatch must NOT rewrite the sibling state.
    const persisted = JSON.parse(readFileSync(tmuxSlotPath, "utf-8"));
    expect(persisted.orchestration.pid).toBe(wrongPid);
  });

  test("exits early when t3code sibling state has a mismatched PID", async () => {
    const state = makeState({ slot: 5, backend: "t3code", phase: "work" }, peerSyncDir);
    const wrongPid = process.pid + 1;
    const t3codeSlotPath = join(harness, "t3code", "slot-5.json");
    writeFileSync(
      t3codeSlotPath,
      JSON.stringify({
        orchestration: { pid: wrongPid, stateFile: "x", mode: "pair" },
        threads: [],
      }),
    );
    const aliveSpy = spyOn(t3codeServer, "processAlive").mockImplementation(() => true);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runOrchestration(state, stubTransport());
      const msgs = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(msgs.some((m: string) => m.includes("PID mismatch"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      aliveSpy.mockRestore();
    }
    // AC2 invariant: live mismatch must NOT rewrite the sibling state.
    const persisted = JSON.parse(readFileSync(t3codeSlotPath, "utf-8"));
    expect(persisted.orchestration.pid).toBe(wrongPid);
  });

  // ------------------------------------------------------------------------
  // gh-ludics-509: stale sibling-PID lock reclaim — runner self-heals when
  // the recorded sibling pid is dead (the bug that wedged slot 1 in setup).
  // ------------------------------------------------------------------------

  test("reclaims stale tmux sibling lock when recorded PID is dead", async () => {
    const DEAD_PID = 2147483647; // sentinel; AC1 falsifier seed.
    const SLOT = 11;
    writeFileSync(
      join(harness, "orchestration", `tmux-slot-${SLOT}.json`),
      JSON.stringify({
        slot: SLOT,
        orchestration: { pid: DEAD_PID, stateFile: "x", mode: "pair" },
        sessionNames: { coder: "s" },
        ttydPids: {},
      }),
    );
    // Empty-agents `setup` phase — completes one phase deterministically:
    // enterPhase returns at the setup early-return; allAgentsDone is true on
    // empty participants; evaluateTransition is mocked to "done" so the
    // while-loop exits cleanly. No `.catch(() => {})`. No timeout race.
    const state = makeState(
      { slot: SLOT, backend: "tmux", phase: "setup", agents: [] },
      peerSyncDir,
    );

    const aliveSpy = spyOn(t3codeServer, "processAlive")
      .mockImplementation((p: number) => p !== DEAD_PID);
    const transitionSpy = spyOn(phases, "evaluateTransition").mockReturnValue("done");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const transport: OrchestrationTransport = {
      async sendTurn() { return "cmd-stub"; },
      async refreshAgentTransportState() { /* no-op */ },
      async sendEnter() { /* no-op */ },
      async interruptAgent() { /* no-op */ },
    };

    let errMessages: string[] = [];
    let transitionCalls = 0;
    try {
      await runOrchestration(state, transport);
      // Capture spy state BEFORE mockRestore (bun:test wipes call history).
      errMessages = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      transitionCalls = transitionSpy.mock.calls.length;
    } finally {
      aliveSpy.mockRestore();
      transitionSpy.mockRestore();
      errSpy.mockRestore();
    }

    // AC1 phase-completion invariant: the runner falls through into
    // enterPhase / pollUntilDone / evaluateTransition (NOT just return after
    // emitEvent). If a hypothetical mutation added `return;` after the
    // reclaim emitEvent, evaluateTransition would never be called and
    // state.phase would remain "setup".
    expect(transitionCalls).toBeGreaterThan(0);
    expect(state.phase).toBe("done");

    // AC1: sibling state file rewritten with our pid.
    const persisted = JSON.parse(
      readFileSync(join(harness, "orchestration", `tmux-slot-${SLOT}.json`), "utf-8"),
    );
    expect(persisted.orchestration.pid).toBe(process.pid);
    // Negative control on the spread: untouched fields survive.
    expect(persisted.sessionNames.coder).toBe("s");
    expect(persisted.orchestration.mode).toBe("pair");

    // AC4: journal event emitted with the expected fields.
    const eventsPath = join(harness, "journal", "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    const journal = readFileSync(eventsPath, "utf-8")
      .trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const reclaim = journal.find((e) => e.event_type === "orchestration_lock_reclaimed");
    expect(reclaim).toBeDefined();
    expect(reclaim!.slot).toBe(SLOT);
    expect(reclaim!.deadPid).toBe(DEAD_PID);
    expect(reclaim!.newPid).toBe(process.pid);
    expect(reclaim!.backend).toBe("tmux");

    // The reclaim console log fired; the live-mismatch exit log did NOT.
    expect(errMessages.some((m) =>
      m.includes("reclaiming stale lock")
      && m.includes(String(DEAD_PID))
      && m.includes(String(process.pid))
    )).toBe(true);
    expect(errMessages.some((m) =>
      m.includes("PID mismatch") && m.includes("exiting")
    )).toBe(false);
  });

  test("reclaims stale t3code sibling lock when recorded PID is dead", async () => {
    const DEAD_PID = 2147483647;
    const SLOT = 12;
    writeFileSync(
      join(harness, "t3code", `slot-${SLOT}.json`),
      JSON.stringify({
        slot: SLOT,
        threads: [],
        orchestration: { pid: DEAD_PID, stateFile: "x", mode: "pair" },
      }),
    );
    const state = makeState(
      { slot: SLOT, backend: "t3code", phase: "setup", agents: [] },
      peerSyncDir,
    );

    const aliveSpy = spyOn(t3codeServer, "processAlive")
      .mockImplementation((p: number) => p !== DEAD_PID);
    const transitionSpy = spyOn(phases, "evaluateTransition").mockReturnValue("done");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const transport: OrchestrationTransport = {
      async sendTurn() { return "cmd-stub"; },
      async refreshAgentTransportState() { /* no-op */ },
      async sendEnter() { /* no-op */ },
      async interruptAgent() { /* no-op */ },
    };

    let errMessages: string[] = [];
    let transitionCalls = 0;
    try {
      await runOrchestration(state, transport);
      errMessages = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      transitionCalls = transitionSpy.mock.calls.length;
    } finally {
      aliveSpy.mockRestore();
      transitionSpy.mockRestore();
      errSpy.mockRestore();
    }

    // AC3 phase-completion invariant (parallel to AC1): the runner falls
    // through into evaluateTransition rather than returning after emitEvent.
    expect(transitionCalls).toBeGreaterThan(0);
    expect(state.phase).toBe("done");

    // AC3: read back via readSlotState (round-trip through the t3code reader).
    const persisted = t3codeServer.readSlotState(SLOT, harness);
    expect(persisted).not.toBeNull();
    expect(persisted!.orchestration?.pid).toBe(process.pid);
    expect(persisted!.threads).toEqual([]);

    // AC4: journal event with backend === "t3code".
    const eventsPath = join(harness, "journal", "events.jsonl");
    const journal = readFileSync(eventsPath, "utf-8")
      .trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const reclaim = journal.find((e) => e.event_type === "orchestration_lock_reclaimed");
    expect(reclaim).toBeDefined();
    expect(reclaim!.slot).toBe(SLOT);
    expect(reclaim!.deadPid).toBe(DEAD_PID);
    expect(reclaim!.newPid).toBe(process.pid);
    expect(reclaim!.backend).toBe("t3code");

    expect(errMessages.some((m) => m.includes("reclaiming stale lock"))).toBe(true);
    expect(errMessages.some((m) =>
      m.includes("PID mismatch") && m.includes("exiting")
    )).toBe(false);
  });
});

describe("runWrongFilenameRecovery — runner integration", () => {
  test("invokes recoverWrongFilename only for participating agents whose status is in DONE_STATUSES", async () => {
    const state = makeState({ phase: "plan-merge", planMergeRound: 0 });
    state.agentStates["coder"].status = "plan-merge-done";
    state.agentStates["reviewer"].status = "running"; // not a done status
    const transport: OrchestrationTransport = {
      async sendTurn() { return "cmd"; },
      async sendEnter() {},
      async refreshAgentTransportState() {},
      async interruptAgent() {},
    };
    const calls: string[] = [];
    const spy = spyOn(wfr, "recoverWrongFilename").mockImplementation(async (_s, agent) => {
      calls.push(agent.name);
      return "none";
    });
    try {
      await runWrongFilenameRecovery(state, transport);
      // Only coder participates in plan-merge AND has a done-status. Reviewer
      // doesn't participate in plan-merge at all, and isn't in DONE_STATUSES.
      expect(calls).toEqual(["coder"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("skips agents whose status is not in DONE_STATUSES even if they participate", async () => {
    const state = makeState({ phase: "plan-merge" });
    state.agentStates["coder"].status = "running";
    const transport: OrchestrationTransport = {
      async sendTurn() { return "cmd"; },
      async sendEnter() {},
      async refreshAgentTransportState() {},
      async interruptAgent() {},
    };
    const spy = spyOn(wfr, "recoverWrongFilename").mockImplementation(async () => "none");
    try {
      await runWrongFilenameRecovery(state, transport);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// task-7476a03a — flap-suppression state machine. With processAlive forced
// false and a controlled clock, the machine must (1) emit ttyd_restarted
// while count < 10 in the 10-min window, (2) emit exactly one ttyd_flapping
// at the threshold and stop calling startTtyd, (3) be silent on subsequent
// polls while suppressed, (4) restart freshly after the record is deleted,
// and (5) reset the counter rather than escalate after a >5-min quiet gap.
describe("ensureTtydAlive — flap suppression", () => {
  let tmpDir = "";
  let harness = "";
  let processAliveSpy: ReturnType<typeof spyOn>;
  let nowSpy: ReturnType<typeof spyOn>;
  let startTtydSpy: ReturnType<typeof spyOn>;
  let emitSpy: ReturnType<typeof spyOn>;
  let nowSeconds = 1700000000;
  let pidCounter = 5000;

  function advance(seconds: number): void { nowSeconds += seconds; }

  function seedSlot(slot: number, init: Partial<tmuxAdapter.TmuxSlotState> = {}): void {
    mkdirSync(join(harness, "orchestration"), { recursive: true });
    const state: tmuxAdapter.TmuxSlotState = {
      slot,
      ttydPids: { coder: 99999999 },
      ...init,
    };
    writeFileSync(
      join(harness, "orchestration", `tmux-slot-${slot}.json`),
      JSON.stringify(state),
    );
  }

  function readSlot(slot: number): tmuxAdapter.TmuxSlotState | null {
    return tmuxAdapter.readTmuxSlotState(slot, harness);
  }

  function makeTmuxState(slot: number) {
    return makeState({
      slot,
      backend: "tmux",
      taskId: "task-7476a03a",
      harnessDir: harness,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
    });
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    harness = join(tmpDir, "harness");
    mkdirSync(harness, { recursive: true });
    nowSeconds = 1700000000;
    pidCounter = 5000;
    processAliveSpy = spyOn(t3codeServer, "processAlive").mockImplementation(() => false);
    nowSpy = spyOn(orchUtil, "nowEpoch").mockImplementation(() => nowSeconds);
    // Spy startTtyd so we never actually spawn bash/ttyd.
    startTtydSpy = spyOn(tmuxAdapter, "startTtyd").mockImplementation(() => ++pidCounter);
    emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    __resetTtydCheckGateForTests();
  });

  afterEach(() => {
    processAliveSpy.mockRestore();
    nowSpy.mockRestore();
    startTtydSpy.mockRestore();
    emitSpy.mockRestore();
    __resetTtydCheckGateForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function eventTypes(): string[] {
    return emitSpy.mock.calls.map((call: unknown[]) => {
      const arg = call[0] as { event_type?: string } | undefined;
      return arg?.event_type ?? "";
    });
  }

  test("9 below-threshold polls emit ttyd_restarted, the 10th poll within 600s emits exactly one ttyd_flapping with no startTtyd call", async () => {
    seedSlot(1);
    const state = makeTmuxState(1);

    // Drive 10 polls. Advance 31s between calls so the 30-s gate passes
    // each time. firstRestartAt stays inside the 10-min window through
    // poll 10 (9 * 31s = 279s ≤ 600).
    for (let i = 0; i < 10; i++) {
      __resetTtydCheckGateForTests(); // bypass the module-scoped 30s gate per call
      await ensureTtydAlive(state);
      advance(31);
    }

    const types = eventTypes();
    const restarts = types.filter((t) => t === "ttyd_restarted").length;
    const flapping = types.filter((t) => t === "ttyd_flapping").length;
    // Invariant: 9 successful restarts (counts 1..9), then exactly one
    // flap event at count=10. Mutation: changing `count + 1 >= THRESHOLD`
    // to `count >= THRESHOLD` makes restarts==10 and flapping==0 on the
    // tenth call (it would cross at the 11th instead).
    expect(restarts).toBe(9);
    expect(flapping).toBe(1);
    // Threshold-crossing poll must NOT call startTtyd. AC: "do NOT call
    // startTtyd". 9 restarts === 9 spawn invocations.
    expect(startTtydSpy.mock.calls.length).toBe(9);

    // Persisted shape: backoffUntil sentinel set on the agent's record.
    const persisted = readSlot(1);
    expect(persisted!.ttydRestartCounts!.coder!.backoffUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(persisted!.ttydRestartCounts!.coder!.count).toBe(10);
  });

  test("subsequent polls while suppressed are silent — no processAlive, no startTtyd, no emitEvent", async () => {
    // Pre-seed give-up state directly so the test isolates the short-circuit branch.
    seedSlot(2, {
      ttydPids: { coder: 99999999 },
      ttydRestartCounts: {
        coder: { count: 10, firstRestartAt: nowSeconds - 100, backoffUntil: Number.MAX_SAFE_INTEGER },
      },
    });
    const state = makeTmuxState(2);

    // Reset call counters AFTER the seed (we want to count only what
    // happens during the suppressed poll, not the test setup).
    processAliveSpy.mockClear();
    startTtydSpy.mockClear();
    emitSpy.mockClear();

    advance(31);
    __resetTtydCheckGateForTests();
    await ensureTtydAlive(state);

    // Invariant: give-up branch short-circuits BEFORE processAlive. Mutation:
    // dropping the `if (prev?.backoffUntil === SENTINEL) continue;` guard
    // makes processAlive get called and a fresh ttyd_restarted gets emitted.
    expect(processAliveSpy.mock.calls.length).toBe(0);
    expect(startTtydSpy.mock.calls.length).toBe(0);
    expect(emitSpy.mock.calls.length).toBe(0);
  });

  test("deleting the agent's record restarts ttyd freshly without re-emitting ttyd_flapping", async () => {
    // Start from give-up state, simulate the /api/ttyd-reset effect by
    // deleting the agent's record and persisting.
    seedSlot(3, {
      ttydPids: { coder: 99999999 },
      ttydRestartCounts: {
        coder: { count: 10, firstRestartAt: nowSeconds - 100, backoffUntil: Number.MAX_SAFE_INTEGER },
      },
    });
    // Edit on disk so readTmuxSlotState picks up the cleared shape next poll.
    const initial = readSlot(3)!;
    delete initial.ttydRestartCounts!.coder;
    tmuxAdapter.writeTmuxSlotState(initial, harness);

    const state = makeTmuxState(3);
    advance(31);
    __resetTtydCheckGateForTests();
    await ensureTtydAlive(state);

    const types = eventTypes();
    expect(types).toEqual(["ttyd_restarted"]);
    // No re-emission of ttyd_flapping — the prior incident is closed.
    expect(types.includes("ttyd_flapping")).toBe(false);

    const persisted = readSlot(3)!;
    expect(persisted.ttydRestartCounts!.coder!.count).toBe(1);
    expect(persisted.ttydRestartCounts!.coder!.backoffUntil).toBeUndefined();
  });

  test("quiet > 5 min since the LAST restart resets to count:1 even when firstRestartAt is recent", async () => {
    // The reset is gated on lastRestartAt, not firstRestartAt. Seed a
    // fixture where firstRestartAt is recent (50 s ago) but lastRestartAt
    // is old (301 s ago). The reset must fire because nothing has
    // restarted in 5+ min — even though the incident itself is young.
    //
    // Mutation: gating on `now - prev.firstRestartAt` (the prior bug)
    // sees `50 ≤ 300` → no reset → enters threshold check → nextCount=10
    // → emits ttyd_flapping. This test's `expect(types).toEqual(["ttyd_restarted"])`
    // would then fail.
    seedSlot(4, {
      ttydPids: { coder: 99999999 },
      ttydRestartCounts: {
        coder: { count: 9, firstRestartAt: nowSeconds - 50, lastRestartAt: nowSeconds - 301 },
      },
    });
    const state = makeTmuxState(4);

    __resetTtydCheckGateForTests();
    await ensureTtydAlive(state);

    const types = eventTypes();
    expect(types).toEqual(["ttyd_restarted"]);
    const persisted = readSlot(4)!;
    expect(persisted.ttydRestartCounts!.coder!.count).toBe(1);
    expect(persisted.ttydRestartCounts!.coder!.firstRestartAt).toBe(nowSeconds);
    expect(persisted.ttydRestartCounts!.coder!.lastRestartAt).toBe(nowSeconds);
    expect(persisted.ttydRestartCounts!.coder!.backoffUntil).toBeUndefined();
  });

  test("active flap whose firstRestartAt is older than 5 min does NOT reset when lastRestartAt is recent", async () => {
    // The reviewer's concrete falsifier (round-2 REQUEST_CHANGES): a
    // record at count=9 with firstRestartAt=600s ago AND lastRestartAt=11s
    // ago is an ACTIVE flap, not a stale incident. The reset MUST NOT
    // fire here; the next poll must cross the threshold and emit
    // ttyd_flapping.
    //
    // Mutation: gating on firstRestartAt (`now - 600 > 300` → reset) would
    // produce types=["ttyd_restarted"] and count=1. The strict
    // `expect(types).toEqual(["ttyd_flapping"])` plus
    // `expect(... .count).toBe(10)` below fail under that mutation.
    seedSlot(7, {
      ttydPids: { coder: 99999999 },
      ttydRestartCounts: {
        coder: { count: 9, firstRestartAt: nowSeconds - 600, lastRestartAt: nowSeconds - 11 },
      },
    });
    const state = makeTmuxState(7);

    __resetTtydCheckGateForTests();
    await ensureTtydAlive(state);

    const types = eventTypes();
    // (now - firstRestartAt) = 600 — exactly at the window edge, satisfies
    // the threshold's `≤ TTYD_FLAP_WINDOW_S`.
    expect(types).toEqual(["ttyd_flapping"]);
    const persisted = readSlot(7)!;
    expect(persisted.ttydRestartCounts!.coder!.count).toBe(10);
    expect(persisted.ttydRestartCounts!.coder!.backoffUntil).toBe(Number.MAX_SAFE_INTEGER);
    // Reviewer's concrete falsifier from REQUEST_CHANGES: the buggy gate
    // would have lost lastRestartAt=11; the fixed gate keeps it.
    expect(persisted.ttydRestartCounts!.coder!.lastRestartAt).toBe(nowSeconds - 11);
  });

  test("legacy record without lastRestartAt falls back to firstRestartAt for the quiet gate", async () => {
    // Back-compat: records persisted before the lastRestartAt field was
    // added must still load. For a legacy count==1 record they coincide;
    // for higher counts, behaviour is acceptable (the next restart will
    // stamp lastRestartAt and the gate becomes precise).
    seedSlot(8, {
      ttydPids: { coder: 99999999 },
      ttydRestartCounts: {
        // No lastRestartAt — pre-fix shape.
        coder: { count: 1, firstRestartAt: nowSeconds - 301 },
      },
    });
    const state = makeTmuxState(8);

    __resetTtydCheckGateForTests();
    await ensureTtydAlive(state);

    // Fallback (firstRestartAt) > 300 → reset to a fresh record that NOW
    // includes lastRestartAt.
    const persisted = readSlot(8)!;
    expect(persisted.ttydRestartCounts!.coder!.count).toBe(1);
    expect(persisted.ttydRestartCounts!.coder!.firstRestartAt).toBe(nowSeconds);
    expect(persisted.ttydRestartCounts!.coder!.lastRestartAt).toBe(nowSeconds);
  });

  test("ttyd_flapping payload includes restart_count, window_seconds, and the per-agent log path", async () => {
    seedSlot(5, {
      ttydPids: { coder: 99999999 },
      ttydRestartCounts: {
        coder: { count: 9, firstRestartAt: nowSeconds - 60 },
      },
    });
    const state = makeTmuxState(5);
    __resetTtydCheckGateForTests();
    await ensureTtydAlive(state);

    const flapCalls = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type?: string } | undefined)?.event_type === "ttyd_flapping",
    );
    expect(flapCalls.length).toBe(1);
    const payload = flapCalls[0][0] as Record<string, unknown>;
    // Diff anchor — proposal AC enumerates each of these literal fields.
    expect(payload.event_type).toBe("ttyd_flapping");
    expect(payload.slot).toBe(5);
    expect(payload.agent).toBe("coder");
    expect(payload.restart_count).toBe(10);
    expect(payload.window_seconds).toBe(600);
    const expectedLog = tmuxAdapter.ttydLogPath(5, "coder");
    expect(String(payload.message)).toContain(expectedLog);
  });

  // --- wrong-session hardening (task-1373e911) ---
  // These cases set processAlive → TRUE (the rest of the suite mocks false) and
  // spy ttydMatchesSession, isolating the alive-branch session-identity check.

  test("alive ttyd attached to the CORRECT session → no startTtyd, no event (AC5 no-churn)", async () => {
    seedSlot(1, { ttydPids: { coder: 12345 } });
    const state = makeTmuxState(1);
    processAliveSpy.mockImplementation(() => true);
    const matchSpy = spyOn(tmuxAdapter, "ttydMatchesSession").mockImplementation(() => true);
    startTtydSpy.mockClear();
    emitSpy.mockClear();
    try {
      __resetTtydCheckGateForTests();
      await ensureTtydAlive(state);
      // Invariant: an alive, correctly-attached ttyd is left untouched.
      // Mutation: dropping the `&& ttydMatchesSession(...)` term keeps the old
      // `if (alive) continue` — still passes here, so the wrong-target test
      // below is the discriminating case.
      expect(startTtydSpy.mock.calls.length).toBe(0);
      expect(emitSpy.mock.calls.length).toBe(0);
    } finally {
      matchSpy.mockRestore();
    }
  });

  test("alive ttyd attached to the WRONG session → restart + one ttyd_restarted event", async () => {
    seedSlot(2, { ttydPids: { coder: 12345 } });
    const state = makeTmuxState(2);
    processAliveSpy.mockImplementation(() => true);
    const matchSpy = spyOn(tmuxAdapter, "ttydMatchesSession").mockImplementation(() => false);
    startTtydSpy.mockClear();
    emitSpy.mockClear();
    try {
      __resetTtydCheckGateForTests();
      await ensureTtydAlive(state);
      // Invariant: alive-but-wrong-session is treated as needing restart.
      // Mutation: removing the `&& ttydMatchesSession(...)` term makes the
      // alive ttyd `continue` here → 0 startTtyd calls, 0 events — caught.
      expect(startTtydSpy.mock.calls.length).toBe(1);
      const types = eventTypes();
      expect(types.filter((t) => t === "ttyd_restarted").length).toBe(1);
    } finally {
      matchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Vanished-session detection & recovery (gh-ludics-559 defect A)
// ---------------------------------------------------------------------------

describe("detectAndRecoverVanishedTmuxSessions", () => {
  let origHarnessDir: string | undefined;
  let origRetryMax: string | undefined;
  let origStartupGrace: string | undefined;

  beforeEach(() => {
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    origRetryMax = process.env.LUDICS_RUNNER_VANISHED_RETRY_MAX;
    origStartupGrace = process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
    __resetVanishedRecoveryStateForTests();
  });

  afterEach(() => {
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
    if (origRetryMax !== undefined) process.env.LUDICS_RUNNER_VANISHED_RETRY_MAX = origRetryMax;
    else delete process.env.LUDICS_RUNNER_VANISHED_RETRY_MAX;
    if (origStartupGrace !== undefined) process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = origStartupGrace;
    else delete process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
    __resetVanishedRecoveryStateForTests();
  });

  // Mirror of escalation.test.ts seedHarness: sibling tmux-slot file (pid == our
  // own so the self-guard passes) + a slot json so liveness can flip.
  function seedHarness(slot: number): { harness: string; peerSyncDir: string } {
    const tmpDir = makeTmpDir();
    const harness = join(tmpDir, "harness");
    const peerSyncDir = join(tmpDir, "peer-sync");
    mkdirSync(join(harness, "orchestration"), { recursive: true });
    mkdirSync(join(harness, "slots"), { recursive: true });
    mkdirSync(join(peerSyncDir, "plans"), { recursive: true });
    mkdirSync(join(peerSyncDir, "reviews"), { recursive: true });
    writeFileSync(
      join(harness, "orchestration", `tmux-slot-${slot}.json`),
      JSON.stringify({ slot, orchestration: { pid: process.pid, stateFile: "x", mode: "pair" }, ttydPids: {} }),
    );
    writeFileSync(
      join(harness, "slots", `slot-${slot}.json`),
      JSON.stringify({
        slot, process: "test-process", task: "feat", mode: "tmux", session: null,
        path: null, started: null, adapterArgs: null, machine: null,
        sessionStarted: null, liveness: null, terminals: "", runtime: "", git: "",
      }, null, 2),
    );
    return { harness, peerSyncDir };
  }

  function eventTypes(spy: ReturnType<typeof spyOn>): string[] {
    return spy.mock.calls.map((c: unknown[]) => (c[0] as { event_type?: string }).event_type ?? "");
  }

  test("vanished participating session triggers exactly one slot-scoped recreate, rewrites sibling, resumes in order (AC6/AC7/AC8/AC10)", async () => {
    const slot = 31;
    const { harness, peerSyncDir } = seedHarness(slot);
    const state = makeState({ slot, backend: "tmux", phase: "work", harnessDir: harness }, peerSyncDir);
    // Pre-set in-flight bookkeeping that orderly-resume must clear.
    state.agentStates.coder!.turnLifecycle = makeLifecycle({ state: "running", observedTurnId: "turn-x" });
    state.phaseDispatched = true;
    const origPhase = state.phase;
    const origRound = state.round;

    const hasSessionSpy = spyOn(tmux, "tmuxHasSession").mockImplementation(() => false);
    const recreateSpy = spyOn(tmuxAdapter, "startTmuxAgentSessionsForOrchestratedSlot")
      .mockImplementation(() => ({ coder: 4242, reviewer: 4243 }));
    const emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});

    try {
      const res = await detectAndRecoverVanishedTmuxSessions(state);
      expect(res).toBe("ok");
      // Invariant: exactly one slot-scoped recreate (not per-agent racing).
      expect(recreateSpy).toHaveBeenCalledTimes(1);
      expect(recreateSpy.mock.calls[0]![0]).toBe(slot);

      // Invariant: sibling file rewritten with our pid + fresh ttyd pids, so
      // stop/clear can still track the slot. Without the rewrite, the recovered
      // slot would be untrackable (the original incident's orphan-ttyd problem).
      const sib = tmuxAdapter.readTmuxSlotState(slot, harness);
      expect(sib!.orchestration?.pid).toBe(process.pid);
      expect(sib!.ttydPids).toEqual({ coder: 4242, reviewer: 4243 });

      // Invariant (AC8): orderly resume — current-turn bookkeeping cleared,
      // phase/round NOT rewound (no replay of prior phases).
      expect(state.phaseDispatched).toBe(false);
      expect(state.agentStates.coder!.turnLifecycle).toBeNull();
      expect(state.agentStates.reviewer!.turnLifecycle).toBeNull();
      expect(state.phase).toBe(origPhase);
      expect(state.round).toBe(origRound);

      // Invariant (AC10): recovery is observable in the event log.
      const types = eventTypes(emitSpy);
      expect(types).toContain("tmux_sessions_vanished");
      expect(types).toContain("tmux_sessions_recovered");
    } finally {
      hasSessionSpy.mockRestore();
      recreateSpy.mockRestore();
      emitSpy.mockRestore();
    }
  });

  test("missing NON-participating session does not trigger recovery (AC6 participant-scoping)", async () => {
    // Harness condition: phase "review" → only the reviewer participates
    // (agentParticipatesInPhase). The coder session is missing but the coder is
    // a non-participant, and the reviewer session is present. A vacuous
    // all-agents check (state.agents.some) would mis-fire here; the participant
    // filter must not. Mutation: drop the participant filter → recreate fires.
    const slot = 32;
    const { harness, peerSyncDir } = seedHarness(slot);
    const state = makeState({ slot, backend: "tmux", phase: "review", harnessDir: harness }, peerSyncDir);
    const coderSession = tmuxAdapter.tmuxSessionName(slot, "coder", state.taskId);

    const hasSessionSpy = spyOn(tmux, "tmuxHasSession")
      .mockImplementation((name: string) => name !== coderSession); // coder gone, reviewer present
    const recreateSpy = spyOn(tmuxAdapter, "startTmuxAgentSessionsForOrchestratedSlot")
      .mockImplementation(() => ({}));

    try {
      const res = await detectAndRecoverVanishedTmuxSessions(state);
      expect(res).toBe("ok");
      expect(recreateSpy).not.toHaveBeenCalled();
    } finally {
      hasSessionSpy.mockRestore();
      recreateSpy.mockRestore();
    }
  });

  test("all participating sessions present → no recovery (a dead CLI in a live session is not a vanish) (AC6)", async () => {
    const slot = 33;
    const { harness, peerSyncDir } = seedHarness(slot);
    const state = makeState({ slot, backend: "tmux", phase: "work", harnessDir: harness }, peerSyncDir);

    const hasSessionSpy = spyOn(tmux, "tmuxHasSession").mockImplementation(() => true);
    const recreateSpy = spyOn(tmuxAdapter, "startTmuxAgentSessionsForOrchestratedSlot")
      .mockImplementation(() => ({}));

    try {
      const res = await detectAndRecoverVanishedTmuxSessions(state);
      expect(res).toBe("ok");
      expect(recreateSpy).not.toHaveBeenCalled();
    } finally {
      hasSessionSpy.mockRestore();
      recreateSpy.mockRestore();
    }
  });

  test("retry budget exhaustion escalates (priority-5 notify + escalation_requested + liveness flip) and halts (AC9/AC10)", async () => {
    const slot = 34;
    const { harness, peerSyncDir } = seedHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;
    process.env.LUDICS_RUNNER_VANISHED_RETRY_MAX = "1";
    const state = makeState({ slot, backend: "tmux", phase: "work", harnessDir: harness }, peerSyncDir);

    const hasSessionSpy = spyOn(tmux, "tmuxHasSession").mockImplementation(() => false);
    // Recreate keeps failing (server wedged present-but-unresponsive).
    const recreateSpy = spyOn(tmuxAdapter, "startTmuxAgentSessionsForOrchestratedSlot")
      .mockImplementation(() => { throw new Error("tmux server unresponsive"); });
    const emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    const notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});

    try {
      // Attempt 1: under budget → counted, recreate attempted (throws) → "ok".
      const r1 = await detectAndRecoverVanishedTmuxSessions(state);
      expect(r1).toBe("ok");
      // Attempt 2: budget (1) reached → escalate + halt, no further recreate.
      const r2 = await detectAndRecoverVanishedTmuxSessions(state);
      expect(r2).toBe("halt");

      // Invariant (AC9): bounded — recreate attempted at most maxRetries times.
      expect(recreateSpy).toHaveBeenCalledTimes(1);

      // Invariant (AC10): reuses the escalation machinery — failure precursor
      // AND escalation_requested, priority-5 notify, slot liveness escalated.
      const types = eventTypes(emitSpy);
      expect(types).toContain("tmux_sessions_recovery_failed");
      expect(types).toContain("escalation_requested");
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect((notifySpy.mock.calls[0] as unknown[])[1]).toBe(5);
      const slotData = JSON.parse(readFileSync(join(harness, "slots", `slot-${slot}.json`), "utf-8"));
      expect(slotData.liveness).toBe("escalated");
    } finally {
      hasSessionSpy.mockRestore();
      recreateSpy.mockRestore();
      emitSpy.mockRestore();
      notifySpy.mockRestore();
    }
  });

  test("vanished check runs BEFORE settled-no-signal: a vanished session is never nudged as settled (AC5/AC12d)", async () => {
    // Positive control (non-vacuity): the primed coder genuinely trips the
    // settled-no-signal detector when it runs.
    const pcDir = makeTmpDir();
    mkdirSync(join(pcDir, "plans"), { recursive: true });
    mkdirSync(join(pcDir, "reviews"), { recursive: true });
    const primed = makeState({ phase: "work" }, pcDir);
    primed.agentStates.coder!.status = "done";
    primed.agentStates.coder!.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-settled",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(), // > 300s threshold
    });
    await detectAndNudgeSettledNoSignal(primed, noopTransport);
    expect(primed.agentStates.coder!.turnLifecycle!.settledNoSignalDetectedAt).not.toBeNull();

    // Negative (ordering): same prime, but the session vanished and the retry
    // budget is 0 → the poll loop halts AT the vanished check, before reaching
    // detectAndNudgeSettledNoSignal. The settled-no-signal event (whose only
    // emitter is downstream of the halt) must therefore never appear. Mutation:
    // moving the vanished check after the settled detector lets tick 1 emit it.
    const slot = 35;
    const { harness, peerSyncDir } = seedHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;
    process.env.LUDICS_RUNNER_VANISHED_RETRY_MAX = "0";
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "0";
    const state = makeState({
      slot,
      backend: "tmux",
      phase: "work",
      harnessDir: harness,
      // Skip re-entry into enterPhase's dispatch loop while still exercising the
      // real pollUntilDone path (same trick as escalation.test.ts).
      phaseDispatched: true,
      currentPhaseToken: "phase-existing",
    }, peerSyncDir);
    state.agentStates.coder!.status = "done";
    state.agentStates.coder!.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-settled",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(),
    });

    let sendTurnCalls = 0;
    const recordingTransport: OrchestrationTransport = {
      async sendTurn() { sendTurnCalls++; return "cmd-vanished-order"; },
      async sendEnter() {},
      async refreshAgentTransportState() {},
      async interruptAgent() {},
    };

    const hasSessionSpy = spyOn(tmux, "tmuxHasSession").mockImplementation(() => false);
    const emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    const notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});

    try {
      await runOrchestration(state, recordingTransport);
      const types = eventTypes(emitSpy);
      // Ordering invariant: vanished session never aged into settled-no-signal.
      expect(types).not.toContain("orchestration_settled_no_signal_detected");
      expect(types).not.toContain("orchestration_settled_no_signal_nudge_sent");
      // And recovery escalation did run (budget 0 → immediate give-up).
      expect(types).toContain("escalation_requested");
      // No prompt was pasted into the (dead) target.
      expect(sendTurnCalls).toBe(0);
      // Phase not advanced (orderly halt).
      expect(state.phase).toBe("work");
    } finally {
      hasSessionSpy.mockRestore();
      emitSpy.mockRestore();
      notifySpy.mockRestore();
    }
  });
});
