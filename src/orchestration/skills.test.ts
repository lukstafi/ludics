import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { composeSkillMessage, resolveTemplatePath, substituteTemplate } from "./skills.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "./state.ts";
import { ludicsRoot } from "../config.ts";

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
    TASK_AC: "",
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
      try { unlinkSync(synthetic); } catch { /* ignore */ }
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

  test("substituteTemplate: preserves <!-- section:... --> anchors and existing HTML comments", () => {
    // Anchors inserted by gh-ludics-315 are invisible-in-rendering HTML comments.
    // substituteTemplate() must pass them through verbatim so future sanitization
    // refactors don't silently strip the anchors from rendered skill text.
    const template = [
      "<!-- section:top -->",
      "## Process",
      "",
      "{{#IF AGENT_NAME}}",
      "<!-- section:inside-if -->",
      "step body referencing {{AGENT_NAME}}",
      "{{/IF}}",
      "",
      "{{#IF MISSING_VAR}}",
      "<!-- section:should-be-dropped -->",
      "hidden body",
      "{{/IF}}",
      "",
      "<!-- Entry: sync-learnings | 2026-04-24 -->",
      "entry content",
      "<!-- End entry -->",
    ].join("\n");
    const rendered = substituteTemplate(template, baseCtx());
    expect(rendered).toContain("<!-- section:top -->");
    expect(rendered).toContain("<!-- section:inside-if -->");
    expect(rendered).toContain("step body referencing agent1");
    expect(rendered).not.toContain("<!-- section:should-be-dropped -->");
    expect(rendered).not.toContain("hidden body");
    expect(rendered).toContain("<!-- Entry: sync-learnings | 2026-04-24 -->");
    expect(rendered).toContain("<!-- End entry -->");
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

  test("pr-comments template targets the PR URL and includes --repo with PROJECT_REPO", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-comments.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PR_FILE: "/tmp/coder.pr",
      PROJECT_REPO: "owner/my-staging",
    });
    expect(rendered).toContain('PR_URL=$(cat "/tmp/coder.pr"');
    expect(rendered).toContain('gh pr view "$PR_URL" --repo "owner/my-staging" --json reviews,comments');
    // Bare `gh pr view --json` (no URL arg) must be gone
    expect(rendered).not.toMatch(/gh pr view --json/);
  });

  test("pr-comments template omits --repo when PROJECT_REPO is empty but still passes the PR URL", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-comments.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, { ...baseCtx(), PR_FILE: "/tmp/coder.pr" });
    expect(rendered).toContain('gh pr view "$PR_URL" --json reviews,comments');
    expect(rendered).not.toContain("--repo");
  });

  test("pr-conflict-resolve template targets the PR URL and includes --repo for all three gh pr view calls", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pr-conflict-resolve.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PR_FILE: "/tmp/coder.pr",
      PROJECT_REPO: "owner/my-staging",
    });
    expect(rendered).toContain('PR_URL=$(cat "/tmp/coder.pr"');
    expect(rendered).toContain('gh pr view "$PR_URL" --repo "owner/my-staging" --json baseRefName');
    expect(rendered).toContain('gh pr view "$PR_URL" --repo "owner/my-staging" --json mergeable');
    expect(rendered).toContain('gh pr view "$PR_URL" --repo "owner/my-staging" --json reviews,comments');
    // No bare `gh pr view --json` left in the template after rendering
    expect(rendered).not.toMatch(/gh pr view --json/);
  });

  test("final-merge template targets the PR URL and includes --repo with PROJECT_REPO", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/final-merge.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PR_FILE: "/tmp/coder.pr",
      PROJECT_REPO: "owner/my-staging",
    });
    expect(rendered).toContain('PR_URL=$(cat "/tmp/coder.pr"');
    expect(rendered).toContain('gh pr merge "$PR_URL" --repo "owner/my-staging" --merge --delete-branch');
    expect(rendered).not.toMatch(/gh pr merge --merge/);
  });

  test("final-merge template omits --repo when PROJECT_REPO is empty but still passes the PR URL", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/final-merge.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, { ...baseCtx(), PR_FILE: "/tmp/coder.pr" });
    expect(rendered).toContain('gh pr merge "$PR_URL" --merge --delete-branch');
    expect(rendered).not.toContain("--repo");
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
      try { unlinkSync(tmpCfg); } catch { /* ignore */ }
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

  // PROPOSAL_FRESHNESS_WARNING tests (gh-ludics-311)
  // Uses real tmp git repos rather than mocking safeSyncOutput so the exact git
  // commands and return-value shapes the production path relies on are exercised.

  function runGit(cwd: string, args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`);
    }
  }

  function initGitRepoWithProposal(
    projectDir: string,
    proposalRelPath: string,
    proposalBody: string,
    extraCommits: number,
    opts?: { seedOrigin?: boolean },
  ): void {
    const j = join;
    const seedOrigin = opts?.seedOrigin !== false;
    mkdirSync(projectDir, { recursive: true });
    runGit(projectDir, ["init", "-q"]);
    runGit(projectDir, ["config", "user.email", "test@example.com"]);
    runGit(projectDir, ["config", "user.name", "test"]);
    runGit(projectDir, ["config", "commit.gpgsign", "false"]);
    const proposalAbs = j(projectDir, proposalRelPath);
    mkdirSync(dirname(proposalAbs), { recursive: true });
    writeFileSync(proposalAbs, proposalBody);
    runGit(projectDir, ["add", proposalRelPath]);
    runGit(projectDir, ["commit", "-q", "-m", "init"]);
    for (let i = 0; i < extraCommits; i++) {
      runGit(projectDir, ["commit", "-q", "--allow-empty", "-m", `x${i}`]);
    }
    if (seedOrigin) {
      runGit(projectDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    }
  }

  test("PROPOSAL_FRESHNESS_WARNING: empty when task has no proposal frontmatter", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-none-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-no-prop.md"), [
        "---", "id: task-no-prop", "---", "", "body",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-no-prop", projectDir: j(tmpDir, "project"), round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_PATH"]).toBe("");
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: empty for proposal: inline", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-inline-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-inline.md"), [
        "---", "id: task-inline", "proposal: inline", "---", "", "## Motivation", "", "Inline body.",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-inline", projectDir: j(tmpDir, "project"), round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_PATH"]).toBe("");
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: warns when proposal is 15 commits stale", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-stale-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-stale.md"), [
        "---", "id: task-stale", "proposal: docs/proposals/stale.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      initGitRepoWithProposal(projectDir, "docs/proposals/stale.md", "# Stale proposal\n", 15);
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-stale", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toContain("Freshness warning");
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toContain("15 commits");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toContain("Read the proposal file");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toContain("Freshness warning");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toContain("15 commits");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: empty when proposal is 5 commits fresh", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-fresh-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-fresh.md"), [
        "---", "id: task-fresh", "proposal: docs/proposals/fresh.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      initGitRepoWithProposal(projectDir, "docs/proposals/fresh.md", "# Fresh proposal\n", 5);
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-fresh", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toBe(
        "**Step 0**: Read the proposal file at `docs/proposals/fresh.md` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.",
      );
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: boundary — exactly 10 commits does NOT trigger", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-boundary-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-boundary.md"), [
        "---", "id: task-boundary", "proposal: docs/proposals/boundary.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      initGitRepoWithProposal(projectDir, "docs/proposals/boundary.md", "# Boundary proposal\n", 10);
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-boundary", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      // Threshold is strictly > 10, so 10 commits since proposal does NOT trigger.
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: empty (and does not throw) when projectDir is not a git repo", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-nogit-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      mkdir2(projectDir, { recursive: true }); // exists but no .git
      write2(j(harnessTasks, "task-nogit.md"), [
        "---", "id: task-nogit", "proposal: docs/proposals/nogit.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-nogit", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
      expect(ctx["PROPOSAL_INSTRUCTION"]).toContain("Read the proposal file");
      expect(ctx["PROPOSAL_INSTRUCTION"]).not.toContain("Freshness warning");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: invalid absolute proposal path — warning empty, no throw", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-badpath-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    const spy = spyOn(console, "error");
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-bad2.md"), [
        "---", "id: task-bad2", "proposal: /etc/passwd", "---",
        "", "## Acceptance Criteria", "- [ ] Legacy content here",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-bad2", projectDir: j(tmpDir, "project"), round: 1 };
      expect(() => buildSkillContext(state, state.agents[0]!)).not.toThrow();
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
    } finally {
      spy.mockRestore();
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: feature-branch churn does not inflate count", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-feature-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-feature.md"), [
        "---", "id: task-feature", "proposal: docs/proposals/feature.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      // M=12 main-side commits after the proposal, pinned as origin/main tip.
      initGitRepoWithProposal(projectDir, "docs/proposals/feature.md", "# Feature proposal\n", 12);
      // F=7 feature-branch commits after origin/main — these must NOT be counted.
      runGit(projectDir, ["checkout", "-q", "-b", "feature"]);
      for (let i = 0; i < 7; i++) {
        runGit(projectDir, ["commit", "-q", "--allow-empty", "-m", `f${i}`]);
      }
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-feature", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toContain("Freshness warning");
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toContain("12 commits");
      // Regression guard: the old hash..HEAD command would have reported 19.
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).not.toContain("19 commits");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: empty when origin has no detectable default branch", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-noorigin-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-noorigin.md"), [
        "---", "id: task-noorigin", "proposal: docs/proposals/noorigin.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      // 15 commits would have triggered the warning under origin/main semantics —
      // but with seedOrigin=false no refs/remotes/origin/* refs exist, so
      // detectDefaultBranches returns origin=null and the helper returns "".
      initGitRepoWithProposal(
        projectDir, "docs/proposals/noorigin.md", "# No-origin proposal\n", 15,
        { seedOrigin: false },
      );
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-noorigin", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("PROPOSAL_FRESHNESS_WARNING: empty when proposal commit is not an ancestor of origin/main", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-freshness-unreach-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      const projectDir = j(tmpDir, "project");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-unreach.md"), [
        "---", "id: task-unreach", "proposal: docs/proposals/unreach.md", "---",
        "", "## Acceptance Criteria", "- [ ] Do the thing",
      ].join("\n"));
      // Bootstrap repo with a non-proposal init commit so we have a base to
      // branch from for both main and the side branch.
      mkdirSync(projectDir, { recursive: true });
      runGit(projectDir, ["init", "-q"]);
      runGit(projectDir, ["config", "user.email", "test@example.com"]);
      runGit(projectDir, ["config", "user.name", "test"]);
      runGit(projectDir, ["config", "commit.gpgsign", "false"]);
      runGit(projectDir, ["commit", "-q", "--allow-empty", "-m", "base"]);
      // Advance main to 11 commits past the base; pin origin/main at the tip.
      for (let i = 0; i < 11; i++) {
        runGit(projectDir, ["commit", "-q", "--allow-empty", "-m", `m${i}`]);
      }
      runGit(projectDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      // Create a side branch from the base commit and commit the proposal there.
      // origin/main does not contain this commit, so merge-base --is-ancestor
      // fails and the helper must return "".
      runGit(projectDir, ["checkout", "-q", "-b", "side", "HEAD~11"]);
      const proposalRel = "docs/proposals/unreach.md";
      const proposalAbs = j(projectDir, proposalRel);
      mkdirSync(dirname(proposalAbs), { recursive: true });
      writeFileSync(proposalAbs, "# Unreachable proposal\n");
      runGit(projectDir, ["add", proposalRel]);
      runGit(projectDir, ["commit", "-q", "-m", "add proposal on side"]);
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-unreach", projectDir, round: 1 };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["PROPOSAL_FRESHNESS_WARNING"]).toBe("");
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
      try { unlinkSync(tmpCfg); } catch { /* ignore */ }
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
      try { unlinkSync(tmpCfg); } catch { /* ignore */ }
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
      try { unlinkSync(tmpCfg); } catch { /* ignore */ }
    }
  });

  test("composeSkillMessage uses templateOverride when provided", async () => {
    const writeFs = writeFileSync;
    const unlinkFs = unlinkSync;
    const mkTmp = mkdtempSync;
    const joinPath = join;
    const osTmpdir = tmpdir;
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
    expect(withProposal).toContain("under `dependencies:`");
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
    const templatePath = join(ludicsRoot(), "skills", "orchestration", "pr-conflict-resolve.md");
    const template = readFileSync(templatePath, "utf-8");
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

  describe("regression-test section contract (gh-ludics-310)", () => {
    const tplDir = join(import.meta.dir, "../../skills/orchestration");
    const read = (name: string) => readFileSync(join(tplDir, name), "utf-8");

    test("pair-coder-plan.md requires a structural `## Regression Tests` section", () => {
      const content = read("pair-coder-plan.md");
      expect(content).toContain("## Regression Tests");
      expect(content).toMatch(/No regression test needed/);
      expect(content).toMatch(/REQUEST_CHANGES if it is missing/);
      expect(content).not.toMatch(
        /As you plan, call out the regression tests each behavior change needs/,
      );
    });

    test("pair-coder-plan-merge.md requires preservation of the `## Regression Tests` section with per-file accounting", () => {
      const content = read("pair-coder-plan-merge.md");
      expect(content).toContain("## Regression Tests");
      expect(content).toMatch(/Preserve the per-file accounting: do not deduplicate/);
      expect(content).not.toMatch(
        /As you plan, call out the regression tests each behavior change needs/,
      );
    });

    test("pair-reviewer-plan-review.md checks for the structural section and preserves REQUEST_CHANGES", () => {
      const content = read("pair-reviewer-plan-review.md");
      expect(content).toMatch(
        /Does the merged plan contain a top-level `?## Regression Tests`? section\?/,
      );
      expect(content).toContain("REQUEST_CHANGES");
    });

    test("pair-reviewer-plan.md carries the same `## Regression Tests` contract as the coder plan", () => {
      const content = read("pair-reviewer-plan.md");
      expect(content).toContain("## Regression Tests");
      expect(content).toMatch(/No regression test needed/);
      expect(content).toMatch(/plan-review step will REQUEST_CHANGES/);
    });
  });

  test("TASK_AC: extracts body of ## Acceptance Criteria with multiple bullets", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-task-ac-happy-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-ac1.md"), [
        "---", "id: task-ac1", "---",
        "",
        "## Context",
        "",
        "Some context.",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] Do thing A",
        "- [ ] Do thing B",
        "- [ ] Do thing C",
        "",
        "## Notes",
        "",
        "Additional notes.",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-ac1", projectDir: j(tmpDir, "project") };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_AC"]).toContain("Do thing A");
      expect(ctx["TASK_AC"]).toContain("Do thing B");
      expect(ctx["TASK_AC"]).toContain("Do thing C");
      expect(ctx["TASK_AC"]).not.toContain("Additional notes");
      expect(ctx["TASK_AC"]).not.toContain("Some context");
      expect(ctx["TASK_AC"]).not.toContain("## Acceptance Criteria");
      expect(ctx["TASK_AC"]).not.toContain("## Notes");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TASK_AC: empty when task file has no ## Acceptance Criteria section", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-task-ac-missing-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-ac2.md"), [
        "---", "id: task-ac2", "---",
        "",
        "## Context",
        "",
        "Only a context section here.",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-ac2", projectDir: j(tmpDir, "project") };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_AC"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TASK_AC: empty when section contains only `- [ ] TBD` placeholder", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-task-ac-tbd-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-ac3.md"), [
        "---", "id: task-ac3", "---",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] TBD",
        "",
        "## Notes",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-ac3", projectDir: j(tmpDir, "project") };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_AC"]).toBe("");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("TASK_AC: AC section followed by ## heading does not bleed into next section", async () => {
    const { mkdtempSync, mkdirSync: mkdir2, writeFileSync: write2, rmSync } = await import("fs");
    const { join: j } = await import("path");
    const tmpDir = mkdtempSync("/tmp/ludics-skills-task-ac-trim-");
    const origHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      const harnessTasks = j(tmpDir, "harness", "tasks");
      mkdir2(harnessTasks, { recursive: true });
      write2(j(harnessTasks, "task-ac4.md"), [
        "---", "id: task-ac4", "---",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] first criterion",
        "- [ ] second criterion",
        "",
        "## Notes",
        "",
        "note text that must not bleed into TASK_AC.",
      ].join("\n"));
      process.env.LUDICS_HARNESS_DIR = j(tmpDir, "harness");
      const { buildSkillContext } = await import("./skills.ts");
      const state = { ...makeState(), taskId: "task-ac4", projectDir: j(tmpDir, "project") };
      const ctx = buildSkillContext(state, state.agents[0]!);
      expect(ctx["TASK_AC"]).toContain("first criterion");
      expect(ctx["TASK_AC"]).toContain("second criterion");
      expect(ctx["TASK_AC"]).not.toContain("note text that must not bleed");
      expect(ctx["TASK_AC"]).not.toContain("## Notes");
    } finally {
      if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
      else delete process.env.LUDICS_HARNESS_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pair-coder-work: unconditional AC self-check + no-proposal fallback renders when PROPOSAL_PATH is empty", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-work.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(rendered).toContain("Acceptance Criteria self-check");
    // No-proposal fallback must fire explicitly (proposal AC #1).
    expect(rendered).toContain("Re-read the task spec above");
    expect(rendered).toContain("no proposal file exists");
    // Proposal re-read branch must NOT render in this state.
    expect(rendered).not.toMatch(/Re-read `[^`]+` in the project repo/);
  });

  test("pair-coder-work: AC self-check references PROPOSAL_PATH when set and omits the no-proposal fallback", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-work.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "(ignored)",
    });
    expect(rendered).toContain("Acceptance Criteria self-check");
    expect(rendered).toContain("Re-read `docs/proposals/my-feature.md`");
    // Fallback must NOT render when a proposal exists.
    expect(rendered).not.toContain("Re-read the task spec above");
    expect(rendered).not.toContain("no proposal file exists");
  });

  test("pair-coder-work: AC self-check references WORKFLOW_FEEDBACK_FILE and the visible-checklist heading", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-work.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      WORKFLOW_FEEDBACK_FILE: "/tmp/peer-sync/workflow-feedback-coder.md",
    });
    expect(rendered).toContain("/tmp/peer-sync/workflow-feedback-coder.md");
    expect(rendered).toContain("## AC Verification");
    expect(rendered).toContain("visible checklist");
  });

  test("pair-reviewer-review: AC verification section renders with and without PROPOSAL_PATH", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-review.md");
    const template = readFileSync(templatePath, "utf-8");
    const withProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "docs/proposals/my-feature.md",
      PROPOSAL_INSTRUCTION: "(ignored)",
    });
    expect(withProposal).toContain("Acceptance criteria verification");
    expect(withProposal).toContain("blocking action item");
    expect(withProposal).toContain("Re-read `docs/proposals/my-feature.md` for the authoritative acceptance criteria");

    const withoutProposal = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
    });
    expect(withoutProposal).toContain("Acceptance criteria verification");
    expect(withoutProposal).toContain("blocking action item");
    // The re-read bullet only appears when PROPOSAL_PATH is set.
    expect(withoutProposal).not.toMatch(/Re-read `[^`]+` for the authoritative/);
  });

  test("pair-reviewer-review: AC verification section inlines TASK_AC content when non-empty", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-reviewer-review.md");
    const template = readFileSync(templatePath, "utf-8");
    const rendered = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
      TASK_AC: "- [ ] criterion alpha\n- [ ] criterion beta",
    });
    expect(rendered).toContain("Task acceptance criteria from the task file");
    expect(rendered).toContain("criterion alpha");
    expect(rendered).toContain("criterion beta");

    // Empty TASK_AC must collapse the inline block.
    const empty = substituteTemplate(template, {
      ...baseCtx(),
      PROPOSAL_PATH: "",
      PROPOSAL_INSTRUCTION: "",
      TASK_AC: "",
    });
    expect(empty).not.toContain("Task acceptance criteria from the task file");
  });

  test("pair-coder-work: legacy invisible AC wording is gone from the raw template", () => {
    const templatePath = join(import.meta.dir, "../../skills/orchestration/pair-coder-work.md");
    const raw = readFileSync(templatePath, "utf-8");
    // Negative regression for proposal AC #5: no duplicate / legacy AC path.
    expect(raw).not.toContain("in your thinking");
    expect(raw).not.toContain("stating explicitly");
  });
});
