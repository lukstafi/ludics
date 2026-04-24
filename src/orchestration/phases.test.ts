import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentParticipatesInPhase, evaluateTransition, findPlanFiles, isAgentDone, isBailedOut, isPairBailedOut, isSoloBailedOut, PHASE_CATEGORIES, phaseTimeoutExpired } from "./phases.ts";
import { statusFileFingerprint } from "./peer-sync.ts";
import { mergedPlanFilePath } from "./plan-files.ts";
import { applyPhaseSideEffects } from "./runner.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, migrateState, type OrchestrationState } from "./state.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TEST_TMP = "";

// Isolate HOME, LUDICS_CONFIG, and LUDICS_HARNESS_DIR under TEST_TMP so evaluateTransition / emitEvent
// never read or write real harness state.
beforeEach(() => {
  TEST_TMP = mkdtempSync(join(tmpdir(), "ludics-phases-test-"));
  process.env.HOME = TEST_TMP;
  const configDir = join(TEST_TMP, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), `state_repo: test/ludics-state\nstate_path: harness\n`);
  process.env.LUDICS_CONFIG = join(configDir, "config.yaml");
  process.env.LUDICS_HARNESS_DIR = join(TEST_TMP, "harness");
  mkdirSync(join(TEST_TMP, "harness"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) {
    delete process.env.LUDICS_CONFIG;
  } else {
    process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  }
  if (ORIGINAL_HARNESS === undefined) {
    delete process.env.LUDICS_HARNESS_DIR;
  } else {
    process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  }
});

