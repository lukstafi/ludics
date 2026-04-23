import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { pairReviewVerdict } from "./phases.ts";
import { applyPhaseSideEffects, maybePostCodexReviewRequests, checkAndRedispatchPrComments, resetPrCommentsState } from "./runner.ts";
import type { OrchestrationTransport } from "./transport.ts";
import * as notify from "../notify.ts";
import * as events from "../events.ts";
import * as github from "./github.ts";
import { type OrchestrationState } from "./state.ts";
import {
  makeTmpDir,
  makeGitRepo,
  makeState,
} from "./runner.test-helpers.ts";

setDefaultTimeout(20_000);

describe("pairReviewVerdict", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no review file exists (review timeout path)", () => {
    // No review file written — simulates a timed-out review phase.
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    expect(pairReviewVerdict(state)).toBeNull();
  });

  test("returns 'approve' when review file contains APPROVE", () => {
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "**Verdict**: APPROVE\n\nLooks good!\n");
    expect(pairReviewVerdict(state)).toBe("approve");
  });

  test("returns 'request_changes' when review file contains REQUEST_CHANGES", () => {
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "**Verdict**: REQUEST_CHANGES\n\nFix X.\n");
    expect(pairReviewVerdict(state)).toBe("request_changes");
  });

  test("returns 'request_changes' when file contains both APPROVE and REQUEST_CHANGES", () => {
    const state = makeState({ phase: "review", round: 1 }, tmpDir);
    writeFileSync(join(tmpDir, "reviews", "round-1-reviewer.md"), "do NOT APPROVE — REQUEST_CHANGES instead\n");
    expect(pairReviewVerdict(state)).toBe("request_changes");
  });

  test("uses correct round number for the review file lookup", () => {
    const state = makeState({ phase: "review", round: 3 }, tmpDir);
    // Write verdict for round 3 only — rounds 1 and 2 have no files.
    writeFileSync(join(tmpDir, "reviews", "round-3-reviewer.md"), "**Verdict**: APPROVE\n");
    expect(pairReviewVerdict(state)).toBe("approve");
  });

  test("timed-out review produces null verdict (regression: was falsely APPROVE)", () => {
    // This is the regression case: review phase timed out → evaluateTransition returns
    // "update-docs" (same as APPROVE), but no review file was written. The notification
    // logic must NOT label this transition as "APPROVE".
    const state = makeState({ phase: "review", round: 2 }, tmpDir);
    // No review file for round 2 — timeout scenario.
    const verdict = pairReviewVerdict(state);
    expect(verdict).toBeNull();
    // Verify the label that would be used in the notification is "timeout", not "APPROVE".
    const verdictLabel = verdict === "approve" ? "APPROVE"
      : verdict === "request_changes" ? "REQUEST_CHANGES"
      : "timeout";
    expect(verdictLabel).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// maybePostCodexReviewRequests — @codex review comment decision logic
// ---------------------------------------------------------------------------

describe("maybePostCodexReviewRequests", () => {
  function makeCodexState(
    overrides: Partial<OrchestrationState> = {},
  ): OrchestrationState {
    const state = makeState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
        },
        reviewer: {
          status: "idle", statusEpoch: 0, statusMessage: "",
          prUrl: null, interrupted: false,
        },
      },
      ...overrides,
    });
    return state;
  }

  test("arms deferral on pr-create -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "pr-create" });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeGreaterThan(0);
  });

  test("arms deferral on update-docs -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "update-docs" });
    maybePostCodexReviewRequests(state, "update-docs", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeGreaterThan(0);
  });

  test("arms deferral on review -> pr-comments with codex reviewer", () => {
    const state = makeCodexState({ phase: "review" });
    maybePostCodexReviewRequests(state, "review", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeGreaterThan(0);
  });

  test("does NOT arm on merge-review -> pr-comments", () => {
    const state = makeCodexState({ phase: "merge-review" });
    maybePostCodexReviewRequests(state, "merge-review", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when reviewer provider is claude-code", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when coder is codex but reviewer is claude-code", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "codex", role: "coder", model: "o3-pro", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "b", worktreePath: "/tmp/b" },
      ],
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when next phase is not pr-comments", () => {
    const state = makeCodexState({ phase: "pr-create" });
    maybePostCodexReviewRequests(state, "pr-create", "work");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });

  test("does NOT arm when no agents have a prUrl", () => {
    const state = makeCodexState({
      phase: "pr-create",
      agentStates: {
        coder: {
          status: "pr-create-done", statusEpoch: 0, statusMessage: "",
          prUrl: null, interrupted: false,
        },
        reviewer: {
          status: "idle", statusEpoch: 0, statusMessage: "",
          prUrl: null, interrupted: false,
        },
      },
    });
    maybePostCodexReviewRequests(state, "pr-create", "pr-comments");
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkAndRedispatchPrComments — deferred Codex review fallback logic
// ---------------------------------------------------------------------------

describe("checkAndRedispatchPrComments deferred review fallback", () => {
  let reviewSpy: ReturnType<typeof spyOn>;
  let commentSpy: ReturnType<typeof spyOn>;
  let postSpy: ReturnType<typeof spyOn>;
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;

  const nowSec = Math.floor(Date.now() / 1000);

  const dummyTransport: OrchestrationTransport = {
    sendTurn: async () => "cmd-1",
    sendEnter: async () => {},
    refreshAgentTransportState: async () => {},
    interruptAgent: async () => {},
  };

  function makePrCommentsState(
    overrides: Partial<OrchestrationState> = {},
  ): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120, // 2 min ago
      prCommentsLastCheckAt: nowSec - 120, // force poll eligibility
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "idle", statusEpoch: nowSec, statusMessage: "",
          prUrl: null, interrupted: false,
          turnLifecycle: null,
        },
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(false);
    commentSpy = spyOn(github, "hasCodexPostedComment").mockReturnValue(false);
    postSpy = spyOn(github, "postCodexReviewComment").mockReturnValue(true);
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(false);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    reviewSpy.mockRestore();
    commentSpy.mockRestore();
    postSpy.mockRestore();
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    eventSpy.mockRestore();
  });

  test("clears deferral early when all PRs have submitted reviews", async () => {
    reviewSpy.mockReturnValue(true);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60, // armed 60s ago (within window)
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("posts fallback after deadline when no review exists, keeps deferral armed", async () => {
    reviewSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 700, // 700s ago, past 600s deadline
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![0]).toBe("https://github.com/test/repo/pull/42");
    // Deferral stays armed — blocks shortcut until review actually arrives
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 700);
    expect(state.prCodexReviewFallbackPosted).toBe(true);
  });

  test("does not re-post fallback once already posted, keeps waiting for review", async () => {
    reviewSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 800,
      prCodexReviewFallbackPosted: true,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).not.toHaveBeenCalled();
    // Still armed — waiting for review
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 800);
  });

  test("clears deferral after fallback posted and review arrives", async () => {
    reviewSpy.mockReturnValue(true);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 800,
      prCodexReviewFallbackPosted: true,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
  });

  test("keeps waiting within deferral window when no review yet", async () => {
    reviewSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60, // only 60s, well within 600s window
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).not.toHaveBeenCalled();
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 60); // unchanged
  });

  test("posts fallback only for PRs missing review (per-PR resolution)", async () => {
    // PR 42 has review, PR 43 does not
    reviewSpy.mockImplementation((url: string) =>
      url.includes("pull/42")
    );
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 700,
      mode: "duo",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/43", interrupted: false,
          turnLifecycle: null,
        },
      },
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![0]).toBe("https://github.com/test/repo/pull/43");
    // Still armed — PR 43 review hasn't arrived yet
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 700);
    expect(state.prCodexReviewFallbackPosted).toBe(true);
  });

  test("does nothing when prCodexReviewDeferredSince is not set", async () => {
    const state = makePrCommentsState(); // no deferral armed
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(reviewSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("clears deferral when Codex posts issue comment (no formal review)", async () => {
    reviewSpy.mockReturnValue(false);
    commentSpy.mockReturnValue(true); // Codex responded with a comment
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBeUndefined();
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("keeps deferral armed when no Codex review or comment", async () => {
    reviewSpy.mockReturnValue(false);
    commentSpy.mockReturnValue(false);
    const state = makePrCommentsState({
      prCodexReviewDeferredSince: nowSec - 60,
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(state.prCodexReviewDeferredSince).toBe(nowSec - 60);
  });
});

// ---------------------------------------------------------------------------
// autoCommitAgent / autoCommitAllAgents
// ---------------------------------------------------------------------------

describe("checkAndRedispatchPrComments conflict detection", () => {
  let verificationSpy: ReturnType<typeof spyOn>;
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;
  let reviewSpy: ReturnType<typeof spyOn>;

  const nowSec = Math.floor(Date.now() / 1000);

  function makeConflictTransport(): OrchestrationTransport & { sendTurnCalls: Array<{ agent: string }> } {
    const calls: Array<{ agent: string }> = [];
    return {
      sendTurnCalls: calls,
      sendTurn: async (_state: OrchestrationState, agent: { name: string }) => {
        calls.push({ agent: agent.name });
        return "cmd-conflict";
      },
      sendEnter: async () => {},
      refreshAgentTransportState: async () => {},
      interruptAgent: async () => {},
    };
  }

  function makeConflictState(
    overrides: Partial<OrchestrationState> = {},
  ): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120,
      prCommentsLastCheckAt: nowSec - 120, // force poll eligibility
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "idle", statusEpoch: nowSec, statusMessage: "",
          prUrl: null, interrupted: false,
          turnLifecycle: null,
        },
      },
      prMergeableStates: {},
      ...overrides,
    });
  }

  beforeEach(() => {
    verificationSpy = spyOn(github, "getPrVerification");
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(false);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(false);
  });

  afterEach(() => {
    verificationSpy.mockRestore();
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    eventSpy.mockRestore();
    reviewSpy.mockRestore();
  });

  test("clean → dirty triggers one redispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "clean" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(1);
    expect(transport.sendTurnCalls[0]!.agent).toBe("coder");
    expect(state.prMergeableStates!.coder).toBe("dirty");
  });

  test("dirty → dirty does NOT redispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "dirty" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
  });

  test("dirty → clean → dirty redispatches again", async () => {
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "dirty" } });

    // First poll: dirty → clean
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "clean", reason: "ok",
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates!.coder).toBe("clean");

    // Reset poll eligibility and agent done status
    state.prCommentsLastCheckAt = nowSec - 120;
    state.agentStates.coder!.status = "pr-comments-done";
    state.agentStates.coder!.turnLifecycle = null;

    // Second poll: clean → dirty
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(1);
    expect(transport.sendTurnCalls[0]!.agent).toBe("coder");
  });

  test("unknown does not dispatch and does not overwrite prior state", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "unknown", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "clean" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates!.coder).toBe("clean"); // preserved
  });

  test("behind does not dispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "behind", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "clean" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates!.coder).toBe("behind");
  });

  test("only affected agent redispatched in duo mode", async () => {
    verificationSpy.mockImplementation((url: string) => {
      if (url.includes("pull/42")) {
        return { exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok" };
      }
      return { exists: true, state: "open", merged: false, mergeableState: "clean", reason: "ok" };
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({
      mode: "duo",
      prMergeableStates: { coder: "clean", reviewer: "clean" },
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/43", interrupted: false,
          turnLifecycle: null,
        },
      },
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(1);
    expect(transport.sendTurnCalls[0]!.agent).toBe("coder");
  });

  test("does NOT advance prCommentsLastCheckAt on conflict dispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const originalCheckAt = nowSec - 120;
    const state = makeConflictState({
      prMergeableStates: { coder: "clean" },
      prCommentsLastCheckAt: originalCheckAt,
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(state.prCommentsLastCheckAt).toBe(originalCheckAt);
  });

  test("resets prCommentsQuietSince on conflict dispatch", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({
      prMergeableStates: { coder: "clean" },
      prCommentsQuietSince: nowSec - 60,
    });
    await checkAndRedispatchPrComments(state, transport);
    expect(state.prCommentsQuietSince).toBe(0);
  });

  test("resume preserves prMergeableStates during conflict check", async () => {
    // Simulate resume scenario: prMergeableStates already populated with "dirty"
    // from a prior poll. dirty→dirty should NOT redispatch — proving the map survived.
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "dirty", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: { coder: "dirty" } });
    await checkAndRedispatchPrComments(state, transport);
    expect(transport.sendTurnCalls).toHaveLength(0);
    expect(state.prMergeableStates).toEqual({ coder: "dirty" });
  });

  test("defensive init creates prMergeableStates when undefined (legacy state)", async () => {
    verificationSpy.mockReturnValue({
      exists: true, state: "open", merged: false, mergeableState: "clean", reason: "ok",
    });
    const transport = makeConflictTransport();
    const state = makeConflictState({ prMergeableStates: undefined });
    await checkAndRedispatchPrComments(state, transport);
    expect(state.prMergeableStates).toBeDefined();
    expect(state.prMergeableStates!.coder).toBe("clean");
  });

  test("fresh re-entry resets prMergeableStates via applyPhaseSideEffects", () => {
    const state = makeConflictState({
      phase: "pr-create",
      prMergeableStates: { coder: "dirty" },
    });
    applyPhaseSideEffects(state, "pr-comments");
    expect(state.prMergeableStates).toEqual({});
  });

  test("applyPhaseSideEffects resets all pr-comments fields via resetPrCommentsState", () => {
    const state = makeConflictState({
      phase: "pr-create",
      prCommentsLastCheckAt: 999,
      prCommentsQuietSince: 888,
      prCommentsCoderDispatched: true,
      prMergeableStates: { coder: "dirty" },
      prCodexReviewFallbackPosted: true,
    });
    applyPhaseSideEffects(state, "pr-comments");
    expect(state.prCommentsLastCheckAt).toBe(state.phaseStartedAt - 600);
    expect(state.prCommentsQuietSince).toBeUndefined();
    expect(state.prCommentsCoderDispatched).toBe(false);
    expect(state.prMergeableStates).toEqual({});
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
  });
});

