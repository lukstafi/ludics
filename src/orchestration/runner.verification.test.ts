import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isAgentDone, evaluateTransition } from "./phases.ts";
import { verifyPhaseOutcome, PR_CREATE_GATE, FINAL_MERGE_GATE, handleVerifyFailure, getFirstPrUrl, MAX_VERIFY_ATTEMPTS, checkZeroCommitsAutoBailOut, isWorktreeNoOp, triggerCoderBailOut, validatePreviousPhaseArtifacts, validateAgentPrFiles, type PreviousPhaseContext } from "./runner.ts";
import * as notify from "../notify.ts";
import * as events from "../events.ts";
import * as github from "./github.ts";
import * as spawn from "../spawn.ts";
import * as config from "../config.ts";
import { appendToSection } from "../tasks/markdown.ts";
import * as stateMod from "./state.ts";
import { type OrchestrationState } from "./state.ts";
import {
  makeTmpDir,
  makeGitRepo,
  makeLifecycle,
  makeState,
  markAgentDone,
} from "./runner.test-helpers.ts";

setDefaultTimeout(20_000);

describe("phase-specific artifact validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("plan phase: missing plan file → not done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    markAgentDone(state, "coder", { skipArtifact: true });
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("plan phase: plan file exists → done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("plan-review phase: requires review file (not plan file)", () => {
    // planMergeRound defaults to 0, so the required file is plan-merge-0-reviewer.md
    const state = makeState({ phase: "plan-review", planMergeRound: 0 }, tmpDir);
    const reviewer = state.agents[1]!;

    // Set up lifecycle+status but skip artifact — plan file exists but review doesn't.
    markAgentDone(state, "reviewer", { skipArtifact: true });
    writeFileSync(join(tmpDir, "plans", "round-1-reviewer.md"), "# Plan\n");
    expect(isAgentDone(state, reviewer)).toBe(false);

    // Now create the per-iteration review file — should be done.
    writeFileSync(join(tmpDir, "reviews", "plan-merge-0-reviewer.md"), "APPROVE\n");
    expect(isAgentDone(state, reviewer)).toBe(true);
  });

  test("review phase: missing review file → not done", () => {
    const state = makeState({ phase: "review" }, tmpDir);
    const reviewer = state.agents[1]!;
    markAgentDone(state, "reviewer", { skipArtifact: true });
    expect(isAgentDone(state, reviewer)).toBe(false);
  });

  test("review phase: review file exists → done", () => {
    const state = makeState({ phase: "review" }, tmpDir);
    const reviewer = state.agents[1]!;
    markAgentDone(state, "reviewer");
    expect(isAgentDone(state, reviewer)).toBe(true);
  });

  test("pr-create phase: missing .pr file → not done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    markAgentDone(state, "coder", { skipArtifact: true });
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("pr-create phase: .pr file with valid URL → done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("pr-create phase: .pr file with malformed body (not a URL) → not done", () => {
    const state = makeState({ phase: "pr-create" }, tmpDir);
    markAgentDone(state, "coder", { artifactContent: "# My PR\n\nThis is a PR body, not a URL.\n" });
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });

  test("work phase: no artifact required → done with just done status", () => {
    const state = makeState({ phase: "work" }, tmpDir);
    markAgentDone(state, "coder");
    expect(isAgentDone(state, state.agents[0]!)).toBe(true);
  });

  test("grace-period done with missing artifact → not done", () => {
    const state = makeState({ phase: "plan" }, tmpDir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "settled",
      observedTurnId: "turn-plan",
      turnCompletedAt: new Date(Date.now() - 120_000).toISOString(),
      completionSource: "snapshot",
      statusFileFingerprint: "same",
    });
    writeFileSync(join(tmpDir, "coder.status"), "plan-active|0|working\n");
    state.agentStates.coder.status = "plan-active";
    expect(isAgentDone(state, state.agents[0]!)).toBe(false);
  });
});

// ===========================================================================
// Agent marker file read/write
// ===========================================================================

