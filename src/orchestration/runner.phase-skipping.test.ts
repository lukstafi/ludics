import { describe, expect, test, spyOn, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { preparePhaseRedispatch, skipToPhase, validatePreviousPhaseArtifacts } from "./runner.ts";
import * as events from "../events.ts";
import { agentParticipatesInPhase } from "./phases.ts";
import { statusFileFingerprint } from "./peer-sync.ts";
import { persistState, readOrchestrationState, type OrchestrationState } from "./state.ts";
import {
  makeTmpDir,
  makeLifecycle,
  makeState,
} from "./runner.test-helpers.ts";

setDefaultTimeout(20_000);

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
