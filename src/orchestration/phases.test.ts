import { describe, expect, test } from "bun:test";
import { evaluateTransition } from "./phases.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "./state.ts";

function makeState(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    slot: 1,
    feature: "feat",
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
});