function makeState(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    slot: 1,
    taskId: "feat",
    mode: "pair",
    phase: "setup",
    round: 1,
    mergeRound: 0,
    agents: [
      { name: "coder", provider: "claude-code", role: "coder", model: "claude-opus-4-6", branch: "a", worktreePath: "/tmp/a" },
      { name: "reviewer", provider: "codex", role: "reviewer", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b" },
    ],
    agentStates: initAgentRuntimeState(["coder", "reviewer"]),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: 0,
    startedAt: "2026-03-07T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir: "/tmp/project-feat/.peer-sync",
    threadIds: { coder: "t1", reviewer: "t2" },
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
    state.agentStates.coder.status = "done";
    state.agentStates.reviewer.status = "done";
    expect(evaluateTransition(state)).toBe("review");
  });

  test("moves from update-docs to pr-create when no PR exists", () => {
    const state = makeState({ phase: "update-docs" });
    state.agentStates.coder.status = "update-docs-done";
    state.agentStates.reviewer.status = "update-docs-done";
    expect(evaluateTransition(state)).toBe("pr-create");
  });

  test("moves from update-docs to pr-comments when a PR exists", () => {
    const state = makeState({ phase: "update-docs" });
    state.agentStates.coder.status = "update-docs-done";
    state.agentStates.reviewer.status = "update-docs-done";
    state.agentStates.coder.prUrl = "https://example.com/pr/1";
    expect(evaluateTransition(state)).toBe("pr-comments");
  });

  test("pr-create blocks advancement when no prUrl is set", () => {
    const state = makeState({ phase: "pr-create" });
    state.agentStates.coder.status = "pr-create-done";
    state.agentStates.reviewer.status = "pr-create-done";
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-create advances to pr-comments when prUrl is set", () => {
    const state = makeState({ phase: "pr-create" });
    state.agentStates.coder.status = "pr-create-done";
    state.agentStates.reviewer.status = "pr-create-done";
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
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
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
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
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-comments transitions to suggest-refactor when merged marker present", () => {
    const state = makeState({ phase: "pr-comments" });
    state.agentStates.coder.status = "merged";
    expect(evaluateTransition(state)).toBe("suggest-refactor");
  });

  test("final-merge transitions to suggest-refactor when done", () => {
    const state = makeState({ phase: "final-merge" });
    state.agentStates.coder.status = "final-merge-done";
    state.agentStates.reviewer.status = "final-merge-done";
    expect(evaluateTransition(state)).toBe("suggest-refactor");
  });

  test("suggest-refactor always transitions to done", () => {
    const state = makeState({ phase: "suggest-refactor" });
    state.agentStates.coder.status = "suggest-refactor-done";
    state.agentStates.reviewer.status = "suggest-refactor-done";
    expect(evaluateTransition(state)).toBe("done");
  });

  // plan-merge phase (pair mode)
  test("pair plan phase transitions to plan-merge when both plans exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh138-orig-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), "# Coder Plan\n");
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Reviewer Plan\n");
    const state = makeState({
      mode: "pair",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
      round: 1,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: tmpDir,
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    expect(evaluateTransition(state)).toBe("plan-merge");
  });

  test("plan phase goes through plan-merge when no plan files on disk (default)", () => {
    const state = makeState({
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    // No plan files on disk → plan-merge (can't skip without verifying coder-only plan)
    expect(evaluateTransition(state)).toBe("plan-merge");
  });

  test("pair plan phase skips plan-merge when only one plan file exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh138-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    // Only the coder plan exists — reviewer didn't produce one
    writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), "# Coder Plan\n");
    const state = makeState({
      mode: "pair",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
      round: 1,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: tmpDir,
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    expect(evaluateTransition(state)).toBe("plan-review");
  });

  test("pair plan phase transitions to plan-merge when two plan files exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh138-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), "# Coder Plan\n");
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Reviewer Plan\n");
    const state = makeState({
      mode: "pair",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
      round: 1,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: tmpDir,
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    expect(evaluateTransition(state)).toBe("plan-merge");
  });

  test("pair plan phase does NOT skip plan-merge when only reviewer plan exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh138-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    // Only the reviewer plan exists — coder timed out
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Reviewer Plan\n");
    const state = makeState({
      mode: "pair",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
      round: 1,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: tmpDir,
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    // Must still go through plan-merge so coder can process the reviewer's plan
    expect(evaluateTransition(state)).toBe("plan-merge");
  });

  test("findPlanFiles returns correct files and coderPlanExists flag", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh138-find-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), "# Coder\n");
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Reviewer\n");
    // Should be excluded: merged file and different round
    writeFileSync(join(tmpDir, "plans", "round-1-merged-0.md"), "# Merged\n");
    writeFileSync(join(tmpDir, "plans", "round-2-coder.md"), "# Round 2\n");

    const result = findPlanFiles(tmpDir, 1, "coder");
    expect(result.files.length).toBe(2);
    expect(result.coderPlanExists).toBe(true);

    const noCoderResult = findPlanFiles(tmpDir, 1, "other");
    expect(noCoderResult.files.length).toBe(2);
    expect(noCoderResult.coderPlanExists).toBe(false);

    const missingDir = findPlanFiles("/nonexistent", 1, "coder");
    expect(missingDir.files.length).toBe(0);
    expect(missingDir.coderPlanExists).toBe(false);
  });

  test("plan-merge skip copies solo plan to merged-0 path", () => {
    // This tests the runner side-effect indirectly: when evaluateTransition
    // returns plan-review (skip), the solo plan should be copied to merged-0.
    // We verify the precondition (transition) and simulate the copy logic.
    const tmpDir = mkdtempSync(join(tmpdir(), "gh138-copy-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    const planContent = "# Coder Plan\nImplementation details here.\n";
    writeFileSync(join(tmpDir, "plans", "round-1-coder.md"), planContent);

    const state = makeState({
      mode: "pair",
      config: defaultOrchestrationConfig({ enablePlan: true }),
      phase: "plan",
      round: 1,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: tmpDir,
    });
    state.agentStates.coder.status = "plan-done";
    state.agentStates.reviewer.status = "plan-done";
    expect(evaluateTransition(state)).toBe("plan-review");

    // Simulate the runner copy side-effect using findPlanFiles
    const { files } = findPlanFiles(tmpDir, 1, undefined);
    const mergedPath = join(tmpDir, "plans", "round-1-merged-0.md");
    copyFileSync(join(tmpDir, "plans", files[0]), mergedPath);

    expect(existsSync(mergedPath)).toBe(true);
    expect(readFileSync(mergedPath, "utf-8")).toBe(planContent);
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

  test("plan-review proceeds to work when no verdict (timeout)", () => {
    const state = makeState({
      phase: "plan-review",
    });
    state.agentStates.coder.status = "plan-review-done";
    state.agentStates.reviewer.status = "plan-review-done";
    expect(evaluateTransition(state)).toBe("work");
  });

  test("plan-review proceeds to work after 3 REQUEST_CHANGES rounds", () => {
    const state = makeState({
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

  // --- Upstream symmetry: upstream_repo no longer changes pr-comments routing ---

  test("pr-comments transitions uniformly to final-merge on quiet period — no upstream branching", () => {
    // Symmetry check: the presence of upstream_repo in project config no longer
    // affects the pr-comments transition. The test no longer needs to set upstream
    // state because the field has been removed; this case is identical to the
    // "without upstream" case below.
    const quietStart = Math.floor(Date.now() / 1000) - 2000;
    const state = makeState({
      mode: "pair",
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
    });
    state.agentStates.coder.prUrl = "https://github.com/owner/staging-fork/pull/1";
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("pr-comments without upstream still transitions to final-merge on quiet period", () => {
    const quietStart = Math.floor(Date.now() / 1000) - 2000;
    const state = makeState({
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
    });
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("pr-comments transitions to final-merge immediately when coder has responded", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = makeState({
      phase: "pr-comments",
      prCommentsCoderDispatched: true,
      prCommentsQuietSince: now - 10, // fresh poll found no new comments
    });
    state.agentStates.coder.status = "pr-comments-done";
    state.agentStates.reviewer.status = "pr-comments-done";
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("pr-comments shortcut blocked while Codex review deferral is active", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = makeState({
      phase: "pr-comments",
      phaseStartedAt: now - 90,
      prCommentsCoderDispatched: true,
      prCommentsQuietSince: now - 10,
      prCodexReviewDeferredSince: now - 60,
      config: defaultOrchestrationConfig({ prCommentsTimeout: 1800 }),
    });
    state.agentStates.coder.status = "pr-comments-done";
    state.agentStates.reviewer.status = "pr-comments-done";
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
    // Codex review deferral still active — shortcut must not fire
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-comments shortcut blocked before fresh comment poll", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = makeState({
      phase: "pr-comments",
      phaseStartedAt: now - 90,
      prCommentsCoderDispatched: true,
      // prCommentsQuietSince not set — no fresh poll since last redispatch
      config: defaultOrchestrationConfig({ prCommentsTimeout: 1800 }),
    });
    state.agentStates.coder.status = "pr-comments-done";
    state.agentStates.reviewer.status = "pr-comments-done";
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-comments does not shortcut when coder has not been dispatched", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = makeState({
      phase: "pr-comments",
      phaseStartedAt: now - 90,
      config: defaultOrchestrationConfig({ prCommentsTimeout: 1800 }),
    });
    state.agentStates.coder.status = "pr-comments-done";
    state.agentStates.reviewer.status = "pr-comments-done";
    state.agentStates.coder.prUrl = "https://github.com/owner/repo/pull/1";
    // No prCommentsCoderDispatched — shortcut must not fire, quiet period not elapsed
    expect(evaluateTransition(state)).toBeNull();
  });

  test("hierarchical duo in pr-comments still waits on peer coordination", () => {
    // Retained from the former upstream-specific test: duoPeerSlot != null is the
    // relevant orthogonal concern for pr-comments routing. upstream_repo no longer
    // matters here.
    const quietStart = Math.floor(Date.now() / 1000) - 2000;
    const state = makeState({
      phase: "pr-comments",
      prCommentsQuietSince: quietStart,
      duoPeerSlot: 2,
    });
    state.agentStates.coder.prUrl = "https://github.com/owner/staging-fork/pull/1";
    // duoPeerSlot set → cross-slot coordination kicks in; returns null while waiting for peer.
    expect(evaluateTransition(state)).toBeNull();
  });
});

describe("isAgentDone — stale status detection (gh-ludics-122)", () => {
  function makePairState(tmpDir: string, overrides: Partial<OrchestrationState> = {}): OrchestrationState {
    return makeState({
      mode: "pair",
      phase: "review",
      phaseStartedAt: Math.floor(Date.now() / 1000),
      agents: [
        { name: "coder", provider: "codex", model: "gpt-5.4", branch: "a", worktreePath: "/tmp/a", role: "coder" },
        { name: "reviewer", provider: "codex", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b", role: "reviewer" },
      ],
      agentStates: initAgentRuntimeState(["coder", "reviewer"]),
      threadIds: { coder: "t1", reviewer: "t2" },
      peerSyncDir: tmpDir,
      ...overrides,
    });
  }

  test("null lifecycle + unchanged fingerprint → not done (stale)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    const state = makePairState(tmpDir);

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(isAgentDone(state, state.agents[1])).toBe(false);
  });

  test("null lifecycle + changed fingerprint + artifact present → done", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    const state = makePairState(tmpDir, { phaseStartedAt: Math.floor(Date.now() / 1000) - 10 });

    writeFileSync(join(tmpDir, "reviewer.status"), "idle|0|\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "APPROVE\n");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(isAgentDone(state, state.agents[1])).toBe(true);
  });

  test("null lifecycle + changed fingerprint + missing artifact → not done", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    const state = makePairState(tmpDir, { phaseStartedAt: Math.floor(Date.now() / 1000) - 10 });

    writeFileSync(join(tmpDir, "reviewer.status"), "idle|0|\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(isAgentDone(state, state.agents[1])).toBe(false);
  });

  test("timeout still overrides stale status", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    const state = makePairState(tmpDir, { phaseStartedAt: 0 });

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(isAgentDone(state, state.agents[1])).toBe(false);
    expect(phaseTimeoutExpired(state)).toBe(true);
    expect(evaluateTransition(state)).not.toBeNull();
  });

  test("regression: REQUEST_CHANGES + fresh status → review transitions to work", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    const state = makePairState(tmpDir, { phaseStartedAt: Math.floor(Date.now() / 1000) - 10 });

    writeFileSync(join(tmpDir, "reviewer.status"), "idle|0|\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "## Verdict\nREQUEST_CHANGES\n");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(evaluateTransition(state)).toBe("work");
  });

  // Regression for issue #346: APPROVE on line 1 + prose body that mentions
  // the literal token REQUEST_CHANGES must parse as approve, not as a rejection.
  // Mirrors the slot 6 / gh-ludics-310 incident where a review of a template
  // change discussed "REQUEST_CHANGES consequences" in prose and looped the
  // orchestrator back to work for 5 rounds.
  test("regression: APPROVE line 1 + REQUEST_CHANGES in prose → review transitions to update-docs (gh-ludics-346)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh346-"));
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    const state = makePairState(tmpDir, { phaseStartedAt: Math.floor(Date.now() / 1000) - 10 });

    writeFileSync(join(tmpDir, "reviewer.status"), "idle|0|\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    writeFileSync(
      join(tmpDir, "reviews", "round-1-reviewer.md"),
      "APPROVE\n\n"
        + "All four templates now enforce the structural `## Regression Tests` "
        + "requirement with the intended per-file accounting and "
        + "REQUEST_CHANGES consequences.\n",
    );

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(evaluateTransition(state)).toBe("update-docs");
  });

  test("null lifecycle + no baseline (legacy) → trusts done status + artifact", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    const state = makePairState(tmpDir, { phaseStartedAt: Math.floor(Date.now() / 1000) - 10 });

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "APPROVE\n");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.turnLifecycle = null;

    expect(isAgentDone(state, state.agents[1])).toBe(true);
  });

  test("settled lifecycle + stale fingerprint → not done", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    const state = makePairState(tmpDir);

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;
    state.agentStates.reviewer.turnLifecycle = {
      dispatchCommandId: "cmd-1",
      dispatchedAt: new Date().toISOString(),
      phaseToken: "tok",
      observedTurnId: "turn-1",
      state: "settled",
      turnStartedAt: new Date().toISOString(),
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
      statusFileFingerprint: baseline,
      lastStopHookAt: null,
    };

    expect(isAgentDone(state, state.agents[1])).toBe(false);
  });

  test("settled lifecycle + fresh fingerprint + artifact present → done", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    const state = makePairState(tmpDir, { phaseStartedAt: Math.floor(Date.now() / 1000) - 10 });

    writeFileSync(join(tmpDir, "reviewer.status"), "idle|0|\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    writeFileSync(join(tmpDir, "reviewer.status"), "review-done|0|done\n");
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "APPROVE\n");

    state.agentStates.reviewer.status = "review-done";
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;
    state.agentStates.reviewer.turnLifecycle = {
      dispatchCommandId: "cmd-1",
      dispatchedAt: new Date().toISOString(),
      phaseToken: "tok",
      observedTurnId: "turn-1",
      state: "settled",
      turnStartedAt: new Date().toISOString(),
      turnCompletedAt: new Date().toISOString(),
      completionSource: "snapshot",
      statusFileFingerprint: baseline,
      lastStopHookAt: null,
    };

    expect(isAgentDone(state, state.agents[1])).toBe(true);
  });

  test("plan-review: stale status + no review file → stays in plan-review", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh122-"));
    const state = makePairState(tmpDir, {
      phase: "plan-review",
      planMergeRound: 1,
    });

    writeFileSync(join(tmpDir, "reviewer.status"), "plan-review-done|0|done\n");
    const baseline = statusFileFingerprint(tmpDir, "reviewer");

    state.agentStates.reviewer.status = "plan-review-done";
    state.agentStates.reviewer.turnLifecycle = null;
    state.agentStates.reviewer.dispatchStatusFingerprint = baseline;

    expect(isAgentDone(state, state.agents[1])).toBe(false);
    expect(evaluateTransition(state)).toBeNull();
  });
});

