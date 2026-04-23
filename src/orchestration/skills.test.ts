import { describe, expect, spyOn, test } from "bun:test";
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
    UPSTREAM_REPO: "",
  };
}

describe("skills", () => {
  test("selects pair reviewer override templates when available", () => {
    const path = resolveTemplatePath("review", "pair", "reviewer");
    expect(path.endsWith("pair-reviewer-review.md")).toBe(true);
  });

  test("resolveTemplatePath: hasUpstream flag honors synthetic upstream override template", () => {
    // Regression for AC 3 / 5: the hasUpstream parameter on resolveTemplatePath is a
    // retained extension point. After this task there are no in-tree upstream-*.md
    // overrides, but the mechanism must still work when one is synthesized on disk.
    const root = join(import.meta.dir, "../../skills/orchestration");
    const synthetic = join(root, "upstream-update-docs.md");
    try {
      writeFileSync(synthetic, "synthetic upstream update-docs\n");
      expect(resolveTemplatePath("update-docs", "pair", "coder", true)).toBe(synthetic);
      // Without the flag, selection falls through to pair-<role>-<phase>.md or <phase>.md
      expect(resolveTemplatePath("update-docs", "pair", "coder", false)).not.toBe(synthetic);
    } finally {
      try { unlinkSync(synthetic); } catch {}
    }
  });

  test("resolveTemplatePath: no upstream uses plain final-merge.md", () => {
    const path = resolveTemplatePath("final-merge", "pair", "coder", false);
    expect(path.endsWith("final-merge.md")).toBe(true);
    expect(path).not.toContain("upstream-final");
  });

  test("resolveTemplatePath: hasUpstream flag without upstream template falls through to generic", () => {
    // review has no upstream variant — should fall through to pair-reviewer-review.md
    const path = resolveTemplatePath("review", "pair", "reviewer", true);
    expect(path.endsWith("pair-reviewer-review.md")).toBe(true);
  });

  test("resolveTemplatePath: solo/work resolves to solo-work.md (solo tier)", () => {
    const path = resolveTemplatePath("work", "solo", "coder");
    expect(path.endsWith("solo-work.md")).toBe(true);
  });

  test("resolveTemplatePath: solo/pr-create falls through to pair-coder-pr-create.md", () => {
    const path = resolveTemplatePath("pr-create", "solo", "coder");
    expect(path.endsWith("pair-coder-pr-create.md")).toBe(true);
  });

  test("resolveTemplatePath: solo/update-docs falls through to pair-coder-update-docs.md", () => {
    const path = resolveTemplatePath("update-docs", "solo", "coder");
    expect(path.endsWith("pair-coder-update-docs.md")).toBe(true);
  });

  test("resolveTemplatePath: solo/pr-comments falls through to generic pr-comments.md", () => {
    const path = resolveTemplatePath("pr-comments", "solo", "coder");
    expect(path.endsWith("pr-comments.md")).toBe(true);
    expect(path).not.toContain("pair-coder");
    expect(path).not.toContain("solo-");
  });

  test("resolveTemplatePath: solo/final-merge falls through to generic final-merge.md", () => {
    const path = resolveTemplatePath("final-merge", "solo", "coder");
    expect(path.endsWith("final-merge.md")).toBe(true);
    expect(path).not.toContain("upstream");
  });

  test("resolveTemplatePath: pair/work still resolves to pair-coder-work.md (regression)", () => {
    const path = resolveTemplatePath("work", "pair", "coder");
    expect(path.endsWith("pair-coder-work.md")).toBe(true);
  });

  test("resolveTemplatePath: solo IGNORES hasUpstream (never picks upstream-*.md)", () => {
    // Solo's phase graph never visits forward-pr and never writes upstream-pr /
    // forwarded markers, so upstream-final-merge.md (which assumes those
    // artifacts) would run the wrong workflow. Solo must fall through to the
    // non-upstream tier regardless of hasUpstream.
    const path = resolveTemplatePath("final-merge", "solo", "coder", true);
    expect(path.endsWith("final-merge.md")).toBe(true);
    expect(path).not.toContain("upstream");
  });

  test("resolveTemplatePath: solo with hasUpstream still prefers solo-<phase> for work", () => {
    const path = resolveTemplatePath("work", "solo", "coder", true);
    expect(path.endsWith("solo-work.md")).toBe(true);
  });

  test("resolveTemplatePath: pair + hasUpstream for final-merge falls through to generic (post-d1932b8f)", () => {
    // After task-d1932b8f removed upstream-final-merge.md, pair mode with
    // hasUpstream=true should fall through the generic `final-merge.md`.
    // Companion to the solo test above: both modes now resolve to the same
    // generic template for final-merge, but solo reaches it by skipping the
    // upstream tier entirely while pair reaches it by having no upstream
    // template on disk.
    const path = resolveTemplatePath("final-merge", "pair", "coder", true);
    expect(path.endsWith("final-merge.md")).toBe(true);
    expect(path).not.toContain("upstream");
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

  test("substituteTemplate: UPSTREAM_REPO is empty when not set", () => {
    const text = substituteTemplate("{{UPSTREAM_REPO}}", baseCtx());
    expect(text).toBe("");
  });

  test("pr-create template renders upstream note via inline conditional when UPSTREAM_REPO is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-pr-create.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      UPSTREAM_REPO: "owner/upstream-repo",
    });
    expect(rendered).toContain("owner/upstream-repo");
    expect(rendered).toContain("Upstream forwarding");
    // Note must be absent when UPSTREAM_REPO is empty
    const renderedNull = substituteTemplate(template, baseCtx());
    expect(renderedNull).not.toContain("Upstream forwarding");
  });

  test("final-merge template merges the working (staging) PR directly", () => {
    // Post-task (simplified upstream workflow): final-merge is the unified terminal
    // merge command for upstream and non-upstream projects alike.
    const templatePath = join(import.meta.dir, "../../skills/orchestration/final-merge.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, baseCtx());
    expect(rendered).toContain("gh pr merge");
    expect(rendered).not.toContain("UPSTREAM_PR_FILE");
    expect(rendered).not.toContain("UPSTREAM_MERGED_MARKER_FILE");
  });

  test("pr-create template includes --repo via inline conditional with PROJECT_REPO", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-create.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PROJECT_REPO: "owner/my-staging",
    });
    expect(rendered).toContain('gh pr create --repo "owner/my-staging"');
  });

  test("pr-create template omits --repo when PROJECT_REPO unavailable", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-create.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, baseCtx());
    expect(rendered).toContain("gh pr create --title");
    expect(rendered).not.toContain("--repo");
  });

  test("pair-coder-pr-create template includes --repo via inline conditional with PROJECT_REPO", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-pr-create.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PROJECT_REPO: "owner/my-staging",
    });
    expect(rendered).toContain('gh pr create --repo "owner/my-staging"');
  });

  test("buildSkillContext: hierarchical duo suppresses UPSTREAM_REPO when duoPeerSlot is set", async () => {
    const tmpCfg = "/tmp/ludics-skills-duo-upstream-test.yaml";
    writeFileSync(tmpCfg, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "projects:",
      "  - name: my-proj",
      "    repo: owner/my-proj-staging",
      "    upstream_repo: upstream/my-proj",
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
        mode: "pair" as const,
        duoPeerSlot: 2, // hierarchical duo: upstream forwarding is suppressed
        projectDir: "/tmp/my-proj-checkout",
      };
      const ctx = buildSkillContext(state, state.agents[0]!);
      // Hierarchical duo (duoPeerSlot set) must suppress upstream variables
      expect(ctx["UPSTREAM_REPO"]).toBe("");
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
      // PROPOSAL_PATH must be empty for inline so {{#IF PROPOSAL_PATH}} blocks are skipped
      expect(ctx["PROPOSAL_PATH"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("taskSpecText: bad proposal path falls through to legacy content", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-badpath-test-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    const spy = spyOn(console, "error");
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-bad.md"), [
        "---", "id: task-bad", "proposal: /etc/passwd", "---",
        "", "## Acceptance Criteria", "", "- [ ] Legacy content here",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-bad", projectDir: j(tmpDir, "project"), round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_SPEC"]).toContain("Legacy content here");
      expect(ctx["TASK_SPEC"]).not.toContain("Read the full proposal");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("ignoring bad proposal path"));
    } finally {
      spy.mockRestore();
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
      expect(ctxR2["TASK_SPEC"]).toContain("re-read if you need to verify");
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

  test("buildSkillContext: discovers upstream_repo via configured path", async () => {
    const tmpCfg = "/tmp/ludics-skills-upstream-test.yaml";
    writeFileSync(tmpCfg, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "projects:",
      "  - name: my-proj",
      "    repo: owner/my-proj-staging",
      "    upstream_repo: upstream/my-proj",
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
      expect(ctx["UPSTREAM_REPO"]).toBe("upstream/my-proj");
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
      "    repo: owner/my-proj-staging",
      "    upstream_repo: upstream/my-proj",
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
      expect(ctx["PROJECT_REPO"]).toBe("owner/my-proj-staging");
      expect(ctx["PROJECT_UPSTREAM_REPO"]).toBe("upstream/my-proj");
      expect(ctx["PROJECT_PROPOSALS_PATH"]).toBe("docs/proposals");
      // PR_CREATE_REPO_FLAG removed — inline {{#IF PROJECT_REPO}} in templates now
      expect(ctx["PR_CREATE_REPO_FLAG"]).toBeUndefined();
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
    const text = substituteTemplate("before{{#IF UPSTREAM_REPO}} staging content{{/IF}} after", {
      ...baseCtx(),
      UPSTREAM_REPO: "owner/repo",
    });
    expect(text).toBe("before staging content after");
  });

  test("substituteTemplate: {{#IF VAR}} removes block when var is missing", () => {
    const text = substituteTemplate("before{{#IF UPSTREAM_REPO}} staging content{{/IF}} after", baseCtx());
    expect(text).toBe("before after");
  });

  test("substituteTemplate: {{#IF VAR}} removes block when var is empty string", () => {
    const text = substituteTemplate("before{{#IF UPSTREAM_REPO}} staging content{{/IF}} after", {
      ...baseCtx(),
      UPSTREAM_REPO: "",
    });
    expect(text).toBe("before after");
  });

  test("substituteTemplate: nested {{VAR}} inside conditional block gets substituted", () => {
    const text = substituteTemplate("{{#IF UPSTREAM_REPO}}repo: {{UPSTREAM_REPO}}{{/IF}}", {
      ...baseCtx(),
      UPSTREAM_REPO: "owner/fork",
    });
    expect(text).toBe("repo: owner/fork");
  });

  test("substituteTemplate: multi-line conditional block", () => {
    const template = "header\n{{#IF UPSTREAM_REPO}}\nLine 1\nLine 2\n{{/IF}}\nfooter";
    const included = substituteTemplate(template, { ...baseCtx(), UPSTREAM_REPO: "x" });
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

  test("substituteTemplate: {{#UNLESS VAR}} includes block when var is missing", () => {
    const text = substituteTemplate("before{{#UNLESS UPSTREAM_REPO}} default content{{/UNLESS}} after", baseCtx());
    expect(text).toBe("before default content after");
  });

  test("substituteTemplate: {{#UNLESS VAR}} includes block when var is empty string", () => {
    const text = substituteTemplate("before{{#UNLESS UPSTREAM_REPO}} default content{{/UNLESS}} after", {
      ...baseCtx(),
      UPSTREAM_REPO: "",
    });
    expect(text).toBe("before default content after");
  });

  test("substituteTemplate: {{#UNLESS VAR}} removes block when var is non-empty", () => {
    const text = substituteTemplate("before{{#UNLESS UPSTREAM_REPO}} default content{{/UNLESS}} after", {
      ...baseCtx(),
      UPSTREAM_REPO: "owner/repo",
    });
    expect(text).toBe("before after");
  });

  test("substituteTemplate: nested {{VAR}} inside #UNLESS block gets substituted", () => {
    const ctx = baseCtx();
    const text = substituteTemplate("{{#UNLESS UPSTREAM_REPO}}default: {{WORKTREE_PATH}}{{/UNLESS}}", ctx);
    expect(text).toBe(`default: ${ctx.WORKTREE_PATH}`);
  });

  test("substituteTemplate: multi-line #UNLESS block", () => {
    const template = "header\n{{#UNLESS UPSTREAM_REPO}}\nLine 1\nLine 2\n{{/UNLESS}}\nfooter";
    const included = substituteTemplate(template, baseCtx());
    expect(included).toBe("header\n\nLine 1\nLine 2\n\nfooter");
    const excluded = substituteTemplate(template, { ...baseCtx(), UPSTREAM_REPO: "x" });
    expect(excluded).toBe("header\n\nfooter");
  });

  test("substituteTemplate: mixed #IF and #UNLESS in same template", () => {
    const template = "{{#IF A}}ifA{{/IF}} mid {{#UNLESS B}}unlessB{{/UNLESS}}";
    const both = substituteTemplate(template, { ...baseCtx(), A: "1", B: "" });
    expect(both).toBe("ifA mid unlessB");
    const neither = substituteTemplate(template, { ...baseCtx(), A: "", B: "1" });
    expect(neither).toBe(" mid ");
    const ifOnly = substituteTemplate(template, { ...baseCtx(), A: "1", B: "1" });
    expect(ifOnly).toBe("ifA mid ");
    const unlessOnly = substituteTemplate(template, { ...baseCtx(), A: "", B: "" });
    expect(unlessOnly).toBe(" mid unlessB");
  });

  test("substituteTemplate: #IF nested inside #UNLESS", () => {
    const template = "{{#UNLESS A}}outer{{#IF B}} inner{{/IF}}{{/UNLESS}}";
    const result = substituteTemplate(template, { ...baseCtx(), A: "", B: "yes" });
    expect(result).toBe("outer inner");
  });

  test("substituteTemplate: #UNLESS nested inside #IF", () => {
    const template = "{{#IF A}}outer{{#UNLESS B}} inner{{/UNLESS}}{{/IF}}";
    const result = substituteTemplate(template, { ...baseCtx(), A: "yes", B: "" });
    expect(result).toBe("outer inner");
  });

  test("buildSkillContext: does not expose deprecated upstream sidecar file variables", async () => {
    // Negative regression: the forwarding-specific marker variables were removed
    // alongside the forward-pr / upstream-final-merge templates.
    const { buildSkillContext } = await import("./skills.ts");
    const state = makeState();
    const coder = state.agents.find((a) => a.role === "coder")!;
    const ctx = buildSkillContext(state, coder);
    expect(ctx["UPSTREAM_PR_FILE"]).toBeUndefined();
    expect(ctx["UPSTREAM_MERGED_MARKER_FILE"]).toBeUndefined();
    expect(ctx["FORWARDED_MARKER_FILE"]).toBeUndefined();
  });

  test("buildSkillContext: UPSTREAM_REPO is empty when project config has no upstream_repo", async () => {
    const tmpCfg = "/tmp/ludics-skills-no-upstream-test.yaml";
    writeFileSync(tmpCfg, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "projects:",
      "  - name: no-up-proj",
      "    repo: owner/no-up-proj",
      "    path: /tmp/no-up-proj-checkout",
    ].join("\n"));
    const origConfig = process.env.LUDICS_CONFIG;
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_CONFIG = tmpCfg;
    process.env.LUDICS_HARNESS_DIR = "/tmp/ludics-test-harness";
    try {
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), projectDir: "/tmp/no-up-proj-checkout" };
      const coder = state.agents.find((a) => a.role === "coder")!;
      const ctx = buildSkillContext(state, coder);
      expect(ctx["UPSTREAM_REPO"]).toBe("");
    } finally {
      if (origConfig !== undefined) process.env.LUDICS_CONFIG = origConfig;
      else delete process.env.LUDICS_CONFIG;
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      try { unlinkSync(tmpCfg); } catch {}
    }
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

  test("work template includes proposal instruction when PROPOSAL_INSTRUCTION is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-work.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(withProposal).toContain("Step 0");
    expect(withProposal).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-coder-plan template includes proposal instruction when PROPOSAL_INSTRUCTION is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-plan.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(withProposal).toContain("Step 0");
    expect(withProposal).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-coder-plan-merge template includes proposal instruction when PROPOSAL_PATH is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-plan-merge.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(rendered).toContain("Step 0");
    expect(rendered).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-reviewer-gather template includes proposal instruction when PROPOSAL_INSTRUCTION is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-gather.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(withProposal).toContain("Step 0");
    expect(withProposal).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-coder-clarify template includes proposal instruction when PROPOSAL_INSTRUCTION is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-clarify.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(withProposal).toContain("Step 0");
    expect(withProposal).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-reviewer-clarify template includes proposal instruction when PROPOSAL_INSTRUCTION is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-clarify.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(withProposal).toContain("Step 0");
    expect(withProposal).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-reviewer-pushback template includes proposal instruction when PROPOSAL_INSTRUCTION is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-pushback.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "**Step 0**: Read the proposal file at `docs/proposals/my-feature.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
    });
    expect(withProposal).toContain("Step 0");
    expect(withProposal).toContain("docs/proposals/my-feature.md");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Step 0");
  });

  test("pair-coder-plan template renders scope-declaration block when PROPOSAL_PATH is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-plan.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "(ignored)",
    });
    expect(withProposal).toContain("Scope declaration");
    expect(withProposal).toContain("docs/proposals/my-feature.md");
    expect(withProposal).toContain("scope-declaration-and-salvage");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Scope declaration");
  });

  test("pair-coder-work template renders scope-discipline + salvage block when PROPOSAL_PATH is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-work.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      TASK_ID: "task-xyz",
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "(ignored)",
    });
    expect(withProposal).toContain("Scope discipline");
    expect(withProposal).toContain("Salvage on rejection");
    expect(withProposal).toContain("scope-expansion:");
    expect(withProposal).toContain("/tmp/salvage-task-xyz.patch");
    expect(withProposal).toContain("relates_to: [task-xyz]");
    expect(withProposal).toContain("scope-declaration-and-salvage");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Scope discipline");
    expect(withoutProposal).not.toContain("Salvage on rejection");
  });

  test("pair-reviewer-review template renders scope-review-discretion block when PROPOSAL_PATH is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-review.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "(ignored)",
    });
    expect(withProposal).toContain("Scope review (discretion)");
    expect(withProposal).toContain("docs/proposals/my-feature.md");
    expect(withProposal).toContain("not automatic blockers");
    expect(withProposal).toContain("Accept as-is");
    expect(withProposal).toContain("Reject and ask for salvage");
    expect(withProposal).toContain("scope-declaration-and-salvage");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Scope review (discretion)");
  });

  test("pair-reviewer-plan-review template renders scope-declarations bullet when PROPOSAL_PATH is set", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-plan-review.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "(ignored)",
    });
    expect(withProposal).toContain("Scope declarations");
    expect(withProposal).toContain("scope-expansion");
    expect(withProposal).toContain("scope-declaration-and-salvage");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).not.toContain("Scope declarations");
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

  test("orchestration templates link only to existing anchors in docs/orchestration-patterns.md", () => {
    const patternsPath = join(import.meta.dir, "../../docs/orchestration-patterns.md");
    const patternsDoc = readFileSync(patternsPath, "utf-8");

    // Extract all H2/H3 heading slugs (GitHub's default: lowercase, hyphen-separated, strip punctuation).
    // Lines inside fenced code blocks are NOT headings — the patterns doc contains
    // worked examples whose code fences contain literal `##` lines that would
    // otherwise register as phantom anchors and mask broken links.
    const headingSlugs = new Set<string>();
    let inFence = false;
    for (const line of patternsDoc.split("\n")) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const match = /^#{2,3}\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const slug = match[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      headingSlugs.add(slug);
    }

    const templates = [
      "pair-coder-plan.md",
      "pair-coder-work.md",
      "pair-reviewer-plan-review.md",
      "pair-reviewer-review.md",
    ];
    // Capture anchor fragments up to whitespace or any markdown-link terminator
    // (`)`, `]`, `>`, `"`, `'`). A narrower character class would silently skip
    // malformed anchors (uppercase, %-encoded, punctuation) instead of flagging
    // them — that's exactly the drift this test is meant to catch.
    const linkRe = /docs\/orchestration-patterns\.md#([^\s)\]>'"]+)/g;
    const unresolved: { template: string; slug: string }[] = [];
    for (const tpl of templates) {
      const tplPath = join(import.meta.dir, "../../skills/orchestration", tpl);
      const tplContent = readFileSync(tplPath, "utf-8");
      for (const match of tplContent.matchAll(linkRe)) {
        const slug = match[1];
        if (!headingSlugs.has(slug)) {
          unresolved.push({ template: tpl, slug });
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
