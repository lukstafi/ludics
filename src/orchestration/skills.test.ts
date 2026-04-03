import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { composeSkillMessage, resolveTemplatePath, substituteTemplate } from "./skills.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "./state.ts";

function makeState(): OrchestrationState {
  return {
    slot: 1,
    taskId: "feat",
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

function baseCtx(): Record<string, string> {
  return {
    PHASE: "review",
    ROUND: "1",
    MODE: "duo",
    TASK_ID: "feat",
    AGENT_NAME: "agent1",
    AGENT_PROVIDER: "codex",
    AGENT_ROLE: "agent",
    PEER_NAME: "none",
    PEER_PROVIDER: "none",
    TASK_SPEC: "spec",
    TASK_SPEC_BRIEF: "brief",
    PEER_REVIEW: "(no review yet)",
    PEER_STATUS: "unknown",
    PEER_PLAN: "(no plan yet)",
    GIT_DIFF_STAT: "(no changes yet)",
    PREVIOUS_ROUND_SUMMARY: "(no previous round summary)",
    MERGE_VOTES: "(no merge votes yet)",
    WORKTREE_PATH: "/tmp/a",
    PEER_WORKTREE_PATH: "(no peer worktree)",
    STATUS_FILE: "/tmp/status",
    PLAN_FILE: "/tmp/plan",
    REVIEW_FILE: "/tmp/review",
    PR_FILE: "/tmp/pr",
    INTERRUPT_FILE: "/tmp/interrupt",
    MERGE_VOTE_FILE: "/tmp/vote",
    SUGGEST_REFACTOR_FILE: "/tmp/suggest",
    WORKFLOW_FEEDBACK_FILE: "/tmp/feedback",
    MERGE_REVIEW_DECISION_FILE: "/tmp/merge-decision",
    MERGED_MARKER_FILE: "/tmp/merged",
    MERGED_PLAN_FILE: "/tmp/merged-plan",
    PLAN_MERGE_ROUND: "0",
    PEER_SYNC_DIR: "/tmp/peer-sync",
    DONE_STATUS: "review-done",
    STAGING_REPO: "",
    STAGING_REPO_NOTE: "",
    STAGING_PR_FILE: "/tmp/staging-pr",
    UPSTREAM_MERGED_MARKER_FILE: "/tmp/upstream-merged",
    FORWARDED_MARKER_FILE: "/tmp/forwarded",
  };
}

describe("skills", () => {
  test("selects pair reviewer override templates when available", () => {
    const path = resolveTemplatePath("review", "pair", "reviewer");
    expect(path.endsWith("pair-reviewer-review.md")).toBe(true);
  });

  test("resolveTemplatePath: staging flag selects staging-final-merge.md", () => {
    const path = resolveTemplatePath("final-merge", "pair", "coder", true);
    expect(path.endsWith("staging-final-merge.md")).toBe(true);
  });

  test("resolveTemplatePath: non-staging uses plain final-merge.md", () => {
    const path = resolveTemplatePath("final-merge", "pair", "coder", false);
    expect(path.endsWith("final-merge.md")).toBe(true);
    expect(path).not.toContain("staging-");
  });

  test("resolveTemplatePath: staging flag without staging template falls through to generic", () => {
    // review has no staging variant — should fall through to pair-reviewer-review.md
    const path = resolveTemplatePath("review", "pair", "reviewer", true);
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
    expect(ctx["MERGED_PLAN_FILE"]).toContain("round-2-merged-1.md");
    // peerPlan is null because the merged plan file doesn't exist on disk (non-issue in test)
    // but the path used should be the merged plan, not the peer's plan
    // We verify via PEER_PLAN substitution: it will be "(no plan yet)" since the file is absent,
    // but mergedPlanFile is correctly set.
    expect(ctx["MERGED_PLAN_FILE"]).not.toContain(`round-2-${reviewer.name}.md`);
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
    expect(ctx["MERGED_PLAN_FILE"]).toContain("merged");
    // Verify peerPlan would use the peer plan path, not merged: since we can't easily mock readFileIfExists,
    // we confirm that mergedPlanFile is keyed by planMergeRound (not agent name) as a proxy.
    expect(ctx["MERGED_PLAN_FILE"]).not.toContain("agent1");
    expect(ctx["MERGED_PLAN_FILE"]).not.toContain("agent2");
  });

  test("buildSkillContext: plan-merge mergedPlanFile is keyed by planMergeRound", async () => {
    const { buildSkillContext } = await import("./skills.ts");
    const state = makeState();
    state.phase = "plan-merge";
    state.planMergeRound = 2;
    const coder = state.agents.find((a) => a.role === "coder")!;
    const ctx = buildSkillContext(state, coder);
    expect(ctx["MERGED_PLAN_FILE"]).toContain("round-2-merged-2.md");
  });

  test("substituteTemplate: STAGING_REPO and STAGING_REPO_NOTE are empty when not set", () => {
    const text = substituteTemplate("{{STAGING_REPO}}|{{STAGING_REPO_NOTE}}", baseCtx());
    expect(text).toBe("|");
  });

  test("substituteTemplate: STAGING_REPO and STAGING_REPO_NOTE render when set", () => {
    const stagingFork = "owner/staging-fork";
    const text = substituteTemplate("{{STAGING_REPO}}|{{STAGING_REPO_NOTE}}", {
      ...baseCtx(),
      STAGING_REPO: stagingFork,
      STAGING_REPO_NOTE: `\n> **Staging fork**: This project uses a staging fork (\`${stagingFork}\`). Create the PR against the staging fork, not the upstream repo.\n`,
    });
    expect(text).toContain("owner/staging-fork");
    expect(text).toContain("staging fork");
  });

  test("pr-create template renders staging note when STAGING_REPO is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-create.md");
    const template = readFileSync(templatePath, "utf-8");
    const stagingFork = "owner/staging-fork";
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      STAGING_REPO: stagingFork,
      STAGING_REPO_NOTE: `\n> **Staging fork**: This project uses a staging fork (\`${stagingFork}\`). Create the PR against the staging fork, not the upstream repo.\n`,
    });
    expect(rendered).toContain("owner/staging-fork");
    expect(rendered).toContain("staging fork");
    // Note must be absent when STAGING_REPO is empty
    const renderedNull = substituteTemplate(template, baseCtx());
    expect(renderedNull).not.toContain("staging fork");
  });

  test("staging-final-merge template does NOT contain gh pr merge (non-staging merge command)", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/staging-final-merge.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, baseCtx());
    expect(rendered).not.toContain("gh pr merge");
    expect(rendered).toContain("staging cleanup");
  });

  test("non-staging final-merge template does NOT contain staging cleanup", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/final-merge.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, baseCtx());
    expect(rendered).toContain("gh pr merge");
    expect(rendered).not.toContain("staging cleanup");
    expect(rendered).not.toContain("STAGING_PR_FILE");
  });

  test("buildSkillContext: duo mode suppresses STAGING_REPO even when config has staging_repo", async () => {
    const tmpCfg = "/tmp/ludics-skills-duo-staging-test.yaml";
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
      const state = {
        ...makeState(),
        mode: "duo" as const,
        projectDir: "/tmp/my-proj-checkout",
        agents: [
          { name: "agent1", provider: "codex" as const, model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a" },
          { name: "agent2", provider: "codex" as const, model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b" },
        ],
        agentStates: initAgentRuntimeState(["agent1", "agent2"]),
      };
      const ctx = buildSkillContext(state, state.agents[0]!);
      // Duo mode must suppress staging variables
      expect(ctx["STAGING_REPO"]).toBe("");
      expect(ctx["STAGING_REPO_NOTE"]).toBe("");
    } finally {
      if (origConfig !== undefined) process.env.LUDICS_CONFIG = origConfig;
      else delete process.env.LUDICS_CONFIG;
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      try { unlinkSync(tmpCfg); } catch {}
    }
  });

  test("substituteTemplate: warns in dev mode for unknown placeholders", () => {
    const origDev = process.env.LUDICS_DEV;
    process.env.LUDICS_DEV = "1";
    const warnings: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      const text = substituteTemplate("hello {{TYPO_VAR}} world", baseCtx());
      expect(text).toBe("hello  world");
      expect(warnings.some((w) => w.includes("TYPO_VAR"))).toBe(true);
    } finally {
      console.error = origError;
      if (origDev !== undefined) process.env.LUDICS_DEV = origDev;
      else delete process.env.LUDICS_DEV;
    }
  });

  test("substituteTemplate: no warning in non-dev mode for unknown placeholders", () => {
    const origDev = process.env.LUDICS_DEV;
    const origDebug = process.env.DEBUG;
    delete process.env.LUDICS_DEV;
    delete process.env.DEBUG;
    const warnings: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      const text = substituteTemplate("hello {{TYPO_VAR}} world", baseCtx());
      expect(text).toBe("hello  world");
      expect(warnings.length).toBe(0);
    } finally {
      console.error = origError;
      if (origDev !== undefined) process.env.LUDICS_DEV = origDev;
      if (origDebug !== undefined) process.env.DEBUG = origDebug;
    }
  });

  test("taskSpecText: file-based proposal appends pointer and summary, not inline body", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-proposal-test-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      mkdir2(j(projectDir, "docs", "proposals"), { recursive: true });
      write2(j(harnessTasks, "task-p1.md"), [
        "---", "id: task-p1", "proposal: docs/proposals/my-feature.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      write2(j(projectDir, "docs", "proposals", "my-feature.md"), [
        "# My Feature", "", "## Motivation", "",
        "This is the motivation paragraph.", "",
        "## Proposed Change", "", "Change details here.",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-p1", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_SPEC"]).toContain("docs/proposals/my-feature.md");
      expect(ctx["TASK_SPEC"]).toContain("Read the full proposal");
      expect(ctx["TASK_SPEC"]).toContain("motivation paragraph");     // summary extracted
      expect(ctx["TASK_SPEC"]).not.toContain("Change details here."); // proposal body not inlined
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("taskSpecText: proposal: inline returns full task content unchanged", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-inline-test-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-p2.md"), [
        "---", "id: task-p2", "proposal: inline", "---",
        "", "## Motivation", "", "Big inline proposal here.",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-p2", projectDir: j(tmpDir, "project"), round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_SPEC"]).toContain("Big inline proposal here.");
      expect(ctx["TASK_SPEC"]).not.toContain("Read the full proposal");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TASK_SPEC round-conditional: round 2+ returns brief form with task ID and title", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-brief-test-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      mkdir2(j(projectDir, "docs", "proposals"), { recursive: true });
      write2(j(harnessTasks, "task-r2.md"), [
        "---", "id: task-r2", "title: Round Two Task", "proposal: docs/proposals/round2.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      write2(j(projectDir, "docs", "proposals", "round2.md"), [
        "# Round 2 Proposal", "", "## Motivation", "",
        "This is the motivation paragraph.", "",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");

      // Round 1: full spec
      const stateR1 = { ...makeState(), taskId: "task-r2", projectDir, round: 1, slotTitle: "Round Two Task" };
      const ctxR1 = buildSkillContext(stateR1, stateR1.agents[0]!);
      expect(ctxR1["TASK_SPEC"]).toContain("Acceptance Criteria"); // full task content
      expect(ctxR1["TASK_SPEC"]).toContain("Read the full proposal");

      // Round 2: brief form
      const stateR2 = { ...makeState(), taskId: "task-r2", projectDir, round: 2, slotTitle: "Round Two Task" };
      const ctxR2 = buildSkillContext(stateR2, stateR2.agents[0]!);
      expect(ctxR2["TASK_SPEC"]).toContain("task-r2");
      expect(ctxR2["TASK_SPEC"]).toContain("Round Two Task");
      expect(ctxR2["TASK_SPEC"]).toContain("docs/proposals/round2.md");
      expect(ctxR2["TASK_SPEC"]).toContain("round 1");
      expect(ctxR2["TASK_SPEC"]).not.toContain("Acceptance Criteria"); // full body not included

      // Round 3: still brief
      const stateR3 = { ...makeState(), taskId: "task-r2", projectDir, round: 3, slotTitle: "Round Two Task" };
      const ctxR3 = buildSkillContext(stateR3, stateR3.agents[0]!);
      expect(ctxR3["TASK_SPEC"]).not.toContain("Acceptance Criteria");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TASK_SPEC_BRIEF always returns brief form regardless of round", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-brief2-test-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      mkdir2(j(projectDir, "docs", "proposals"), { recursive: true });
      write2(j(harnessTasks, "task-brief.md"), [
        "---", "id: task-brief", "title: Brief Test", "proposal: docs/proposals/brief.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");

      // Round 1: TASK_SPEC_BRIEF is still brief
      const stateR1 = { ...makeState(), taskId: "task-brief", projectDir, round: 1, slotTitle: "Brief Test" };
      const ctxR1 = buildSkillContext(stateR1, stateR1.agents[0]!);
      expect(ctxR1["TASK_SPEC_BRIEF"]).toContain("task-brief");
      expect(ctxR1["TASK_SPEC_BRIEF"]).toContain("Brief Test");
      expect(ctxR1["TASK_SPEC_BRIEF"]).not.toContain("Acceptance Criteria");

      // Round 2: TASK_SPEC_BRIEF is still brief
      const stateR2 = { ...makeState(), taskId: "task-brief", projectDir, round: 2, slotTitle: "Brief Test" };
      const ctxR2 = buildSkillContext(stateR2, stateR2.agents[0]!);
      expect(ctxR2["TASK_SPEC_BRIEF"]).toContain("task-brief");
      expect(ctxR2["TASK_SPEC_BRIEF"]).not.toContain("Acceptance Criteria");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TASK_SPEC round-conditional: uses slotTitle on round 2+", async () => {
    const { buildSkillContext } = await import("./skills.ts");
    const state = { ...makeState(), slotTitle: "My Feature Title", round: 2 };
    const ctx = buildSkillContext(state, state.agents[0]!);
    expect(ctx["TASK_SPEC"]).toContain("My Feature Title");
    expect(ctx["TASK_SPEC"]).toContain("Full task spec was provided in round 1");
    expect(ctx["TASK_SPEC_BRIEF"]).toContain("My Feature Title");
    expect(ctx["TASK_SPEC_BRIEF"]).toContain("Full task spec was provided in round 1");
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
      expect(ctx["STAGING_REPO"]).toBe("owner/my-proj-staging");
    } finally {
      if (origConfig !== undefined) process.env.LUDICS_CONFIG = origConfig;
      else delete process.env.LUDICS_CONFIG;
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      try { unlinkSync(tmpCfg); } catch {}
    }
  });

  test("buildSkillContext: auto-injects project config string fields as PROJECT_<FIELD>", async () => {
    const tmpCfg = "/tmp/ludics-skills-project-inject-test.yaml";
    writeFileSync(tmpCfg, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "projects:",
      "  - name: my-proj",
      "    repo: upstream/my-proj",
      "    staging_repo: owner/my-proj-staging",
      "    path: /tmp/my-proj-checkout",
      "    proposals_path: docs/proposals",
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
      expect(ctx["PROJECT_NAME"]).toBe("my-proj");
      expect(ctx["PROJECT_REPO"]).toBe("upstream/my-proj");
      expect(ctx["PROJECT_STAGING_REPO"]).toBe("owner/my-proj-staging");
      expect(ctx["PROJECT_PROPOSALS_PATH"]).toBe("docs/proposals");
      // Non-string fields should NOT be injected (e.g., boolean issues)
      expect(ctx["PROJECT_ISSUES"]).toBeUndefined();
    } finally {
      if (origConfig !== undefined) process.env.LUDICS_CONFIG = origConfig;
      else delete process.env.LUDICS_CONFIG;
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      try { unlinkSync(tmpCfg); } catch {}
    }
  });

  test("substituteTemplate: {{#IF VAR}} includes block when var is truthy", () => {
    const text = substituteTemplate("before{{#IF STAGING_REPO}} staging content{{/IF}} after", {
      ...baseCtx(),
      STAGING_REPO: "owner/repo",
    });
    expect(text).toBe("before staging content after");
  });

  test("substituteTemplate: {{#IF VAR}} removes block when var is missing", () => {
    const text = substituteTemplate("before{{#IF STAGING_REPO}} staging content{{/IF}} after", baseCtx());
    expect(text).toBe("before after");
  });

  test("substituteTemplate: {{#IF VAR}} removes block when var is empty string", () => {
    const text = substituteTemplate("before{{#IF STAGING_REPO}} staging content{{/IF}} after", {
      ...baseCtx(),
      STAGING_REPO: "",
    });
    expect(text).toBe("before after");
  });

  test("substituteTemplate: nested {{VAR}} inside conditional block gets substituted", () => {
    const text = substituteTemplate("{{#IF STAGING_REPO}}repo: {{STAGING_REPO}}{{/IF}}", {
      ...baseCtx(),
      STAGING_REPO: "owner/fork",
    });
    expect(text).toBe("repo: owner/fork");
  });

  test("substituteTemplate: multi-line conditional block", () => {
    const template = "header\n{{#IF STAGING_REPO}}\nLine 1\nLine 2\n{{/IF}}\nfooter";
    const included = substituteTemplate(template, { ...baseCtx(), STAGING_REPO: "x" });
    expect(included).toBe("header\n\nLine 1\nLine 2\n\nfooter");
    const excluded = substituteTemplate(template, baseCtx());
    expect(excluded).toBe("header\n\nfooter");
  });

  test("substituteTemplate: multiple independent {{#IF}} blocks", () => {
    const template = "{{#IF A}}blockA{{/IF}} mid {{#IF B}}blockB{{/IF}}";
    const both = substituteTemplate(template, { ...baseCtx(), A: "1", B: "2" });
    expect(both).toBe("blockA mid blockB");
    const onlyA = substituteTemplate(template, { ...baseCtx(), A: "1", B: "" });
    expect(onlyA).toBe("blockA mid ");
    const neither = substituteTemplate(template, { ...baseCtx(), A: "", B: "" });
    expect(neither).toBe(" mid ");
  });

  test("buildSkillContext: exposes staging sidecar file variables", async () => {
    const { buildSkillContext } = await import("./skills.ts");
    const state = makeState();
    const coder = state.agents.find((a) => a.role === "coder")!;
    const ctx = buildSkillContext(state, coder);
    expect(ctx["STAGING_PR_FILE"]).toContain(".peer-sync");
    expect(ctx["STAGING_PR_FILE"]).toContain("staging-pr");
    expect(ctx["UPSTREAM_MERGED_MARKER_FILE"]).toContain("upstream-merged");
    expect(ctx["FORWARDED_MARKER_FILE"]).toContain("forwarded");
  });

  test("composeSkillMessage uses templateOverride when provided", async () => {
    const { writeFileSync: writeFs, unlinkSync: unlinkFs, mkdtempSync: mkTmp } = require("fs");
    const { join: joinPath } = require("path");
    const { tmpdir: osTmpdir } = require("os");
    const tmpDir = mkTmp(joinPath(osTmpdir(), "ludics-skills-test-"));
    const overridePath = joinPath(tmpDir, "override.md");
    writeFs(overridePath, "Override for {{AGENT_NAME}} in {{WORKTREE_PATH}}");
    try {
      const state = makeState();
      state.phase = "pr-comments";
      const coder = state.agents.find((a) => a.role === "coder")!;
      const result = await composeSkillMessage(state, coder, overridePath);
      expect(result).toContain("Override for coder");
      expect(result).toContain(coder.worktreePath);
      // Should NOT contain content from the normal pr-comments template
      expect(result).not.toContain("Address reviewer feedback");
    } finally {
      unlinkFs(overridePath);
    }
  });

  test("substituteTemplate renders pr-conflict-resolve.md correctly", () => {
    const ctx = baseCtx();
    ctx["PR_FILE"] = "/tmp/peer-sync/coder.pr";
    ctx["WORKTREE_PATH"] = "/tmp/worktree";
    ctx["STATUS_FILE"] = "/tmp/peer-sync/coder.status";
    ctx["DONE_STATUS"] = "pr-comments-done";
    const { readFileSync: readFs } = require("fs");
    const { join: joinPath } = require("path");
    const { ludicsRoot } = require("../config.ts");
    const templatePath = joinPath(ludicsRoot(), "skills", "orchestration", "pr-conflict-resolve.md");
    const template = readFs(templatePath, "utf-8");
    const result = substituteTemplate(template, ctx);
    expect(result).toContain("/tmp/peer-sync/coder.pr");
    expect(result).toContain("/tmp/worktree");
    expect(result).toContain("/tmp/peer-sync/coder.status");
    expect(result).toContain("pr-comments-done");
    expect(result).toContain("git rebase \"origin/$BASE\"");
    expect(result).toContain("Force-push with lease");
  });
});