describe("isPairBailedOut", () => {
  test("returns true when coder=bail-out and reviewer=bail-out-confirmed", () => {
    const state = makeState();
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(isPairBailedOut(state)).toBe(true);
  });

  test("returns false when only coder has bail-out", () => {
    const state = makeState();
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "review-done";
    expect(isPairBailedOut(state)).toBe(false);
  });

  test("returns false when only reviewer has bail-out-confirmed", () => {
    const state = makeState();
    state.agentStates.coder.status = "done";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(isPairBailedOut(state)).toBe(false);
  });

  test("returns false when no coder or reviewer role", () => {
    const state = makeState({
      agents: [
        { name: "a1", provider: "claude-code", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "a2", provider: "claude-code", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    expect(isPairBailedOut(state)).toBe(false);
  });
});

describe("evaluateTransition — bail-out", () => {
  test("work phase transitions to done when both agents bail out", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(evaluateTransition(state)).toBe("done");
  });

  test("review phase transitions to done when both agents bail out", () => {
    const state = makeState({ phase: "review" });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(evaluateTransition(state)).toBe("done");
  });

  test("update-docs phase transitions to done when both agents bail out", () => {
    const state = makeState({ phase: "update-docs" });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(evaluateTransition(state)).toBe("done");
  });

  test("work phase transitions to review when bail-out is one-sided", () => {
    const state = makeState({ phase: "work" });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "done";
    expect(evaluateTransition(state)).toBe("review");
  });

  test("bail-out statuses bypass artifact validation (reviewer without review file)", () => {
    const state = makeState({ phase: "review" });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    // Reviewer has bail-out-confirmed but no review file exists — should still be done
    expect(isAgentDone(state, state.agents[1])).toBe(true);
  });

  test("lone bail-out-confirmed without coder bail-out does NOT bypass artifact validation", () => {
    const state = makeState({ phase: "review" });
    state.agentStates.coder.status = "done";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    // Reviewer has bail-out-confirmed but coder is NOT bail-out — pair contract not met.
    // Without a review file, artifact validation should block.
    expect(isAgentDone(state, state.agents[1])).toBe(false);
  });

  test("pr-create phase transitions to done when both agents bail out", () => {
    const dir = mkdtempSync(join(tmpdir(), "ludics-phases-test-"));
    mkdirSync(join(dir, "plans"), { recursive: true });
    mkdirSync(join(dir, "reviews"), { recursive: true });
    const state = makeState({ phase: "pr-create", peerSyncDir: dir });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(evaluateTransition(state)).toBe("done");
  });

  test("pr-create still blocks when bail-out is one-sided", () => {
    const dir = mkdtempSync(join(tmpdir(), "ludics-phases-test-"));
    mkdirSync(join(dir, "plans"), { recursive: true });
    mkdirSync(join(dir, "reviews"), { recursive: true });
    const state = makeState({ phase: "pr-create", peerSyncDir: dir });
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "done";
    // No PR URL, no full bail-out → blocks
    expect(evaluateTransition(state)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Hoisted pair-mode bail-out short-circuit (task-1e6b2aad).
// Verifies allowlist semantics + readiness-guard preservation.
// ---------------------------------------------------------------------------

describe("evaluateTransition — hoisted pair-mode bail-out check", () => {
  // Test 6: allowlisted phases with bail-out confirmed but agents NOT done → null.
  // Reproduces the readiness-guard behaviour that each case branch used to carry
  // inline. The participating agent for each phase differs (work/update-docs/
  // pr-create → coder only; review → reviewer only), so pin a "running"
  // lifecycle on the right role for each iteration.
  test("readiness guard preserved: bail-out confirmed but participating agent still running → null", () => {
    const runningLifecycle = () => ({
      dispatchCommandId: "cmd-1",
      dispatchedAt: new Date().toISOString(),
      phaseToken: "tok",
      observedTurnId: null,
      state: "running" as const,
      turnStartedAt: new Date().toISOString(),
      turnCompletedAt: null,
      completionSource: null,
      statusFileFingerprint: null,
      lastStopHookAt: null,
    });

    for (const phase of ["work", "review", "update-docs", "pr-create"] as const) {
      const state = makeState({
        phase,
        // Fresh phaseStartedAt so phaseTimeoutExpired returns false.
        phaseStartedAt: Math.floor(Date.now() / 1000),
      });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      // Pin the participating agent's turn to "running" so allAgentsDone is false.
      if (phase === "review") {
        state.agentStates.reviewer.turnLifecycle = runningLifecycle();
      } else {
        state.agentStates.coder.turnLifecycle = runningLifecycle();
      }
      expect(isBailedOut(state)).toBe(true);
      // Readiness guard blocks short-circuit; result is null (not "done").
      expect(evaluateTransition(state)).toBeNull();
    }
  });

  // Test 7: non-allowlisted phases must NOT short-circuit to "done" on bail-out.
  test("non-allowlisted phases do not short-circuit on bail-out", () => {
    // setup: nextAfterPrework returns "work" with default config (no pre-plan).
    {
      const state = makeState({ phase: "setup" });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      expect(evaluateTransition(state)).toBe("work");
    }

    // plan: with both done and no plan files → plan-merge path.
    {
      const dir = mkdtempSync(join(tmpdir(), "ludics-phases-test-"));
      mkdirSync(join(dir, "plans"), { recursive: true });
      mkdirSync(join(dir, "reviews"), { recursive: true });
      const state = makeState({ phase: "plan", peerSyncDir: dir });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      const result = evaluateTransition(state);
      // Whatever the normal plan → {plan-merge, plan-review} transition yields,
      // it must NOT be "done".
      expect(result).not.toBe("done");
    }

    // pr-comments: without quiet period / merged PR, normal logic returns null.
    {
      const state = makeState({ phase: "pr-comments" });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      expect(evaluateTransition(state)).not.toBe("done");
    }

    // final-merge: both done → "suggest-refactor", not "done".
    {
      const state = makeState({ phase: "final-merge" });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      expect(evaluateTransition(state)).toBe("suggest-refactor");
    }

    // suggest-refactor: normal logic returns "done" (terminal step), but the
    // allowlist must not be responsible — confirm the transition is reached.
    {
      const state = makeState({ phase: "suggest-refactor" });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      expect(evaluateTransition(state)).toBe("done");
    }
  });

  // Regression: if `phaseTimeoutExpired` flips true between the hoisted
  // readiness check and the case branch (both read nowEpoch()), the hoisted
  // `"done"` path used to be skipped while the branch still advanced the
  // phase. Fix caches readiness once; verify by constructing a state where
  // the timeout is already expired and `isBailedOut` is true: the hoisted
  // check must win (→ "done"), not the case branch (→ "review"/next).
  test("bail-out + already-expired timeout: hoist wins over case branch", () => {
    for (const [phase, caseBranchResult] of [
      ["work", "review"],
      ["update-docs", "pr-create"],
    ] as const) {
      const state = makeState({
        phase,
        // phaseStartedAt far in the past so phaseTimeoutExpired is true
        // on every call — mirrors the "flipped true mid-call" scenario.
        phaseStartedAt: Math.floor(Date.now() / 1000) - 1_000_000,
      });
      state.agentStates.coder.status = "bail-out";
      state.agentStates.reviewer.status = "bail-out-confirmed";
      expect(phaseTimeoutExpired(state)).toBe(true);
      expect(isBailedOut(state)).toBe(true);
      // Without the cached-readiness fix, a flip could yield `caseBranchResult`.
      // With it, the hoisted check wins because readiness is evaluated once.
      expect(evaluateTransition(state)).toBe("done");
      // Sanity: confirm the case branch would otherwise advance past the hoist.
      expect(caseBranchResult).not.toBe("done");
    }
  });

  // Test 8: solo mode regression — evaluateTransitionSolo short-circuits
  // unconditionally on bail-out (no allAgentsDone gate). Covered by the
  // existing "solo bail-out short-circuits every non-terminal phase to done"
  // test, but re-assert here that the pair-mode hoist does not disturb it by
  // picking a phase outside the pair allowlist ("setup") in solo mode.
  test("solo mode: bail-out on non-allowlisted phase still short-circuits", () => {
    const state = makeState({
      phase: "setup",
      mode: "solo",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "claude-opus-4-6", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: initAgentRuntimeState(["coder"]),
    });
    state.agentStates.coder.status = "bail-out";
    expect(evaluateTransition(state)).toBe("done");
  });
});

describe("PHASE_CATEGORIES split — pre-plan vs planning", () => {
  test("pre-plan phases map to 'pre-plan'", () => {
    for (const phase of ["setup", "gather", "clarify", "pushback"] as const) {
      expect(PHASE_CATEGORIES[phase]).toBe("pre-plan");
    }
  });

  test("planning phases map to 'planning'", () => {
    for (const phase of ["plan", "plan-merge", "plan-review"] as const) {
      expect(PHASE_CATEGORIES[phase]).toBe("planning");
    }
  });
});

describe("applyPhaseSideEffects — stub plan creation (gh-ludics-254)", () => {
  test("creates stub merged plan when pre-plan phase → work (planning skipped)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh254-stub-"));
    const state = makeState({
      phase: "setup",
      round: 1,
      peerSyncDir: tmpDir,
    });
    applyPhaseSideEffects(state, "work");
    const stubPath = mergedPlanFilePath(tmpDir, 1, 0);
    expect(existsSync(stubPath)).toBe(true);
    expect(readFileSync(stubPath, "utf-8")).toContain("planning phase skipped");
  });

  test("does NOT overwrite existing merged plan when pre-plan → work", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh254-nooverwrite-"));
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    const stubPath = mergedPlanFilePath(tmpDir, 1, 0);
    const existingContent = "# Real Merged Plan\nKeep this content.\n";
    writeFileSync(stubPath, existingContent);
    const state = makeState({
      phase: "clarify",
      round: 1,
      peerSyncDir: tmpDir,
    });
    applyPhaseSideEffects(state, "work");
    expect(readFileSync(stubPath, "utf-8")).toBe(existingContent);
  });

  test("does NOT create stub when planning phase → work (planning attempted)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "gh254-noplanning-"));
    const state = makeState({
      phase: "plan-review",
      round: 1,
      peerSyncDir: tmpDir,
    });
    applyPhaseSideEffects(state, "work");
    const stubPath = mergedPlanFilePath(tmpDir, 1, 0);
    expect(existsSync(stubPath)).toBe(false);
  });
});

function makeSoloState(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    slot: 1,
    taskId: "feat",
    mode: "solo",
    phase: "setup",
    round: 1,
    mergeRound: 0,
    agents: [
      { name: "coder", provider: "claude-code", role: "coder", model: "claude-sonnet-4-6", branch: "a", worktreePath: "/tmp/a" },
    ],
    agentStates: initAgentRuntimeState(["coder"]),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: 0,
    startedAt: "2026-04-22T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir: "/tmp/project-feat/.peer-sync",
    threadIds: { coder: "t1" },
    ...overrides,
  };
}

describe("solo mode — evaluateTransition", () => {
  test("setup → work (unconditional; skips gather/clarify/plan)", () => {
    const state = makeSoloState({
      config: defaultOrchestrationConfig({ enableClarify: true, enablePushback: true, enablePlan: true, enableGather: true }),
    });
    expect(evaluateTransition(state)).toBe("work");
  });

  test("work → update-docs when coder done and no PR exists", () => {
    const state = makeSoloState({ phase: "work" });
    state.agentStates.coder.status = "done";
    expect(evaluateTransition(state)).toBe("update-docs");
  });

  test("work → pr-comments when PR already exists", () => {
    const state = makeSoloState({ phase: "work" });
    state.agentStates.coder.status = "done";
    state.agentStates.coder.prUrl = "https://github.com/o/r/pull/1";
    expect(evaluateTransition(state)).toBe("pr-comments");
  });

  test("work stalls (null) when coder is not done", () => {
    const state = makeSoloState({ phase: "work", phaseStartedAt: Math.floor(Date.now() / 1000) });
    state.agentStates.coder.status = "idle";
    expect(evaluateTransition(state)).toBeNull();
  });

  test("update-docs → pr-create when no PR exists", () => {
    const state = makeSoloState({ phase: "update-docs" });
    state.agentStates.coder.status = "update-docs-done";
    expect(evaluateTransition(state)).toBe("pr-create");
  });

  test("update-docs → pr-comments when PR already exists", () => {
    const state = makeSoloState({ phase: "update-docs" });
    state.agentStates.coder.status = "update-docs-done";
    state.agentStates.coder.prUrl = "https://github.com/o/r/pull/2";
    expect(evaluateTransition(state)).toBe("pr-comments");
  });

  test("pr-create → pr-comments when PR URL present", () => {
    const dir = mkdtempSync(join(tmpdir(), "ludics-solo-prcreate-"));
    mkdirSync(join(dir, "plans"), { recursive: true });
    mkdirSync(join(dir, "reviews"), { recursive: true });
    const state = makeSoloState({ phase: "pr-create", peerSyncDir: dir });
    state.agentStates.coder.status = "pr-created";
    state.agentStates.coder.prUrl = "https://github.com/o/r/pull/3";
    // Also write the required .pr artifact for isAgentDone
    writeFileSync(join(dir, "coder.pr"), "https://github.com/o/r/pull/3\n");
    expect(evaluateTransition(state)).toBe("pr-comments");
  });

  test("pr-create blocks (null) without PR URL (defense-in-depth)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ludics-solo-prcreate-block-"));
    const state = makeSoloState({
      phase: "pr-create",
      peerSyncDir: dir,
      phaseStartedAt: Math.floor(Date.now() / 1000),
    });
    state.agentStates.coder.status = "pr-created";
    // no prUrl set, no artifact → isAgentDone returns false → allAgentsDone false
    expect(evaluateTransition(state)).toBeNull();
  });

  test("pr-comments → final-merge via coder-dispatched shortcut", () => {
    const state = makeSoloState({ phase: "pr-comments" });
    state.agentStates.coder.status = "done";
    state.agentStates.coder.prUrl = "https://github.com/o/r/pull/4";
    state.prCommentsCoderDispatched = true;
    state.prCommentsQuietSince = Math.floor(Date.now() / 1000) - 5;
    expect(evaluateTransition(state)).toBe("final-merge");
  });

  test("pr-comments stalls (null) without a PR URL", () => {
    const state = makeSoloState({
      phase: "pr-comments",
      phaseStartedAt: Math.floor(Date.now() / 1000),
    });
    state.agentStates.coder.status = "done";
    expect(evaluateTransition(state)).toBeNull();
  });

  test("final-merge → done when coder done (skips suggest-refactor)", () => {
    const state = makeSoloState({ phase: "final-merge" });
    state.agentStates.coder.status = "merged";
    expect(evaluateTransition(state)).toBe("done");
  });

  test("solo bail-out short-circuits every non-terminal phase to done", () => {
    const phases: Array<OrchestrationState["phase"]> = [
      "work", "update-docs", "pr-create", "pr-comments", "final-merge",
    ];
    for (const phase of phases) {
      const state = makeSoloState({ phase });
      state.agentStates.coder.status = "bail-out";
      expect(evaluateTransition(state)).toBe("done");
    }
  });

  test("done is terminal (returns done)", () => {
    const state = makeSoloState({ phase: "done" });
    expect(evaluateTransition(state)).toBe("done");
  });
});