describe("handleVerifyFailure", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("increments attempt counter and returns redispatch on first failure", () => {
    const state = makeState({ phase: "pr-create", prCreateVerifyAttempts: 0 });
    const result = handleVerifyFailure(state, "prCreate", "No PR");
    expect(result).toBe("redispatch");
    expect(state.prCreateVerifyAttempts).toBe(1);
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].event_type).toBe("pr_missing");
  });

  test("emits finalMerge event type for finalMerge gate", () => {
    const state = makeState({ phase: "final-merge", finalMergeVerifyAttempts: 0 });
    const result = handleVerifyFailure(state, "finalMerge", "not merged");
    expect(result).toBe("redispatch");
    expect(state.finalMergeVerifyAttempts).toBe(1);
    expect(eventSpy.mock.calls[0][0].event_type).toBe("merge_failed");
  });

  test("emits manual_intervention_required and notifies at MAX_VERIFY_ATTEMPTS boundary", () => {
    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1,
    });
    const result = handleVerifyFailure(state, "prCreate", "still missing");
    expect(result).toBe("hold");
    expect(state.prCreateVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
    // Two events: the failure event + the manual_intervention_required event
    expect(eventSpy).toHaveBeenCalledTimes(2);
    expect(eventSpy.mock.calls[1][0].event_type).toBe("manual_intervention_required");
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  test("returns hold silently when already at max retries (event spam guard)", () => {
    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS,
    });
    const result = handleVerifyFailure(state, "prCreate", "still missing");
    expect(result).toBe("hold");
    // No events or notifications should be emitted
    expect(eventSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    // Counter should NOT increase further
    expect(state.prCreateVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
  });

  test("returns hold silently when above max retries", () => {
    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS + 5,
    });
    const result = handleVerifyFailure(state, "prCreate", "still missing");
    expect(result).toBe("hold");
    expect(eventSpy).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleVerifyFailure — has_questions surfacing
// ---------------------------------------------------------------------------

describe("handleVerifyFailure — has_questions", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let harnessSpy: ReturnType<typeof spyOn>;
  let tmpHarness: string;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    tmpHarness = makeTmpDir();
    mkdirSync(join(tmpHarness, "tasks"), { recursive: true });
    harnessSpy = spyOn(config, "harnessDir").mockReturnValue(tmpHarness);
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
    harnessSpy.mockRestore();
  });

  test("sets has_questions and appends to Questions section on max attempts", () => {
    const taskFile = join(tmpHarness, "tasks", "feat.md");
    writeFileSync(taskFile, "---\ntitle: test\nstatus: in-progress\n---\n\n## Questions\n\nNone.\n");

    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1,
    });
    handleVerifyFailure(state, "prCreate", "still missing");

    const content = readFileSync(taskFile, "utf-8");
    expect(content).toContain("has_questions: true");
    expect(content).toContain("Manual intervention required (slot 1)");
    expect(content).not.toContain("None.");
  });

  test("does not duplicate question on repeated calls", () => {
    const taskFile = join(tmpHarness, "tasks", "feat.md");
    writeFileSync(taskFile, "---\ntitle: test\nstatus: in-progress\n---\n\n## Questions\n\nNone.\n");

    const state = makeState({
      phase: "pr-create",
      prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1,
    });
    handleVerifyFailure(state, "prCreate", "still missing");

    // Second call (already at max — returns hold silently, but test idempotency of appendToSection)
    appendToSection(taskFile, "Questions",
      `- **Manual intervention required (slot 1)**: pr-create failed after ${MAX_VERIFY_ATTEMPTS} attempts`);

    const content = readFileSync(taskFile, "utf-8");
    const count = content.split("Manual intervention required").length - 1;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkZeroCommitsAutoBailOut
// ---------------------------------------------------------------------------

describe("checkZeroCommitsAutoBailOut", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let persistSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    persistSpy = spyOn(stateMod, "persistState").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test("returns false when phase is not pr-create", () => {
    const state = makeState({ phase: "work" });
    expect(checkZeroCommitsAutoBailOut(state)).toBe(false);
    expect(state.phase).toBe("work");
  });

  test("auto-bails when coder worktree has 0 commits ahead", () => {
    const repoDir = makeGitRepo();

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "pr-create",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(true);
    expect(state.phase).toBe("done");
    expect(state.agentStates.coder!.status).toBe("bail-out");
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy.mock.calls[0][0].event_type).toBe("bail_out");
  });

  test("does not bail when coder worktree has commits ahead", () => {
    const repoDir = makeGitRepo();
    // Add another commit (1 ahead)
    writeFileSync(join(repoDir, "file2.txt"), "world");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "extra"], { cwd: repoDir });

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "pr-create",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(false);
    expect(state.phase).toBe("pr-create");
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("fast-paths to done when isPairBailedOut already true", () => {
    const state = makeState({ phase: "pr-create" });
    state.agentStates.coder!.status = "bail-out";
    state.agentStates.reviewer!.status = "bail-out-confirmed";
    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(true);
    expect(state.phase).toBe("done");
    // No event emitted — fast path doesn't re-emit
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("fast-paths to done for solo bail-out (single coder, no reviewer)", () => {
    // Solo mode: lone coder "bail-out" must trigger the same fast-path to done
    // that pair's coder+reviewer handshake triggers. Regression for task-da8b6dff.
    const state = makeState({
      phase: "pr-create",
      mode: "solo",
      duoPeerSlot: null,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "claude-sonnet-4-6", branch: "a", worktreePath: "/tmp/a" },
      ],
    });
    state.agentStates = { coder: { ...state.agentStates.coder!, status: "bail-out" } };
    const result = checkZeroCommitsAutoBailOut(state);
    expect(result).toBe(true);
    expect(state.phase).toBe("done");
    // No event emitted — fast path doesn't re-emit
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("idempotent: event emitted only once on repeated calls", () => {
    const repoDir = makeGitRepo();

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "pr-create",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    checkZeroCommitsAutoBailOut(state);
    expect(eventSpy).toHaveBeenCalledTimes(1);

    // Reset phase to pr-create for second call
    state.phase = "pr-create" as any;
    eventSpy.mockClear();
    checkZeroCommitsAutoBailOut(state);
    // Coder already has bail-out status — no new event
    expect(eventSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isWorktreeNoOp
// ---------------------------------------------------------------------------

describe("isWorktreeNoOp", () => {
  test("returns true when zero commits ahead and clean worktree", () => {
    const repoDir = makeGitRepo();
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(true);
  });

  test("returns false when commits ahead", () => {
    const repoDir = makeGitRepo();
    writeFileSync(join(repoDir, "file2.txt"), "world");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "extra"], { cwd: repoDir });
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(false);
  });

  test("returns false with uncommitted diffs but zero commits", () => {
    const repoDir = makeGitRepo();
    writeFileSync(join(repoDir, "dirty.txt"), "uncommitted");
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(false);
  });

  test("returns false with staged-but-uncommitted changes", () => {
    const repoDir = makeGitRepo();
    writeFileSync(join(repoDir, "staged.txt"), "staged");
    Bun.spawnSync(["git", "add", "staged.txt"], { cwd: repoDir });
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(false);
  });

  test("returns true when origin/HEAD missing but origin/main exists", () => {
    const repoDir = makeGitRepo();
    // Verify origin/HEAD is NOT set (makeGitRepo only sets origin/main)
    const headCheck = Bun.spawnSync(
      ["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { cwd: repoDir },
    );
    expect(headCheck.exitCode).not.toBe(0); // origin/HEAD should not exist
    expect(isWorktreeNoOp(repoDir, repoDir)).toBe(true);
  });

  test("returns false on git error (nonexistent path)", () => {
    expect(isWorktreeNoOp("/nonexistent/path", "/nonexistent/path")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Early work-phase no-op detection regression (AC2 flow)
// ---------------------------------------------------------------------------

describe("early work-phase no-op detection", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let persistSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    persistSpy = spyOn(stateMod, "persistState").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test("work-phase no-op detection sets coder to bail-out", () => {
    const repoDir = makeGitRepo();
    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    // Simulate the early detection logic from runOrchestration
    const coder = state.agents.find(a => a.role === "coder")!;
    if (isWorktreeNoOp(coder.worktreePath, state.projectDir)) {
      const runtime = state.agentStates[coder.name]!;
      runtime.status = "bail-out";
      runtime.statusMessage = "no-op: zero commits ahead of base, no uncommitted diffs";
    }

    expect(state.agentStates.coder!.status).toBe("bail-out");
  });

  test("work-phase bail-out transitions to review, not directly to done", () => {
    const repoDir = makeGitRepo();
    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);
    state.agentStates.coder!.status = "bail-out";

    // evaluateTransition for work: isPairBailedOut = false → review
    expect(evaluateTransition(state)).toBe("review");
  });

  test("review-phase bail-out-confirmed transitions to done", () => {
    const state = makeState({ phase: "review" });
    state.agentStates.coder!.status = "bail-out";
    state.agentStates.reviewer!.status = "bail-out-confirmed";

    expect(evaluateTransition(state)).toBe("done");
  });

  test("early detection path never touches verification retry budget", () => {
    const repoDir = makeGitRepo();
    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    // Simulate full AC2 flow: early detection → review → done
    state.agentStates.coder!.status = "bail-out";
    expect(evaluateTransition(state)).toBe("review"); // work → review

    state.phase = "review";
    state.agentStates.reviewer!.status = "bail-out-confirmed";
    expect(evaluateTransition(state)).toBe("done"); // review → done

    // Verification retry budget was never consumed
    expect(state.prCreateVerifyAttempts).toBeUndefined();
  });

  test("work-phase no-op detection does NOT fire when coder has commits", () => {
    const repoDir = makeGitRepo();
    // Add a commit to put the worktree ahead
    writeFileSync(join(repoDir, "feature.txt"), "new feature");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", "feature"], { cwd: repoDir });

    const peerDir = makeTmpDir();
    mkdirSync(join(peerDir, "plans"), { recursive: true });
    mkdirSync(join(peerDir, "reviews"), { recursive: true });
    const state = makeState({
      phase: "work",
      projectDir: repoDir,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: repoDir },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    }, peerDir);

    const coder = state.agents.find(a => a.role === "coder")!;
    // isWorktreeNoOp should return false — no bail-out
    expect(isWorktreeNoOp(coder.worktreePath, state.projectDir)).toBe(false);
    expect(state.agentStates.coder!.status).not.toBe("bail-out");
  });
});

// ---------------------------------------------------------------------------
// triggerCoderBailOut
// ---------------------------------------------------------------------------

describe("triggerCoderBailOut", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let persistSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    persistSpy = spyOn(stateMod, "persistState").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
    persistSpy.mockRestore();
  });

  test("first call: mutates runtime, writes .status file, emits bail_out event, persists", () => {
    const peerDir = makeTmpDir();
    const state = makeState({ phase: "work" }, peerDir);
    const coder = state.agents.find(a => a.role === "coder")!;

    triggerCoderBailOut(
      state, coder,
      "work-phase no-op detection",
      "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol",
    );

    const runtime = state.agentStates.coder!;
    expect(runtime.status).toBe("bail-out");
    expect(runtime.statusMessage).toBe("no-op: zero commits ahead of base, no uncommitted diffs");
    expect(typeof runtime.statusEpoch).toBe("number");

    const statusContents = readFileSync(join(peerDir, "coder.status"), "utf-8");
    expect(statusContents).toBe(
      `bail-out|${runtime.statusEpoch}|no-op: zero commits ahead of base, no uncommitted diffs\n`,
    );

    expect(eventSpy).toHaveBeenCalledTimes(1);
    const event = eventSpy.mock.calls[0][0];
    expect(event.event_type).toBe("bail_out");
    expect(event.source).toBe("orchestration");
    expect(event.scope).toBe("slot");
    expect(event.slot).toBe(state.slot);
    expect(event.task).toBe(state.taskId);
    expect(event.action).toBe("work-phase no-op detection");
    expect(event.status).toBe("bail-out");
    expect(event.message).toBe(
      "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol",
    );

    expect(persistSpy).toHaveBeenCalled();
  });

  test("second call with status already bail-out: no event emitted, no new .status write", () => {
    const peerDir = makeTmpDir();
    const state = makeState({ phase: "work" }, peerDir);
    const coder = state.agents.find(a => a.role === "coder")!;

    triggerCoderBailOut(state, coder, "action-a", "message-a");
    expect(eventSpy).toHaveBeenCalledTimes(1);

    const firstContents = readFileSync(join(peerDir, "coder.status"), "utf-8");
    const firstEpoch = state.agentStates.coder!.statusEpoch;

    eventSpy.mockClear();
    // Second call — runtime.status is already "bail-out"
    triggerCoderBailOut(state, coder, "action-b", "message-b");

    expect(eventSpy).not.toHaveBeenCalled();
    // .status file byte-identical (same epoch, same message)
    expect(readFileSync(join(peerDir, "coder.status"), "utf-8")).toBe(firstContents);
    expect(state.agentStates.coder!.statusEpoch).toBe(firstEpoch);
  });

  test("passes through custom (action, message) and eventStatus", () => {
    const peerDir = makeTmpDir();
    const state = makeState({ phase: "pr-create" }, peerDir);
    const coder = state.agents.find(a => a.role === "coder")!;

    triggerCoderBailOut(
      state, coder,
      "pr-create auto-bail-out",
      "0 commits ahead of base branch — no PR possible, skipping to done",
      undefined, // statusMessage default
      "skipped",
    );

    expect(eventSpy).toHaveBeenCalledTimes(1);
    const event = eventSpy.mock.calls[0][0];
    expect(event.action).toBe("pr-create auto-bail-out");
    expect(event.message).toBe("0 commits ahead of base branch — no PR possible, skipping to done");
    expect(event.status).toBe("skipped");
  });

  test("byte-identical .status + event payload for both call sites", () => {
    // Emulate the pre-refactor behaviour at each call site and verify the
    // helper produces identical outputs. Covers both migration snapshots.

    // Site 1: early work-phase detection.
    const peerDir1 = makeTmpDir();
    const state1 = makeState({ phase: "work" }, peerDir1);
    const coder1 = state1.agents.find(a => a.role === "coder")!;
    triggerCoderBailOut(
      state1, coder1,
      "work-phase no-op detection",
      "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol",
    );
    const status1 = readFileSync(join(peerDir1, "coder.status"), "utf-8");
    const event1 = eventSpy.mock.calls[0][0];

    expect(status1).toBe(
      `bail-out|${state1.agentStates.coder!.statusEpoch}|no-op: zero commits ahead of base, no uncommitted diffs\n`,
    );
    expect(event1).toMatchObject({
      event_type: "bail_out",
      source: "orchestration",
      scope: "slot",
      slot: state1.slot,
      task: state1.taskId,
      action: "work-phase no-op detection",
      status: "bail-out",
      message: "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol",
    });

    // Site 2: checkZeroCommitsAutoBailOut body.
    eventSpy.mockClear();
    const peerDir2 = makeTmpDir();
    const state2 = makeState({ phase: "pr-create" }, peerDir2);
    const coder2 = state2.agents.find(a => a.role === "coder")!;
    triggerCoderBailOut(
      state2, coder2,
      "pr-create auto-bail-out",
      "0 commits ahead of base branch — no PR possible, skipping to done",
      undefined,
      "skipped",
    );
    const status2 = readFileSync(join(peerDir2, "coder.status"), "utf-8");
    const event2 = eventSpy.mock.calls[0][0];

    expect(status2).toBe(
      `bail-out|${state2.agentStates.coder!.statusEpoch}|no-op: zero commits ahead of base, no uncommitted diffs\n`,
    );
    expect(event2).toMatchObject({
      event_type: "bail_out",
      source: "orchestration",
      scope: "slot",
      slot: state2.slot,
      task: state2.taskId,
      action: "pr-create auto-bail-out",
      status: "skipped",
      message: "0 commits ahead of base branch — no PR possible, skipping to done",
    });
  });

  test("on-disk epoch matches runtime.statusEpoch even when Date.now() crosses a second boundary mid-call (gh-ludics-416)", () => {
    // Codex review on PR #416 (task-29bea074): after the writeStatusFile
    // migration, the helper stamps its own epoch from Date.now(). If the
    // wall clock crosses a second boundary between the caller's nowEpoch()
    // (recorded into runtime.statusEpoch) and the helper's Date.now()
    // inside writeStatusFile, the on-disk timestamp would diverge from
    // runtime.statusEpoch — silently breaking byte-identity asserted by
    // the tests above. The fix passes runtime.statusEpoch through to
    // writeStatusFile's optional epoch parameter; this test pins it.
    const peerDir = makeTmpDir();
    const state = makeState({ phase: "work" }, peerDir);
    const coder = state.agents.find(a => a.role === "coder")!;

    let dateNowCalls = 0;
    const baseTimeMs = 1_700_000_000_000; // arbitrary fixed wall-clock anchor
    const dateNowSpy = spyOn(Date, "now").mockImplementation(() => {
      // First call → caller's nowEpoch(); subsequent calls → simulate
      // crossing the next-second boundary inside writeStatusFile.
      dateNowCalls += 1;
      return dateNowCalls === 1 ? baseTimeMs : baseTimeMs + 1500;
    });

    let runtimeEpoch: number;
    let onDiskEpoch: string;
    try {
      triggerCoderBailOut(
        state, coder,
        "work-phase no-op detection",
        "Coder worktree has 0 commits ahead and no uncommitted diffs — triggering bail-out protocol",
      );
      runtimeEpoch = state.agentStates.coder!.statusEpoch;
      const statusContents = readFileSync(join(peerDir, "coder.status"), "utf-8");
      onDiskEpoch = statusContents.split("|")[1]!;
    } finally {
      dateNowSpy.mockRestore();
    }

    // Pre-fix: runtimeEpoch = floor(baseTimeMs/1000), on-disk = that+1 →
    // expect(onDiskEpoch).toBe(String(runtimeEpoch)) would fail.
    expect(onDiskEpoch).toBe(String(runtimeEpoch));
    expect(runtimeEpoch).toBe(Math.floor(baseTimeMs / 1000));
  });
});

// ---------------------------------------------------------------------------
// preparePhaseRedispatch
// ---------------------------------------------------------------------------

describe("getFirstPrUrl", () => {
  test("returns prUrl from agentStates when available", () => {
    const state = makeState();
    state.agentStates.coder!.prUrl = "https://github.com/org/repo/pull/42";
    expect(getFirstPrUrl(state)).toBe("https://github.com/org/repo/pull/42");
  });

  test("falls back to peer-sync .pr file", () => {
    const dir = makeTmpDir();
    const state = makeState({}, dir);
    // No prUrl in agentStates — write a .pr file instead
    writeFileSync(join(dir, "coder.pr"), "https://github.com/org/repo/pull/99\n");
    // Mock isPrUrl to return true for our URL
    const isPrUrlSpy = spyOn(github, "isPrUrl").mockReturnValue(true);
    expect(getFirstPrUrl(state)).toBe("https://github.com/org/repo/pull/99");
    isPrUrlSpy.mockRestore();
  });

  test("returns null when no PR URL exists anywhere", () => {
    const state = makeState();
    expect(getFirstPrUrl(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyPhaseOutcome — PR_CREATE_GATE
// ---------------------------------------------------------------------------

describe("verifyPhaseOutcome (PR_CREATE_GATE)", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let verificationSpy: ReturnType<typeof spyOn>;
  let isPrUrlSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    verificationSpy = spyOn(github, "getPrVerification");
    isPrUrlSpy = spyOn(github, "isPrUrl").mockReturnValue(true);
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
    verificationSpy.mockRestore();
    isPrUrlSpy.mockRestore();
  });

  test("returns skip when phase is not pr-create", () => {
    const state = makeState({ phase: "work" });
    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("skip");
  });

  test("returns skip when agents are not done", () => {
    const state = makeState({ phase: "pr-create" });
    // Agents default to idle/not-done, so this should skip
    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("skip");
  });

  function makePrCreateDoneState(overrides: Partial<OrchestrationState> = {}) {
    const dir = makeTmpDir();
    const prUrl = "https://github.com/org/repo/pull/1";
    // Write the .pr artifact so hasRequiredArtifact passes
    writeFileSync(join(dir, "coder.pr"), prUrl);
    const state = makeState({ phase: "pr-create", ...overrides }, dir);
    state.agentStates.coder!.status = "done";
    state.agentStates.coder!.prUrl = prUrl;
    state.agentStates.coder!.turnLifecycle = makeLifecycle({ state: "settled" });
    // Reviewer doesn't participate in pr-create — not checked by allAgentsDone
    return state;
  }

  test("returns advance when PR is verified", () => {
    const state = makePrCreateDoneState();
    verificationSpy.mockReturnValue({ exists: true, state: "open" });

    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("advance");
    expect(eventSpy.mock.calls.some((c: any[]) => c[0].event_type === "pr_verified")).toBe(true);
  });

  test("returns redispatch on first verification failure", () => {
    const state = makePrCreateDoneState({ prCreateVerifyAttempts: 0 });
    verificationSpy.mockReturnValue({ exists: false, reason: "not found" });

    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("redispatch");
    expect(state.prCreateVerifyAttempts).toBe(1);
  });

  test("returns hold at max retries", () => {
    const state = makePrCreateDoneState({ prCreateVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1 });
    verificationSpy.mockReturnValue({ exists: false, reason: "not found" });

    expect(verifyPhaseOutcome(state, PR_CREATE_GATE)).toBe("hold");
    expect(state.prCreateVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
  });
});

// ---------------------------------------------------------------------------
// verifyPhaseOutcome — FINAL_MERGE_GATE
// ---------------------------------------------------------------------------

describe("verifyPhaseOutcome (FINAL_MERGE_GATE)", () => {
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let verificationSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    verificationSpy = spyOn(github, "getPrVerification");
  });

  afterEach(() => {
    eventSpy.mockRestore();
    notifySpy.mockRestore();
    verificationSpy.mockRestore();
  });

  test("returns skip when phase is not final-merge", () => {
    const state = makeState({ phase: "work" });
    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("skip");
  });

  test("returns skip when agents are not done", () => {
    const state = makeState({ phase: "final-merge" });
    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("skip");
  });

  function makeFinalMergeDoneState(overrides: Partial<OrchestrationState> = {}) {
    const state = makeState({ phase: "final-merge", ...overrides });
    state.agentStates.coder!.status = "done";
    state.agentStates.coder!.prUrl = "https://github.com/org/repo/pull/1";
    state.agentStates.coder!.turnLifecycle = makeLifecycle({ state: "settled" });
    // Reviewer doesn't participate in final-merge
    return state;
  }

  test("returns advance when PR is merged", () => {
    const state = makeFinalMergeDoneState();
    verificationSpy.mockReturnValue({ exists: true, merged: true, state: "closed" });

    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("advance");
    expect(eventSpy.mock.calls.some((c: any[]) => c[0].event_type === "merge_verified")).toBe(true);
  });

  test("returns redispatch when PR exists but is not merged", () => {
    const state = makeFinalMergeDoneState({ finalMergeVerifyAttempts: 0 });
    verificationSpy.mockReturnValue({ exists: true, merged: false, state: "open", mergeableState: "dirty" });

    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("redispatch");
    expect(state.finalMergeVerifyAttempts).toBe(1);
    // Check the failure reason includes mergeableState detail
    expect(eventSpy.mock.calls[0][0].message).toContain("mergeable_state: dirty");
  });

  test("returns hold at max retries for final-merge", () => {
    const state = makeFinalMergeDoneState({ finalMergeVerifyAttempts: MAX_VERIFY_ATTEMPTS - 1 });
    verificationSpy.mockReturnValue({ exists: false, reason: "404" });

    expect(verifyPhaseOutcome(state, FINAL_MERGE_GATE)).toBe("hold");
    expect(state.finalMergeVerifyAttempts).toBe(MAX_VERIFY_ATTEMPTS);
  });
});

// ===========================================================================
// skipToPhase — lifecycle cleanup
// ===========================================================================

describe("validatePreviousPhaseArtifacts", () => {
  let emitSpy: ReturnType<typeof spyOn>;
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("warns on missing review file", () => {
    const state = makeState({ phase: "work", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(1);
    expect((warnings[0][0] as { message: string }).message).toContain("Missing artifact from review");
    expect((warnings[0][0] as { message: string }).message).toContain("reviewer");
  });

  test("no warning when review file exists", () => {
    const state = makeState({ phase: "work", round: 1 }, dir);
    // Write the expected review file: reviews/round-1-reviewer.md
    writeFileSync(join(dir, "reviews", "round-1-reviewer.md"), "APPROVE\n");
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(0);
  });

  test("no warning for phase without required artifact (work)", () => {
    const state = makeState({ phase: "review", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "work", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(0);
  });

  test("warns on malformed .pr file after pr-create", () => {
    const state = makeState({ phase: "pr-comments", round: 1 }, dir);
    writeFileSync(join(dir, "coder.pr"), "# My PR\nSome markdown body\n");
    const ctx: PreviousPhaseContext = { phase: "pr-create", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    expect(warnings.length).toBe(1);
    expect((warnings[0][0] as { message: string }).message).toContain("Invalid artifact from pr-create");
    expect((warnings[0][0] as { message: string }).message).toContain("non-URL content");
  });

  test("skips non-participating agents", () => {
    // Coder does not participate in review phase
    const state = makeState({ phase: "work", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    // Only reviewer participates in review — only one warning for reviewer's missing artifact
    expect(warnings.length).toBe(1);
    expect((warnings[0][0] as { message: string }).message).toContain("reviewer");
    expect((warnings[0][0] as { message: string }).message).not.toContain("coder");
  });

  test("uses ctx.round not state.round for artifact path", () => {
    // Simulate review→work transition where state.round was incremented to 2
    // but the review artifact was written for round 1.
    const state = makeState({ phase: "work", round: 2 }, dir);
    // Write review file for round 1 (the ctx round)
    writeFileSync(join(dir, "reviews", "round-1-reviewer.md"), "APPROVE\n");
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    validatePreviousPhaseArtifacts(state, ctx);
    const warnings = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
    );
    // Should find the file at round 1, no warning
    expect(warnings.length).toBe(0);
  });
});

describe("validateAgentPrFiles (eager repair)", () => {
  let fixSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let configSpy: ReturnType<typeof spyOn>;
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
    configSpy = spyOn(config, "findProjectConfig").mockReturnValue({ repo: "org/test-repo", name: "test" } as any);
  });
  afterEach(() => {
    fixSpy?.mockRestore();
    notifySpy.mockRestore();
    configSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("eagerly repairs malformed .pr file even when turn not settled", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue("https://github.com/org/repo/pull/1");
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    // Agent has no lifecycle (not settled)
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "# My PR\nSome markdown body\n");
    validateAgentPrFiles(state);
    expect(fixSpy).toHaveBeenCalled();
    expect(fixSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "org/test-repo"
    );
    expect(state.agentStates.coder.prUrl).toBe("https://github.com/org/repo/pull/1");
  });

  test("does not call repair for valid URL", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue("https://github.com/org/repo/pull/1");
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "https://github.com/org/repo/pull/1\n");
    validateAgentPrFiles(state);
    // Valid URL — eager path skips, settled-mode also skips (not settled)
    expect(fixSpy).not.toHaveBeenCalled();
  });

  test("does not call repair when .pr doesn't exist and turn not settled", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    // No .pr file written
    validateAgentPrFiles(state);
    expect(fixSpy).not.toHaveBeenCalled();
  });

  test("calls repair when .pr doesn't exist but turn is settled", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = makeLifecycle({ state: "settled" });
    state.agentStates.coder.status = "pr-create-done";
    validateAgentPrFiles(state);
    expect(fixSpy).toHaveBeenCalled();
    expect(fixSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "org/test-repo"
    );
  });

  test("skips empty .pr file", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "");
    validateAgentPrFiles(state);
    // Empty file — eager path skips (content falsy), settled-mode skips (not settled)
    expect(fixSpy).not.toHaveBeenCalled();
  });

  test("repair failure does not set prUrl or notify", () => {
    fixSpy = spyOn(github, "validateAndFixPrFile").mockReturnValue(null);
    const state = makeState({ phase: "pr-create", round: 1 }, dir);
    state.agentStates.coder.turnLifecycle = null;
    state.agentStates.coder.status = "pr-create-active";
    writeFileSync(join(dir, "coder.pr"), "# Bad PR body\n");
    validateAgentPrFiles(state);
    expect(fixSpy).toHaveBeenCalled();
    expect(fixSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), "org/test-repo"
    );
    expect(state.agentStates.coder.prUrl).toBeFalsy();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe("validateAndFixPrFile --repo argument", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => {
    spawnSpy?.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes --repo when repo argument provided", () => {
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: true, stdout: "https://github.com/org/repo/pull/42", stderr: "",
    } as any);
    const prFile = join(dir, "test.pr");
    writeFileSync(prFile, "# My PR\nSome description\n");

    const result = github.validateAndFixPrFile(prFile, "/tmp/wt", "my-branch", "org/repo");

    const ghCall = spawnSpy.mock.calls.find(
      (call: any) => Array.isArray(call[0]) && call[0][0] === "gh"
    );
    expect(ghCall).toBeDefined();
    expect(ghCall![0]).toContain("--repo");
    expect(ghCall![0]).toContain("org/repo");
    expect(result).toBe("https://github.com/org/repo/pull/42");
  });

  test("omits --repo when repo argument not provided", () => {
    spawnSpy = spyOn(spawn, "safeSyncOutput").mockReturnValue({
      ok: true, stdout: "https://github.com/org/repo/pull/42", stderr: "",
    } as any);
    const prFile = join(dir, "test.pr");
    writeFileSync(prFile, "# My PR\nSome description\n");

    github.validateAndFixPrFile(prFile, "/tmp/wt", "my-branch");

    const ghCall = spawnSpy.mock.calls.find(
      (call: any) => Array.isArray(call[0]) && call[0][0] === "gh"
    );
    expect(ghCall).toBeDefined();
    expect(ghCall![0]).not.toContain("--repo");
  });
});

