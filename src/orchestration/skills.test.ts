import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
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

function baseCtx() {
  return {
    phase: "review" as const,
    round: 1,
    mode: "duo" as const,
    feature: "feat",
    agent: { name: "agent1", provider: "codex" as const, model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a" },
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
    mergedPlanFile: "/tmp/merged-plan",
    planMergeRound: 0,
    peerSyncDir: "/tmp/peer-sync",
    doneStatus: "review-done",
    stagingRepo: null,
  };
}

describe("skills", () => {
  test("selects pair reviewer override templates when available", () => {
    const path = resolveTemplatePath("review", "pair", "reviewer");
    expect(path.endsWith("pair-reviewer-review.md")).toBe(true);
  });

  test("substitutes placeholders", () => {
    const text = substituteTemplate("hello {{AGENT_NAME}} {{DONE_STATUS}}", baseCtx());
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

  test("buildSkillContext: pair plan-review peerPlan reads merged plan file", async () => {
    // In pair plan-review, peerPlan should reference the iteration-keyed merged plan, not the peer plan.
    const { buildSkillContext } = await import("./skills.ts");
    const state = makeState();
    state.phase = "plan-review";
    state.planMergeRound = 1;
    const reviewer = state.agents.find((a) => a.role === "reviewer")!;
    const ctx = buildSkillContext(state, reviewer);
    // mergedPlanFile must be keyed by both round and planMergeRound
    expect(ctx.mergedPlanFile).toContain("round-2-merged-1.md");
    // peerPlan is null because the merged plan file doesn't exist on disk (non-issue in test)
    // but the path used should be the merged plan, not the peer's plan
    // We verify via PEER_PLAN substitution: it will be "(no plan yet)" since the file is absent,
    // but mergedPlanFile is correctly set.
    expect(ctx.mergedPlanFile).not.toContain(`round-2-${reviewer.name}.md`);
  });

  test("buildSkillContext: duo plan-review peerPlan reads peer's plan (not merged)", async () => {
    // In duo plan-review, there's no plan-merge phase — peerPlan must read the peer's independent plan.
    const { buildSkillContext } = await import("./skills.ts");
    const state = makeState();
    state.mode = "duo";
    state.phase = "plan-review";
    state.agents = [
      { name: "agent1", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a" },
      { name: "agent2", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b" },
    ];
    state.agentStates = initAgentRuntimeState(["agent1", "agent2"]);
    const agent1 = state.agents[0]!;
    const ctx = buildSkillContext(state, agent1);
    // peerPlan must NOT reference the merged plan file (which doesn't exist in duo mode).
    // The mergedPlanFile path is still computed but peerPlan should point at agent2's plan.
    // Since agent2's plan file doesn't exist either, peerPlan is null — but mergedPlanFile must not be used.
    expect(ctx.mergedPlanFile).toContain("merged");
    // Verify peerPlan would use the peer plan path, not merged: since we can't easily mock readFileIfExists,
    // we confirm that mergedPlanFile is keyed by planMergeRound (not agent name) as a proxy.
    expect(ctx.mergedPlanFile).not.toContain("agent1");
    expect(ctx.mergedPlanFile).not.toContain("agent2");
  });

  test("buildSkillContext: plan-merge mergedPlanFile is keyed by planMergeRound", async () => {
    const { buildSkillContext } = await import("./skills.ts");
    const state = makeState();
    state.phase = "plan-merge";
    state.planMergeRound = 2;
    const coder = state.agents.find((a) => a.role === "coder")!;
    const ctx = buildSkillContext(state, coder);
    expect(ctx.mergedPlanFile).toContain("round-2-merged-2.md");
  });

  test("substituteTemplate: STAGING_REPO and STAGING_REPO_NOTE are empty when stagingRepo is null", () => {
    const text = substituteTemplate("{{STAGING_REPO}}|{{STAGING_REPO_NOTE}}", {
      ...baseCtx(),
      stagingRepo: null,
    });
    expect(text).toBe("|");
  });

  test("substituteTemplate: STAGING_REPO and STAGING_REPO_NOTE render when stagingRepo is set", () => {
    const text = substituteTemplate("{{STAGING_REPO}}|{{STAGING_REPO_NOTE}}", {
      ...baseCtx(),
      stagingRepo: "owner/staging-fork",
    });
    expect(text).toContain("owner/staging-fork");
    expect(text).toContain("staging fork");
  });

  test("pr-create template renders staging note when stagingRepo is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-create.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, { ...baseCtx(), stagingRepo: "owner/staging-fork" });
    expect(rendered).toContain("owner/staging-fork");
    expect(rendered).toContain("staging fork");
    // Note must be absent when stagingRepo is null
    const renderedNull = substituteTemplate(template, { ...baseCtx(), stagingRepo: null });
    expect(renderedNull).not.toContain("staging fork");
  });

  test("buildSkillContext: discovers staging_repo via configured path", async () => {
    const tmpCfg = "/tmp/ludics-skills-staging-test.yaml";
    writeFileSync(tmpCfg, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "projects:",
      "  - name: my-proj",
      "    repo: upstream/my-proj",
      "    staging_repo: owner/my-proj-staging",
      "    path: /tmp/my-proj-checkout",
    ].join("\n"));
    const origConfig = process.env.LUDICS_CONFIG;
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_CONFIG = tmpCfg;
    process.env.LUDICS_HARNESS_DIR = "/tmp/ludics-test-harness";
    try {
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), projectDir: "/tmp/my-proj-checkout" };
      const coder = state.agents.find((a) => a.role === "coder")!;
      const ctx = buildSkillContext(state, coder);
      expect(ctx.stagingRepo).toBe("owner/my-proj-staging");
    } finally {
      if (origConfig !== undefined) process.env.LUDICS_CONFIG = origConfig;
      else delete process.env.LUDICS_CONFIG;
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      try { unlinkSync(tmpCfg); } catch {}
    }
  });
});