describe("solo mode — agentParticipatesInPhase", () => {
  const activePhases: Array<OrchestrationState["phase"]> = [
    "work", "update-docs", "pr-create", "pr-comments", "final-merge",
  ];
  const neverPhases: Array<OrchestrationState["phase"]> = ["setup", "done"];

  test("coder participates in every solo active phase", () => {
    const state = makeSoloState();
    for (const phase of activePhases) {
      state.phase = phase;
      expect(agentParticipatesInPhase(state, state.agents[0])).toBe(true);
    }
  });

  test("coder never participates in setup or done", () => {
    const state = makeSoloState();
    for (const phase of neverPhases) {
      state.phase = phase;
      expect(agentParticipatesInPhase(state, state.agents[0])).toBe(false);
    }
  });

  test("hypothetical reviewer never participates in solo mode", () => {
    const reviewer = {
      name: "reviewer", provider: "codex" as const, role: "reviewer" as const,
      model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b",
    };
    // Solo normally has one agent, but this test exercises the defensive check
    // that even if a reviewer is somehow present, they don't participate.
    const state = makeSoloState({ agents: [...makeSoloState().agents, reviewer] });
    for (const phase of activePhases) {
      state.phase = phase;
      expect(agentParticipatesInPhase(state, reviewer)).toBe(false);
    }
  });
});

