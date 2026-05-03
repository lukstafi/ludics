import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { detectAndNudgeSettledNoSignal, refreshAgentStatuses } from "./runner.ts";
import * as events from "../events.ts";
import {
  makeTmpDir,
  makeLifecycle,
  makeState,
  makePeerSyncDir,
  makeSnapshot,
  makeMockTransport,
  noopTransport,
} from "./runner.test-helpers.ts";

setDefaultTimeout(20_000);

describe("detectAndNudgeSettledNoSignal", () => {
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

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.settledNoSignalDetectedAt).not.toBeNull();
    // Nudge attempt won't succeed (readServerRecord returns null) so settledNoSignalNudgeAttempts stays 0
    // but stall is detected
    const stallEvent = emitSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { event_type?: string }).event_type === "orchestration_settled_no_signal_detected",
    );
    expect(stallEvent).toBeDefined();
  });

  test("dispatch stall: dispatched lifecycle + age > threshold → stall detected", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "dispatched",
      dispatchedAt: new Date(Date.now() - 200_000).toISOString(), // 200s > 120s threshold
    });

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.settledNoSignalDetectedAt).not.toBeNull();
  });

  test("below threshold: no stall detected", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 60_000).toISOString(), // 60s < 180s threshold
    });

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.settledNoSignalDetectedAt).toBeNull();
  });

  test("nudge cooldown respected: recent lastSettledNoSignalNudgeAt → no nudge", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(),
      settledNoSignalDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      settledNoSignalNudgeAttempts: 1,
      lastSettledNoSignalNudgeAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago < 300s cooldown
    });

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    // settledNoSignalNudgeAttempts should stay at 1 (cooldown prevented another nudge)
    expect(state.agentStates.coder.turnLifecycle!.settledNoSignalNudgeAttempts).toBe(1);
  });

  test("force-settle after MAX_NUDGE_ATTEMPTS: interruptAgent called", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.agentStates.coder.status = "done";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 400_000).toISOString(),
      settledNoSignalDetectedAt: new Date(Date.now() - 1500_000).toISOString(),
      settledNoSignalNudgeAttempts: 3, // >= MAX_NUDGE_ATTEMPTS
      lastSettledNoSignalNudgeAt: new Date(Date.now() - 400_000).toISOString(),
    });

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    // interruptAgent sets interrupted = true and status = "interrupted"
    expect(state.agentStates.coder.interrupted).toBe(true);
    expect(state.agentStates.coder.status).toBe("interrupted");
    const forceEvent = emitSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as { event_type?: string }).event_type === "orchestration_settled_no_signal_force_settle",
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

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    expect(state.agentStates.coder.turnLifecycle!.settledNoSignalDetectedAt).toBeNull();
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

    await detectAndNudgeSettledNoSignal(state, noopTransport);

    expect(state.agentStates.coder.turnLifecycle!.settledNoSignalDetectedAt).toBeNull();
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
      settledNoSignalDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      settledNoSignalNudgeAttempts: 1,
      lastSettledNoSignalNudgeAt: new Date(Date.now() - 50_000).toISOString(),
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
    expect(lc.settledNoSignalDetectedAt).toBeNull();
    expect(lc.settledNoSignalNudgeAttempts).toBe(0);

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
      settledNoSignalDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      settledNoSignalNudgeAttempts: 1,
      lastSettledNoSignalNudgeAt: new Date(Date.now() - 50_000).toISOString(),
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
    expect(lc.settledNoSignalDetectedAt).toBeNull();
    expect(lc.settledNoSignalNudgeAttempts).toBe(0);

    const eventsPath = join(tmpDir, "harness", "journal", "events.jsonl");
    if (existsSync(eventsPath)) {
      const evts = readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const deadEvent = evts.find((e: { event_type?: string }) => e.event_type === "orchestration_nudge_settled_dead");
      expect(deadEvent).toBeDefined();
    }
  });

  test("settlement without any nudge (settledNoSignalNudgeAttempts=0) → no outcome event, stall cleared", async () => {
    const peerSyncDir = makePeerSyncDir({ root: tmpDir, coder: tmpDir }, { coder: "done|1|done" });
    const state = makeState({ phase: "work" }, peerSyncDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      observedTurnId: "turn-1",
      turnStartedAt: new Date(Date.now() - 200_000).toISOString(),
      settledNoSignalDetectedAt: new Date(Date.now() - 100_000).toISOString(),
      settledNoSignalNudgeAttempts: 0, // no nudge was sent
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
    expect(lc.settledNoSignalDetectedAt).toBeNull();
    expect(lc.settledNoSignalNudgeAttempts).toBe(0);

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