describe("checkAndRedispatchPrComments merge detection", () => {
  // Regression for the simplified upstream workflow (task-d1932b8f): when
  // isPrMerged returns true during pr-comments, the runner must take the
  // uniform merged path — write `<agent>.merged`, set status to "merged",
  // emit `pr_merged`, and notify. The former upstream-aware three-way split
  // (upstream-merged marker / upstream_pr_merged event / forwarding warning)
  // must be gone. We exercise this with an upstream-configured fixture so
  // the test specifically guards the behavior this task simplified.
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let reviewSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;
  let emittedEvents: Array<{ event_type?: string; message?: string }>;
  const nowSec = Math.floor(Date.now() / 1000);

  const dummyTransport: OrchestrationTransport = {
    sendTurn: async () => "cmd-merge",
    sendEnter: async () => {},
    refreshAgentTransportState: async () => {},
    interruptAgent: async () => {},
  };

  function makeMergeState(peerSyncDir: string, overrides: Partial<OrchestrationState> = {}): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120,
      prCommentsLastCheckAt: nowSec - 120,
      projectDir: "/tmp/upstream-configured-project",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
        { name: "reviewer", provider: "codex", role: "reviewer", model: "o3-pro", branch: "b", worktreePath: "/tmp/b" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done", statusEpoch: nowSec, statusMessage: "",
          prUrl: "https://github.com/lukstafi/ocannl-staging/pull/451", interrupted: false,
          turnLifecycle: null,
        },
        reviewer: {
          status: "idle", statusEpoch: nowSec, statusMessage: "",
          prUrl: null, interrupted: false,
          turnLifecycle: null,
        },
      },
      ...overrides,
    }, peerSyncDir);
  }

  beforeEach(() => {
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(true);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(true);
    emittedEvents = [];
    eventSpy = spyOn(events, "emitEvent").mockImplementation((ev: unknown) => {
      emittedEvents.push(ev as { event_type?: string; message?: string });
    });
    // notifyAgents is invoked on the uniform merged path; stub to avoid noise.
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
  });

  afterEach(() => {
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    reviewSpy.mockRestore();
    eventSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("merged PR on upstream-configured project: writes .merged, sets status, emits pr_merged — no upstream-specific artifacts", async () => {
    const dir = makeTmpDir();
    const state = makeMergeState(dir);
    await checkAndRedispatchPrComments(state, dummyTransport);

    // 1. `<coder>.merged` marker is written (uniform path).
    const mergedMarker = join(dir, "coder.merged");
    expect(existsSync(mergedMarker)).toBe(true);
    expect(readFileSync(mergedMarker, "utf-8")).toBe("merged\n");

    // 2. Agent status flips to "merged".
    expect(state.agentStates.coder!.status).toBe("merged");
    expect(state.agentStates.coder!.statusMessage).toBe("PR merged externally");

    // 3. `pr_merged` event is emitted exactly once; NO `upstream_pr_merged`
    //    event and NO "orchestration_warning" about forwarding.
    const merged = emittedEvents.filter((e) => e.event_type === "pr_merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toContain("https://github.com/lukstafi/ocannl-staging/pull/451");
    expect(emittedEvents.some((e) => e.event_type === "upstream_pr_merged")).toBe(false);
    expect(emittedEvents.some((e) =>
      e.event_type === "orchestration_warning"
      && typeof e.message === "string"
      && e.message.includes("before forwarding")
    )).toBe(false);

    // 4. No `<coder>.upstream-merged` or `<coder>.forwarded` sidecar markers
    //    are written by the runner.
    expect(existsSync(join(dir, "coder.upstream-merged"))).toBe(false);
    expect(existsSync(join(dir, "coder.forwarded"))).toBe(false);

    // 5. notifyAgents was called (uniform path includes notification).
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  test("merged PR is idempotent: second invocation does not re-emit or rewrite the marker", async () => {
    const dir = makeTmpDir();
    const state = makeMergeState(dir);
    await checkAndRedispatchPrComments(state, dummyTransport);
    const firstEventCount = emittedEvents.filter((e) => e.event_type === "pr_merged").length;
    expect(firstEventCount).toBe(1);

    // Reset polling eligibility so the loop re-evaluates. The marker file
    // already exists; the runner must not emit pr_merged a second time.
    state.prCommentsLastCheckAt = nowSec - 120;
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(emittedEvents.filter((e) => e.event_type === "pr_merged")).toHaveLength(1);
  });
});

describe("resetPrCommentsState", () => {
  test("resets all pr-comments phase-entry fields", () => {
    const state = makeState({
      phase: "pr-comments",
      prCommentsLastCheckAt: 999,
      prCommentsQuietSince: 888,
      prCommentsCoderDispatched: true,
      prMergeableStates: { coder: "dirty" },
      prCodexReviewFallbackPosted: true,
      prCodexReviewDeferredSince: 777,
    });
    resetPrCommentsState(state);
    expect(state.prCommentsLastCheckAt).toBe(state.phaseStartedAt - 600);
    expect(state.prCommentsQuietSince).toBeUndefined();
    expect(state.prCommentsCoderDispatched).toBe(false);
    expect(state.prMergeableStates).toEqual({});
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
    // prCodexReviewDeferredSince has independent lifecycle — must NOT be touched
    expect(state.prCodexReviewDeferredSince).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// handleVerifyFailure
// ---------------------------------------------------------------------------