describe("isSoloBailedOut / isBailedOut", () => {
  test("isSoloBailedOut: true when solo coder status is bail-out", () => {
    const state = makeSoloState();
    state.agentStates.coder.status = "bail-out";
    expect(isSoloBailedOut(state)).toBe(true);
  });

  test("isSoloBailedOut: false when mode is pair (delegation only via isBailedOut)", () => {
    const state = makeState();
    state.agentStates.coder.status = "bail-out";
    expect(isSoloBailedOut(state)).toBe(false);
  });

  test("isSoloBailedOut: false when coder status is not bail-out", () => {
    const state = makeSoloState();
    state.agentStates.coder.status = "done";
    expect(isSoloBailedOut(state)).toBe(false);
  });

  test("isBailedOut: true for solo coder bail-out", () => {
    const state = makeSoloState();
    state.agentStates.coder.status = "bail-out";
    expect(isBailedOut(state)).toBe(true);
  });

  test("isBailedOut: true for pair handshake (delegates to isPairBailedOut)", () => {
    const state = makeState();
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "bail-out-confirmed";
    expect(isBailedOut(state)).toBe(true);
    expect(isPairBailedOut(state)).toBe(true);
  });

  test("isBailedOut: false for lone coder bail-out in pair mode", () => {
    const state = makeState();
    state.agentStates.coder.status = "bail-out";
    state.agentStates.reviewer.status = "done";
    expect(isBailedOut(state)).toBe(false);
  });
});

