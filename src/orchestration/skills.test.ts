import { describe, expect, test } from "bun:test";
import { composeSkillMessage, resolveTemplatePath, substituteTemplate } from "./skills.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "./state.ts";

function makeState(): OrchestrationState {
  return {
    slot: 1,
    feature: "feat",
    mode: "pair",
    phase: "review",
    round: 2,
    mergeRound: 0,
    agents: [
      { name: "coder", provider: "codex", role: "coder", model: "gpt-5.4", branch: "coder", worktreePath: "/tmp/coder" },
      { name: "reviewer", provider: "codex", role: "reviewer", model: "gpt-5.4", branch: "reviewer", worktreePath: "/tmp/reviewer" },
    ],
    agentStates: initAgentRuntimeState(["coder", "reviewer"]),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: 0,
    startedAt: "2026-03-07T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir: "/tmp/project-feat/.peer-sync",
    threadIds: { coder: "t1", reviewer: "t2" },
    slotTitle: "Feature title",
  };
}

describe("skills", () => {
  test("selects pair reviewer override templates when available", () => {
    const path = resolveTemplatePath("review", "pair", "reviewer");
    expect(path.endsWith("pair-reviewer-review.md")).toBe(true);
  });

  test("substitutes placeholders", () => {
    const text = substituteTemplate("hello {{AGENT_NAME}} {{DONE_STATUS}}", {
      ...{
        phase: "review",
        round: 1,
        mode: "duo",
        feature: "feat",
        agent: { name: "agent1", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a" },
        peer: null,
        taskSpec: "spec",
        peerReview: null,
        peerStatus: null,
        peerPlan: null,
        gitDiffStat: null,
        previousRoundSummary: null,
        mergeVotes: null,
        worktreePath: "/tmp/a",
        peerWorktreePath: null,
        statusFile: "/tmp/status",
        planFile: "/tmp/plan",
        reviewFile: "/tmp/review",
        prFile: "/tmp/pr",
        interruptFile: "/tmp/interrupt",
        mergeVoteFile: "/tmp/vote",
        suggestRefactorFile: "/tmp/suggest",
        workflowFeedbackFile: "/tmp/feedback",
        mergeReviewDecisionFile: "/tmp/merge-decision",
        mergedMarkerFile: "/tmp/merged",
        peerSyncDir: "/tmp/peer-sync",
        doneStatus: "review-done",
      },
    });
    expect(text).toContain("agent1");
    expect(text).toContain("review-done");
  });

  test("composes a concrete reviewer message", async () => {
    const state = makeState();
    const reviewer = state.agents[1]!;
    const message = await composeSkillMessage(state, reviewer);
    expect(message).toContain("Pair Review");
    expect(message).toContain(".peer-sync");
  });
});
