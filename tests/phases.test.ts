import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isAgentDone } from "../src/orchestration/phases.ts";
import * as peerSync from "../src/orchestration/peer-sync.ts";
import type { AgentConfig, AgentRuntimeState, OrchestrationState } from "../src/orchestration/state.ts";

function makeAgent(name = "coder"): AgentConfig {
  return {
    name,
    provider: "claude-code",
    model: "opus",
    branch: "main",
    worktreePath: "/tmp/wt",
  };
}

function makeRuntime(overrides: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    status: "done",
    statusEpoch: 1000,
    statusMessage: "",
    prUrl: null,
    interrupted: false,
    ...overrides,
  };
}

function makeState(
  agentName: string,
  runtime: AgentRuntimeState,
  overrides: Partial<OrchestrationState> = {},
): OrchestrationState {
  const agent = makeAgent(agentName);
  return {
    slot: 1,
    taskId: "test-task",
    mode: "pair",
    phase: "work",
    round: 1,
    mergeRound: 0,
    agents: [agent],
    agentStates: { [agentName]: runtime },
    config: {
      timeouts: {},
      pollInterval: 5,
      enableClarify: false,
      enablePushback: false,
      enablePlan: false,
      enableGather: false,
      autoFinish: false,
      autoFinishTimeout: 300,
      learningInterval: 600,
      learningProductiveRoundsGap: 2,
      useMagTailoring: false,
      prCommentsTimeout: 120,
      prCommentsCheckInterval: 30,
    },
    phaseStartedAt: 1000,
    startedAt: "2026-01-01T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/wt",
    peerSyncDir: "/tmp/peer-sync",
    threadIds: {},
    ...overrides,
  } as OrchestrationState;
}

describe("isAgentDone — settled branch freshness gate", () => {
  let fpSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fpSpy?.mockRestore();
  });

  test("returns false when settled + done status but fingerprint unchanged (stale)", () => {
    // Spy returns same fingerprint as baseline → stale
    fpSpy = spyOn(peerSync, "statusFileFingerprint").mockReturnValue("abc|123");

    const runtime = makeRuntime({
      status: "done",
      dispatchStatusFingerprint: "abc|123",
      turnLifecycle: {
        dispatchCommandId: "cmd-1",
        dispatchedAt: "2026-01-01T00:00:00Z",
        phaseToken: "tok",
        observedTurnId: "turn-1",
        state: "settled",
        turnStartedAt: "2026-01-01T00:00:01Z",
        turnCompletedAt: "2026-01-01T00:00:10Z",
        completionSource: "snapshot",
        statusFileFingerprint: "abc|123",
        lastStopHookAt: null,
      },
    });

    const state = makeState("coder", runtime);
    expect(isAgentDone(state, makeAgent("coder"))).toBe(false);
  });

  test("returns true when settled + done status and fingerprint changed (fresh)", () => {
    // Spy returns different fingerprint → fresh
    fpSpy = spyOn(peerSync, "statusFileFingerprint").mockReturnValue("xyz|456");

    const runtime = makeRuntime({
      status: "done",
      dispatchStatusFingerprint: "abc|123",
      turnLifecycle: {
        dispatchCommandId: "cmd-1",
        dispatchedAt: "2026-01-01T00:00:00Z",
        phaseToken: "tok",
        observedTurnId: "turn-1",
        state: "settled",
        turnStartedAt: "2026-01-01T00:00:01Z",
        turnCompletedAt: "2026-01-01T00:00:10Z",
        completionSource: "snapshot",
        statusFileFingerprint: "abc|123",
        lastStopHookAt: null,
      },
    });

    const state = makeState("coder", runtime);
    expect(isAgentDone(state, makeAgent("coder"))).toBe(true);
  });

  test("returns true when settled + done status and no baseline fingerprint", () => {
    // No spy needed — no baseline means freshness gate is skipped.
    // But statusFileFingerprint may still be called by the post-validateDoneStatus
    // fingerprint check in the settled branch, so stub it to avoid file I/O.
    fpSpy = spyOn(peerSync, "statusFileFingerprint").mockReturnValue(null);

    const runtime = makeRuntime({
      status: "done",
      // No dispatchStatusFingerprint set → freshness gate skipped
      turnLifecycle: {
        dispatchCommandId: "cmd-1",
        dispatchedAt: "2026-01-01T00:00:00Z",
        phaseToken: "tok",
        observedTurnId: "turn-1",
        state: "settled",
        turnStartedAt: "2026-01-01T00:00:01Z",
        turnCompletedAt: "2026-01-01T00:00:10Z",
        completionSource: "snapshot",
        statusFileFingerprint: "abc|123",
        lastStopHookAt: null,
      },
    });

    const state = makeState("coder", runtime);
    expect(isAgentDone(state, makeAgent("coder"))).toBe(true);
  });
});