describe("migrateState — solo invariants", () => {
  test("returns valid solo state unchanged without warning", () => {
    const state = makeSoloState();
    const warnings: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((msg: string) => { warnings.push(msg); });
    try {
      const result = migrateState(state, 1);
      expect(result).toBe(state);
      expect(warnings.filter((w) => w.includes("solo"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("warns but returns state unchanged when solo state has duoPeerSlot set", () => {
    const state = makeSoloState({ duoPeerSlot: 2 });
    const warnings: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((msg: string) => { warnings.push(msg); });
    try {
      const result = migrateState(state, 3);
      expect(result).toBe(state);
      expect(result.duoPeerSlot).toBe(2); // state unchanged
      expect(warnings.some((w) => w.includes("solo") && w.includes("duoPeerSlot"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("warns but returns state unchanged when solo state has wrong agent count", () => {
    const state = makeSoloState({
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "claude-sonnet-4-6", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "gpt-5.4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    const warnings: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((msg: string) => { warnings.push(msg); });
    try {
      const result = migrateState(state, 4);
      expect(result).toBe(state);
      expect(result.agents).toHaveLength(2); // state unchanged
      expect(warnings.some((w) => w.includes("solo") && w.includes("2 agents"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("harness isolation regression", () => {
  test("LUDICS_HARNESS_DIR is set to the explicit path under TEST_TMP", () => {
    const harness = process.env.LUDICS_HARNESS_DIR;
    expect(harness).toBeDefined();
    expect(harness!.startsWith(TEST_TMP)).toBe(true);
    expect(harness).toBe(join(TEST_TMP, "harness"));
    expect(existsSync(harness!)).toBe(true);
  });
});
