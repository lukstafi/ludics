import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { pairReviewVerdict } from "./phases.ts";
import { applyPhaseSideEffects, checkAndAnnotatePrBodyDrift, maybePostCodexReviewRequests, checkAndRedispatchPrComments, resetPrCommentsState, validateAgentPrFiles } from "./runner.ts";
import type { OrchestrationTransport } from "./transport.ts";
import * as notify from "../notify.ts";
import * as events from "../events.ts";
import * as github from "./github.ts";
import * as worktrees from "./worktrees.ts";
import { type OrchestrationState } from "./state.ts";
import {
  makeTmpDir,
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
      prCommentsCoderActive: true,
      prCommentsRedispatchCount: 3,
      prCommentsLastRedispatchAt: 777,
      prCommentsStuckWarnedAt: 555,
      prMergeableStates: { coder: "dirty" },
      prCodexReviewFallbackPosted: true,
    });
    applyPhaseSideEffects(state, "pr-comments");
    expect(state.prCommentsLastCheckAt).toBe(state.phaseStartedAt - 600);
    expect(state.prCommentsQuietSince).toBeUndefined();
    expect(state.prCommentsCoderActive).toBe(false);
    expect(state.prCommentsRedispatchCount).toBeUndefined();
    expect(state.prCommentsLastRedispatchAt).toBeUndefined();
    expect(state.prCommentsStuckWarnedAt).toBeUndefined();
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
      prCommentsCoderActive: true,
      prCommentsRedispatchCount: 4,
      prCommentsLastRedispatchAt: 666,
      prCommentsStuckWarnedAt: 555,
      prMergeableStates: { coder: "dirty" },
      prCodexReviewFallbackPosted: true,
      prCodexReviewDeferredSince: 777,
    });
    resetPrCommentsState(state);
    expect(state.prCommentsLastCheckAt).toBe(state.phaseStartedAt - 600);
    expect(state.prCommentsQuietSince).toBeUndefined();
    expect(state.prCommentsCoderActive).toBe(false);
    expect(state.prCommentsRedispatchCount).toBeUndefined();
    expect(state.prCommentsLastRedispatchAt).toBeUndefined();
    expect(state.prCommentsStuckWarnedAt).toBeUndefined();
    expect(state.prMergeableStates).toEqual({});
    expect(state.prCodexReviewFallbackPosted).toBeUndefined();
    // prCodexReviewDeferredSince has independent lifecycle — must NOT be touched
    expect(state.prCodexReviewDeferredSince).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// PR body drift annotation (checkAndAnnotatePrBodyDrift + baseline capture)
// ---------------------------------------------------------------------------

describe("capturePrBodyBaseline (via validateAgentPrFiles)", () => {
  let countSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    countSpy = spyOn(worktrees, "countCommitsAhead");
    notifySpy = spyOn(notify, "notifyAgents").mockImplementation(() => {});
  });

  afterEach(() => {
    countSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("captures baseline on first prUrl transition", () => {
    countSpy.mockReturnValue(1);
    const dir = makeTmpDir();
    const state = makeState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-create-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
        },
      },
    }, dir);
    validateAgentPrFiles(state);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(1);
    expect(typeof state.agentStates.coder!.prBodyBaselineAt).toBe("string");
    expect(state.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBeNull();
    expect(state.agentStates.coder!.prBodyBaselineUrl).toBe("https://github.com/test/repo/pull/42");
  });

  test("preserves existing baseline on re-entry to pr-create", () => {
    countSpy.mockReturnValue(5);
    const dir = makeTmpDir();
    const state = makeState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-create-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
          prBodyBaselineCommits: 1,
          prBodyBaselineAt: "2026-04-23T14:20:05Z",
          prBodyBaselineUrl: "https://github.com/test/repo/pull/42",
          prBodyDriftAnnotatedAtCommits: null,
        },
      },
    }, dir);
    validateAgentPrFiles(state);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(1);
    expect(state.agentStates.coder!.prBodyBaselineAt).toBe("2026-04-23T14:20:05Z");
  });

  test("skips capture when countCommitsAhead returns null (git error)", () => {
    countSpy.mockReturnValue(null);
    const dir = makeTmpDir();
    const state = makeState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-create-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
        },
      },
    }, dir);
    validateAgentPrFiles(state);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBeUndefined();
    expect(state.agentStates.coder!.prBodyBaselineAt).toBeUndefined();
  });

  test("skips capture when prUrl is null", () => {
    countSpy.mockReturnValue(3);
    const dir = makeTmpDir();
    const state = makeState({
      phase: "pr-create",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-create-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: null,
          interrupted: false,
          turnLifecycle: null,
        },
      },
    }, dir);
    validateAgentPrFiles(state);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBeUndefined();
  });
});

