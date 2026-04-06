import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock events to suppress emission during tests.
mock.module("../src/events.ts", () => ({
  emitEvent: () => {},
}));

import { skipToPhase } from "../src/orchestration/runner.ts";
import { persistState } from "../src/orchestration/state.ts";
import type { OrchestrationState } from "../src/orchestration/state.ts";

describe("skipToPhase — agent lifecycle reset", () => {
  let harnessDir: string;
  const slot = 99;

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), "ludics-test-"));
    // Create the orchestration state file that readOrchestrationState expects.
    const stateDir = join(harnessDir, "orchestration");
    mkdirSync(stateDir, { recursive: true });

    const state: OrchestrationState = {
      slot,
      taskId: "test-task",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [
        { name: "coder", provider: "claude-code", model: "opus", branch: "b1", worktreePath: "/tmp/wt1" },
        { name: "reviewer", provider: "claude-code", model: "opus", branch: "b2", worktreePath: "/tmp/wt2" },
      ],
      agentStates: {
        coder: {
          status: "done",
          statusEpoch: 1000,
          statusMessage: "finished work",
          prUrl: null,
          interrupted: false,
          turnLifecycle: {
            dispatchCommandId: "cmd-1",
            dispatchedAt: "2026-01-01T00:00:00Z",
            phaseToken: "tok",
            observedTurnId: "turn-1",
            state: "settled",
            turnStartedAt: "2026-01-01T00:00:01Z",
            turnCompletedAt: "2026-01-01T00:00:10Z",
            completionSource: "snapshot",
            statusFileFingerprint: "fp1",
            lastStopHookAt: null,
          },
        },
        reviewer: {
          status: "review-done",
          statusEpoch: 1000,
          statusMessage: "finished review",
          prUrl: null,
          interrupted: false,
          turnLifecycle: {
            dispatchCommandId: "cmd-2",
            dispatchedAt: "2026-01-01T00:00:00Z",
            phaseToken: "tok",
            observedTurnId: "turn-2",
            state: "settled",
            turnStartedAt: "2026-01-01T00:00:01Z",
            turnCompletedAt: "2026-01-01T00:00:10Z",
            completionSource: "snapshot",
            statusFileFingerprint: "fp2",
            lastStopHookAt: null,
          },
        },
      },
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
    } as OrchestrationState;

    persistState(state, harnessDir);
  });

  test("clears turnLifecycle and resets status for all agents", () => {
    const result = skipToPhase(slot, "review", harnessDir);

    expect(result.phase).toBe("review");
    expect(result.phaseDispatched).toBe(false);

    for (const agent of result.agents) {
      const runtime = result.agentStates[agent.name];
      expect(runtime).toBeDefined();
      expect(runtime.turnLifecycle).toBeNull();
      expect(runtime.status).toBe("idle");
      expect(runtime.statusMessage).toBe("skip to review");
    }
  });
});
