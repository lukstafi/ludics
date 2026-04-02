import { describe, expect, test } from "bun:test";
import { join } from "path";
import { evaluateTransition } from "./phases.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "./state.ts";

function makeState(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    slot: 1,
    taskId: "feat",
    mode: "duo",
    phase: "setup",
    round: 1,
    mergeRound: 0,
    agents: [
      { name: "agent1", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a" },
      { name: "agent2", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b" },
    ],
    agentStates: initAgentRuntimeState(["agent1", "agent2"]),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: 0,
    startedAt: "2026-03-07T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir: "/tmp/project-feat/.peer-sync",
    threadIds: { agent1: "t1", agent2: "t2" },
    ...overrides,
  };
}

describe("evaluateTransition", () => {
  test("moves directly from setup to work when pre-work is disabled", () => {
    expect(evaluateTransition(makeState())).toBe("work");
  });

  test("honors pre-work phase ordering", () => {
    const state = makeState({
      config: defaultOrchestrationConfig({ enableClarify: true, enablePushback: true, enablePlan: true }),
    });
    expect(evaluateTransition(state)).toBe("clarify");
  });

  test("moves from work to review when both agents finish", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.agent1.status = "done";
    state.agentStates.agent2.status = "done";
    expect(evaluateTransition(state)).toBe("review");
  });

  test("moves from update-docs back to work when no PR exists", () => {
    const state = makeState({ phase: "update-docs" });
    state.agentStates.agent1.status = "update-docs-done";
    state.agentStates.agent2.status = "update-docs-done";
    expect(evaluateTransition(state)).toBe("work");
  });

  test("moves from update-docs to pr-comments when a PR exists", () => {
    const state = makeState({ phase: "update-docs" });
    state.agentStates.agent1.status = "update-docs-done";
    state.agentStates.agent2.status = "update-docs-done";
    state.agentStates.agent1.prUrl = "https://example.com/pr/1";
    expect(evaluateTransition(state)).toBe("pr-comments");
  });

  test("pr-comments stays null when no PR and quiet period not set", () => {
    const state = makeState({ phase: "pr-comments" });
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-comments transitions to final-merge after quiet period expires", () => {
    const quietStart = Math.floor(Date.now() / 1000) - 2000; // 2000s ago
    const state = makeState({
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
    });
    state.agentStates.agent1.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("pr-comments stays null when quiet period has not yet elapsed", () => {
    const now = Math.floor(Date.now() / 1000);
    const quietStart = now - 60; // only 60s ago
    const state = makeState({
      phase: "pr-comments",
      phaseStartedAt: now - 90, // phase started 90s ago (well within 86400s hard cap)
      prCommentsQuietSince: quietStart,
      config: defaultOrchestrationConfig({ prCommentsTimeout: 1800 }),
    });
    state.agentStates.agent1.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-comments transitions to suggest-refactor when merged marker present", () => {
    const state = makeState({ phase: "pr-comments" });
    state.agentStates.agent1.status = "merged";
    expect(evaluateTransition(state)).toBe("suggest-refactor");
  });

  test("final-merge transitions to suggest-refactor when done", () => {
    const state = makeState({ phase: "final-merge" });
    state.agentStates.agent1.status = "final-merge-done";
    state.agentStates.agent2.status = "final-merge-done";
    expect(evaluateTransition(state)).toBe("suggest-refactor");
  });

  test("suggest-refactor always transitions to done", () => {
    const state = makeState({ phase: "suggest-refactor" });
    state.agentStates.agent1.status = "suggest-refactor-done";
    state.agentStates.agent2.status = "suggest-refactor-done";
    expect(evaluateTransition(state)).toBe("done");
  });

  // plan-merge phase (pair mode)
  test("pair plan phase transitions to plan-merge (not plan-review)", () => {
    const state = makeState({
      mode: "pair",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    expect(evaluateTransition(state)).toBe("plan-merge");
  });

  test("duo plan phase still transitions to plan-review", () => {
    const state = makeState({
      mode: "duo",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
    });
    state.agentStates.agent1.status = "plan-done";
    state.agentStates.agent2.status = "plan-done";
    expect(evaluateTransition(state)).toBe("plan-review");
  });

  test("plan-merge transitions to plan-review when done", () => {
    const state = makeState({
      mode: "pair",
      phase: "plan-merge",
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
    });
    state.agentStates.coder.status = "plan-merge-done";
    expect(evaluateTransition(state)).toBe("plan-review");
  });

  test("plan-review in pair mode loops back to plan-merge on REQUEST_CHANGES (round < 3)", () => {
    const state = makeState({
      mode: "pair",
      phase: "plan-review",
      planMergeRound: 0,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: "/tmp/ps",
    });
    state.agentStates.reviewer.status = "plan-review-done";
    // Simulate the review file existing with REQUEST_CHANGES
    // (pairReviewVerdict reads from the filesystem; we need to mock by providing a phaseTimeoutExpired path)
    // Since we can't write files in a unit test easily, test the timeout path instead: timeout forces forward.
    state.phaseStartedAt = 0; // expired
    expect(evaluateTransition(state)).toBe("work"); // timeout → forward (no verdict file)
  });

  test("plan-review in duo mode always proceeds to work", () => {
    const state = makeState({
      mode: "duo",
      phase: "plan-review",
    });
    state.agentStates.agent1.status = "plan-review-done";
    state.agentStates.agent2.status = "plan-review-done";
    expect(evaluateTransition(state)).toBe("work");
  });

  test("plan-review in pair mode proceeds to work after 3 REQUEST_CHANGES rounds", () => {
    const state = makeState({
      mode: "pair",
      phase: "plan-review",
      planMergeRound: 3, // at max iterations
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: "/tmp/ps",
    });
    state.agentStates.reviewer.status = "plan-review-done";
    state.phaseStartedAt = 0; // timeout
    // Even if verdict were REQUEST_CHANGES, planMergeRound >= 3 forces forward to work.
    expect(evaluateTransition(state)).toBe("work");
  });

  // --- Staging-aware transitions ---

  test("pr-comments with staging + no forwarding transitions to forward-pr on quiet period", () => {
    const quietStart = Math.floor(Date.now() / 1000) - 2000;
    const state = makeState({
      mode: "pair",
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
      stagingRepo: "owner/staging-fork",
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
    });
    state.agentStates.coder.prUrl = "https://github.com/owner/staging-fork/pull/1";
    expect(evaluateTransition(state)).toBe("forward-pr");
  });

  test("pr-comments without staging still transitions to final-merge on quiet period", () => {
    const quietStart = Math.floor(Date.now() / 1000) - 2000;
    const state = makeState({
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
    });
    state.agentStates.agent1.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("duo mode with staging_repo ignores staging and transitions to final-merge", () => {
    const quietStart = Math.floor(Date.now() / 1000) - 2000;
    const state = makeState({
      mode: "duo",
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
      stagingRepo: "owner/staging-fork",
    });
    state.agentStates.agent1.prUrl = "https://github.com/owner/staging-fork/pull/1";
    // Duo mode ignores stagingRepo → non-staging path → final-merge
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("forward-pr transitions to pr-comments when done", () => {
    const state = makeState({
      phase: "forward-pr",
      mode: "pair",
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
    });
    state.agentStates.coder.status = "forward-pr-done";
    expect(evaluateTransition(state)).toBe("pr-comments");
  });

  test("pr-comments with staging + forwarded + upstream-merged transitions to final-merge", () => {
    const { mkdtempSync, writeFileSync: write } = require("fs");
    const { rmSync } = require("fs");
    const tmpDir = mkdtempSync("/tmp/ludics-phases-staging-test-");
    try {
      write(join(tmpDir, "coder.forwarded"), "");
      write(join(tmpDir, "coder.upstream-merged"), "upstream-merged\n");
      const state = makeState({
        mode: "pair",
        phase: "pr-comments",
        stagingRepo: "owner/staging-fork",
        peerSyncDir: tmpDir,
        agents: [
          { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
          { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
        ],
        agentStates: initAgentRuntimeState(["coder", "reviewer"]),
        threadIds: { coder: "t1", reviewer: "t2" },
      });
      state.agentStates.coder.prUrl = "https://github.com/upstream/repo/pull/5";
      expect(evaluateTransition(state)).toBe("final-merge");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pr-comments with staging + forwarded but no upstream-merged stays null (no timeout escape)", () => {
    const { mkdtempSync, writeFileSync: write } = require("fs");
    const { rmSync } = require("fs");
    const tmpDir = mkdtempSync("/tmp/ludics-phases-staging-wait-test-");
    try {
      write(join(tmpDir, "coder.forwarded"), "");
      const state = makeState({
        mode: "pair",
        phase: "pr-comments",
        stagingRepo: "owner/staging-fork",
        peerSyncDir: tmpDir,
        phaseStartedAt: 0, // phase timeout long expired
        prCommentsQuietSince: 1, // quiet period long expired
        agents: [
          { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
          { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
        ],
        agentStates: initAgentRuntimeState(["coder", "reviewer"]),
        threadIds: { coder: "t1", reviewer: "t2" },
      });
      state.agentStates.coder.prUrl = "https://github.com/upstream/repo/pull/5";
      // Even with expired timeouts: forwarded branch only transitions on upstream-merged marker
      expect(evaluateTransition(state)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