describe("checkAndAnnotatePrBodyDrift", () => {
  let countSpy: ReturnType<typeof spyOn>;
  let postSpy: ReturnType<typeof spyOn>;
  let mergedSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;
  let emittedEvents: Array<{ event_type?: string; message?: string }>;

  function makeDriftState(runtimeOverrides: {
    prUrl?: string | null;
    prBodyBaselineCommits?: number;
    prBodyBaselineAt?: string;
    prBodyDriftAnnotatedAtCommits?: number | null;
  } = {}): OrchestrationState {
    return makeState({
      phase: "pr-comments",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
          prBodyBaselineCommits: 1,
          prBodyBaselineAt: "2026-04-23T14:20:05Z",
          prBodyDriftAnnotatedAtCommits: null,
          ...runtimeOverrides,
        },
      },
    });
  }

  beforeEach(() => {
    countSpy = spyOn(worktrees, "countCommitsAhead");
    postSpy = spyOn(github, "postPrDriftComment").mockReturnValue(true);
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(false);
    emittedEvents = [];
    eventSpy = spyOn(events, "emitEvent").mockImplementation((ev: unknown) => {
      emittedEvents.push(ev as { event_type?: string; message?: string });
    });
  });

  afterEach(() => {
    countSpy.mockRestore();
    postSpy.mockRestore();
    mergedSpy.mockRestore();
    eventSpy.mockRestore();
  });

  test("posts annotation on baseline → current drift and advances baseline", () => {
    countSpy.mockReturnValue(2);
    const state = makeDriftState();
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![0]).toBe("https://github.com/test/repo/pull/42");
    expect(postSpy.mock.calls[0]![1]).toBe(1);
    expect(postSpy.mock.calls[0]![2]).toBe(2);
    expect(postSpy.mock.calls[0]![3]).toBe("2026-04-23T14:20:05Z");
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(2);
    expect(state.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBe(2);
    expect(state.agentStates.coder!.prBodyBaselineAt).not.toBe("2026-04-23T14:20:05Z");
    expect(emittedEvents.some((e) => e.event_type === "pr_body_drift_annotated")).toBe(true);
  });

  test("debounce: second poll at same commit count does not re-post", () => {
    countSpy.mockReturnValue(2);
    const state = makeDriftState();
    // first poll: posts annotation, advances baseline to 2, dedup marker = 2
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(1);

    // second poll at same count: baseline now matches current (2 === 2),
    // so the `current === baseline` gate fires — nothing to post.
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test("third poll at a NEW distinct count re-posts", () => {
    const state = makeDriftState();
    countSpy.mockReturnValue(2);
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(1);

    countSpy.mockReturnValue(3);
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[1]![1]).toBe(2); // baseline after first advance
    expect(postSpy.mock.calls[1]![2]).toBe(3); // current
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(3);
    expect(state.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBe(3);
  });

  test("debounce via prBodyDriftAnnotatedAtCommits dedup when baseline unchanged", () => {
    // Set up a state where the baseline was NOT advanced (e.g., posting failed
    // on a prior tick, then retry at same count): the dedup marker still guards.
    // Here we simulate: prBodyDriftAnnotatedAtCommits === current, so skip.
    countSpy.mockReturnValue(2);
    const state = makeDriftState({ prBodyDriftAnnotatedAtCommits: 2 });
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("skips when isPrMerged returns true", () => {
    mergedSpy.mockReturnValue(true);
    countSpy.mockReturnValue(99);
    const state = makeDriftState();
    checkAndAnnotatePrBodyDrift(state);
    expect(countSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    // baseline must NOT be advanced
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(1);
  });

  test("lazy-captures baseline when none exists and does not post on the same tick", () => {
    // Slot transitioned update-docs -> pr-comments without visiting pr-create,
    // so validateAgentPrFiles never ran. checkAndAnnotatePrBodyDrift must
    // capture the baseline itself on the first tick and then NOT post (the
    // current count equals the freshly-captured baseline).
    countSpy.mockReturnValue(5);
    const state = makeDriftState({
      prBodyBaselineCommits: undefined,
      prBodyBaselineAt: undefined,
      prBodyDriftAnnotatedAtCommits: undefined,
    });
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(5);
    expect(typeof state.agentStates.coder!.prBodyBaselineAt).toBe("string");
    expect(state.agentStates.coder!.prBodyBaselineUrl).toBe("https://github.com/test/repo/pull/42");
  });

  test("after lazy capture, a subsequent tick with a different count posts", () => {
    // Tick 1: no baseline, count=3 → lazy-capture baseline=3.
    countSpy.mockReturnValue(3);
    const state = makeDriftState({
      prBodyBaselineCommits: undefined,
      prBodyBaselineAt: undefined,
      prBodyDriftAnnotatedAtCommits: undefined,
    });
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(3);

    // Tick 2: count=5 → drift fires.
    countSpy.mockReturnValue(5);
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]![1]).toBe(3);
    expect(postSpy.mock.calls[0]![2]).toBe(5);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(5);
  });

  test("skips when baseline is undefined AND git fails (fail-safe)", () => {
    countSpy.mockReturnValue(null);
    const state = makeDriftState({
      prBodyBaselineCommits: undefined,
      prBodyBaselineAt: undefined,
      prBodyDriftAnnotatedAtCommits: undefined,
    });
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBeUndefined();
  });

  test("recaptures baseline when prUrl changes mid-flow", () => {
    // Start with baseline=1 for PR #42, tracked URL #42.
    countSpy.mockReturnValue(10);
    const state = makeDriftState({
      prBodyBaselineCommits: 1,
      prBodyBaselineAt: "2026-04-23T14:20:05Z",
      prBodyDriftAnnotatedAtCommits: null,
    });
    state.agentStates.coder!.prBodyBaselineUrl = "https://github.com/test/repo/pull/42";
    // Agent replaces the PR — runtime.prUrl now points at #99.
    state.agentStates.coder!.prUrl = "https://github.com/test/repo/pull/99";

    checkAndAnnotatePrBodyDrift(state);

    // No annotation posted — the old baseline's 1 vs 10 mismatch does NOT
    // count; the baseline is invalidated against the new PR first, then
    // recaptured against the new URL.
    expect(postSpy).not.toHaveBeenCalled();
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(10);
    expect(state.agentStates.coder!.prBodyBaselineUrl).toBe("https://github.com/test/repo/pull/99");
    expect(state.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBeNull();
  });

  test("skips when countCommitsAhead returns null (git error)", () => {
    countSpy.mockReturnValue(null);
    const state = makeDriftState();
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
    // baseline must NOT be advanced — fail closed
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(1);
  });

  test("skips when current equals baseline (no drift)", () => {
    countSpy.mockReturnValue(1); // same as baseline
    const state = makeDriftState();
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("skips agents with no prUrl", () => {
    countSpy.mockReturnValue(2);
    const state = makeDriftState({ prUrl: null });
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).not.toHaveBeenCalled();
  });

  test("post-failure does not advance baseline or dedup (retry next poll)", () => {
    postSpy.mockReturnValue(false);
    countSpy.mockReturnValue(2);
    const state = makeDriftState();
    checkAndAnnotatePrBodyDrift(state);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(1); // unchanged
    expect(state.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBeNull();
  });
});

describe("checkAndRedispatchPrComments integration: drift annotation", () => {
  let countSpy: ReturnType<typeof spyOn>;
  let postDriftSpy: ReturnType<typeof spyOn>;
  let mergedSpy: ReturnType<typeof spyOn>;
  let commentCountSpy: ReturnType<typeof spyOn>;
  let reviewSpy: ReturnType<typeof spyOn>;
  let commentSpy: ReturnType<typeof spyOn>;
  let eventSpy: ReturnType<typeof spyOn>;

  const nowSec = Math.floor(Date.now() / 1000);
  const dummyTransport: OrchestrationTransport = {
    sendTurn: async () => "cmd-int",
    sendEnter: async () => {},
    refreshAgentTransportState: async () => {},
    interruptAgent: async () => {},
  };

  beforeEach(() => {
    countSpy = spyOn(worktrees, "countCommitsAhead").mockReturnValue(2);
    postDriftSpy = spyOn(github, "postPrDriftComment").mockReturnValue(true);
    mergedSpy = spyOn(github, "isPrMerged").mockReturnValue(false);
    commentCountSpy = spyOn(github, "fetchNewPrCommentCount").mockReturnValue(0);
    reviewSpy = spyOn(github, "hasCodexSubmittedReview").mockReturnValue(false);
    commentSpy = spyOn(github, "hasCodexPostedComment").mockReturnValue(false);
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    countSpy.mockRestore();
    postDriftSpy.mockRestore();
    mergedSpy.mockRestore();
    commentCountSpy.mockRestore();
    reviewSpy.mockRestore();
    commentSpy.mockRestore();
    eventSpy.mockRestore();
  });

  test("drift check fires from checkAndRedispatchPrComments during pr-comments", async () => {
    const state = makeState({
      phase: "pr-comments",
      phaseStartedAt: nowSec - 120,
      prCommentsLastCheckAt: nowSec - 120, // force poll eligibility
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done",
          statusEpoch: nowSec,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
          prBodyBaselineCommits: 1,
          prBodyBaselineAt: "2026-04-23T14:20:05Z",
          prBodyDriftAnnotatedAtCommits: null,
        },
      },
    });
    await checkAndRedispatchPrComments(state, dummyTransport);
    expect(postDriftSpy).toHaveBeenCalledTimes(1);
    expect(state.agentStates.coder!.prBodyBaselineCommits).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PR body drift annotation round-trip persistence
// ---------------------------------------------------------------------------

describe("prBody* state fields round-trip through persistState", () => {
  test("persisted state preserves prBody* fields via JSON round-trip", async () => {
    const { persistState, readOrchestrationState } = await import("./state.ts");
    const harnessDir = makeTmpDir();
    const { mkdirSync } = await import("fs");
    mkdirSync(join(harnessDir, "orchestration"), { recursive: true });

    const state = makeState({
      slot: 77,
      phase: "pr-comments",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
          prBodyBaselineCommits: 3,
          prBodyBaselineAt: "2026-04-24T08:00:00Z",
          prBodyBaselineUrl: "https://github.com/test/repo/pull/42",
          prBodyDriftAnnotatedAtCommits: 2,
        },
      },
    });

    persistState(state, harnessDir);
    const restored = readOrchestrationState(77, harnessDir);
    expect(restored).not.toBeNull();
    expect(restored!.agentStates.coder!.prBodyBaselineCommits).toBe(3);
    expect(restored!.agentStates.coder!.prBodyBaselineAt).toBe("2026-04-24T08:00:00Z");
    expect(restored!.agentStates.coder!.prBodyBaselineUrl).toBe("https://github.com/test/repo/pull/42");
    expect(restored!.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBe(2);
  });

  test("legacy state without prBody* fields loads with all three undefined", async () => {
    const { persistState, readOrchestrationState } = await import("./state.ts");
    const harnessDir = makeTmpDir();
    const { mkdirSync } = await import("fs");
    mkdirSync(join(harnessDir, "orchestration"), { recursive: true });

    const state = makeState({
      slot: 78,
      phase: "pr-comments",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
      ],
      agentStates: {
        coder: {
          status: "pr-comments-done",
          statusEpoch: 0,
          statusMessage: "",
          prUrl: "https://github.com/test/repo/pull/42",
          interrupted: false,
          turnLifecycle: null,
          // no prBody* fields
        },
      },
    });

    persistState(state, harnessDir);
    const restored = readOrchestrationState(78, harnessDir);
    expect(restored).not.toBeNull();
    expect(restored!.agentStates.coder!.prBodyBaselineCommits).toBeUndefined();
    expect(restored!.agentStates.coder!.prBodyBaselineAt).toBeUndefined();
    expect(restored!.agentStates.coder!.prBodyBaselineUrl).toBeUndefined();
    expect(restored!.agentStates.coder!.prBodyDriftAnnotatedAtCommits).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleVerifyFailure
// ---------------------------------------------------------------------------

