import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as events from "../events.ts";
import {
  warnMissingRegressionTestsSection,
  warnStaleBase,
  type PreviousPhaseContext,
} from "./runner.ts";
import { makeGitRepo, makeState, makeTmpDir } from "./runner.test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envSandbox(keys: string[]): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return {
    restore: () => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

function countWarnings(spy: ReturnType<typeof spyOn>): number {
  return spy.mock.calls.filter(
    (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
  ).length;
}

function lastWarning(spy: ReturnType<typeof spyOn>): { message: string } | undefined {
  const warns = spy.mock.calls.filter(
    (c: unknown[]) => (c[0] as { event_type: string }).event_type === "orchestration_warning",
  );
  return warns[warns.length - 1]?.[0] as { message: string } | undefined;
}

/** Seed a real file:// bare remote as `origin` and push `main`.
 *  Required so `git fetch origin main` actually succeeds in tests —
 *  the base-repo `makeGitRepo` only seeds `refs/remotes/origin/main`
 *  via `update-ref` with no fetchable URL. */
function addRealOrigin(repoDir: string): string {
  const originBare = join(repoDir, "..", `origin-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
  Bun.spawnSync(["git", "init", "--bare", "--initial-branch=main", originBare]);
  // makeGitRepo doesn't actually configure an `origin` remote (only the ref),
  // but defensively remove any prior config.
  Bun.spawnSync(["git", "remote", "remove", "origin"], { cwd: repoDir });
  Bun.spawnSync(["git", "remote", "add", "origin", originBare], { cwd: repoDir });
  Bun.spawnSync(["git", "push", "-u", "origin", "main"], { cwd: repoDir });
  return originBare;
}

/** Add commits on main in the given repo and push them to origin so
 *  `refs/remotes/origin/main` advances. */
function advanceOriginMain(repoDir: string, n: number = 1): void {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repoDir, `main-advance-${Date.now()}-${i}.txt`), `c${i}`);
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", `advance-${i}`], { cwd: repoDir });
  }
  Bun.spawnSync(["git", "push", "origin", "main"], { cwd: repoDir });
}

/** Fork a worktree off the current HEAD of repoDir (i.e. current origin/main). */
function forkWorktree(repoDir: string): string {
  const wtPath = join(repoDir, "..", `wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["git", "worktree", "add", "-b", `branch-${Date.now()}`, wtPath, "HEAD"], {
    cwd: repoDir,
  });
  return wtPath;
}

// ---------------------------------------------------------------------------
// Item B: warnMissingRegressionTestsSection
// ---------------------------------------------------------------------------

describe("warnMissingRegressionTestsSection", () => {
  let emitSpy: ReturnType<typeof spyOn>;
  let dir: string;
  let env: { restore: () => void };

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    env = envSandbox(["LUDICS_WARN_MISSING_TESTS_SECTION"]);
  });
  afterEach(() => {
    env.restore();
    emitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("emits warning when ## Regression Tests section is absent", () => {
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    writeFileSync(
      join(dir, "plans", "round-1-merged-0.md"),
      "# Merged Plan\n\n## Overview\nStuff.\n",
    );
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(lastWarning(emitSpy)!.message).toContain("Regression Tests");
    expect(lastWarning(emitSpy)!.message).toContain("round-1-merged-0.md");
  });

  test("no warning when section is present (exact heading)", () => {
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    writeFileSync(
      join(dir, "plans", "round-1-merged-0.md"),
      "# Merged Plan\n\n## Regression Tests\n- test something\n",
    );
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("prose mention of 'regression tests' does not satisfy the check", () => {
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    writeFileSync(
      join(dir, "plans", "round-1-merged-0.md"),
      "# Merged Plan\n\nWe should add regression tests later.\n",
    );
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(1);
  });

  test("skipped when ctx.phase !== 'plan-merge'", () => {
    const state = makeState({ phase: "work", round: 1 }, dir);
    const ctx: PreviousPhaseContext = { phase: "review", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("skipped when merged plan file is absent (no throw, no warn)", () => {
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    // No file written.
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    expect(() => warnMissingRegressionTestsSection(state, ctx)).not.toThrow();
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("env-var opt-out respected (LUDICS_WARN_MISSING_TESTS_SECTION=0)", () => {
    process.env.LUDICS_WARN_MISSING_TESTS_SECTION = "0";
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    writeFileSync(join(dir, "plans", "round-1-merged-0.md"), "# No section\n");
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("env-var opt-out also accepts 'false' (case-insensitive)", () => {
    process.env.LUDICS_WARN_MISSING_TESTS_SECTION = "FALSE";
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    writeFileSync(join(dir, "plans", "round-1-merged-0.md"), "# No section\n");
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("env-var '1' (default-ish truthy) keeps check enabled", () => {
    process.env.LUDICS_WARN_MISSING_TESTS_SECTION = "1";
    const state = makeState({ phase: "plan-review", round: 1, planMergeRound: 0 }, dir);
    writeFileSync(join(dir, "plans", "round-1-merged-0.md"), "# No section\n");
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(1);
  });

  test("uses correct (round, planMergeRound) from ctx, not state", () => {
    // state.round = 2, state.planMergeRound = 1, but ctx points at round=1, pmr=0
    const state = makeState({ phase: "plan-review", round: 2, planMergeRound: 1 }, dir);
    writeFileSync(
      join(dir, "plans", "round-1-merged-0.md"),
      "# Merged Plan for round 1\n\nNo test section.\n",
    );
    const ctx: PreviousPhaseContext = { phase: "plan-merge", round: 1, planMergeRound: 0 };
    warnMissingRegressionTestsSection(state, ctx);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(lastWarning(emitSpy)!.message).toContain("round-1-merged-0.md");
  });
});

// ---------------------------------------------------------------------------
// Item A: warnStaleBase
// ---------------------------------------------------------------------------

describe("warnStaleBase", () => {
  let emitSpy: ReturnType<typeof spyOn>;
  let env: { restore: () => void };
  const cleanup: string[] = [];

  beforeEach(() => {
    emitSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    env = envSandbox(["LUDICS_WARN_BASE_STALENESS_THRESHOLD", "LUDICS_WARN_FETCH_TIMEOUT_MS"]);
  });
  afterEach(() => {
    env.restore();
    emitSpy.mockRestore();
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  function setupStaleRepo(advanceCount: number): { worktree: string; repoDir: string; originBare: string } {
    const repoDir = makeGitRepo();
    cleanup.push(join(repoDir, ".."));
    const originBare = addRealOrigin(repoDir);
    const worktree = forkWorktree(repoDir);
    advanceOriginMain(repoDir, advanceCount);
    return { worktree, repoDir, originBare };
  }

  function stateFor(worktree: string, repoDir: string, round: number = 1) {
    const s = makeState({ phase: "plan", round });
    s.projectDir = repoDir;
    s.agents[0]!.worktreePath = worktree;
    return s;
  }

  test("emits warning when staleness meets default threshold (5)", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(lastWarning(emitSpy)!.message).toMatch(/5 commit/);
    expect(lastWarning(emitSpy)!.message).toContain("origin/main");
    expect(lastWarning(emitSpy)!.message).toContain("git rebase");
    expect(state.staleBaseLastWarned?.coder?.count).toBe(5);
    expect(state.staleBaseLastWarned?.coder?.round).toBe(1);
  });

  test("no warning when below threshold (happy path)", () => {
    const { worktree, repoDir } = setupStaleRepo(3);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(0);
    // Memo reset to 0 for current round but no warning fired.
    expect(state.staleBaseLastWarned?.coder?.count).toBe(0);
  });

  test("custom threshold honored", () => {
    process.env.LUDICS_WARN_BASE_STALENESS_THRESHOLD = "2";
    const { worktree, repoDir } = setupStaleRepo(2);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
  });

  test("threshold <= 0 disables Item A entirely", () => {
    process.env.LUDICS_WARN_BASE_STALENESS_THRESHOLD = "0";
    const { worktree, repoDir } = setupStaleRepo(20);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(0);
    // Dedup memo untouched.
    expect(state.staleBaseLastWarned).toBeUndefined();

    process.env.LUDICS_WARN_BASE_STALENESS_THRESHOLD = "-1";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("NaN threshold falls back to default 5", () => {
    process.env.LUDICS_WARN_BASE_STALENESS_THRESHOLD = "not-a-number";
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
  });

  test("git error silently skipped (no origin/main)", () => {
    // Raw tmpdir is a valid path but not a git repo.
    const tmp = makeTmpDir();
    cleanup.push(tmp);
    const state = makeState({ phase: "plan", round: 1 });
    state.projectDir = tmp;
    state.agents[0]!.worktreePath = tmp;
    expect(() => warnStaleBase(state)).not.toThrow();
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("failed fetch does not fall through to stale cached origin/<main>", () => {
    // Regression for AC1: the warning must not emit when `git fetch` fails.
    // Reproduce the reviewer's scenario — `refs/remotes/origin/main` is
    // seeded ahead of HEAD but `origin` points at an invalid URL, so fetch
    // cannot refresh the ref and we must skip rather than measure against
    // whatever stale value happens to be cached locally.
    const { worktree, repoDir } = setupStaleRepo(5);
    // Break the remote URL (shared config) so fetch fails. The existing
    // cached refs/remotes/origin/main still points 5 commits ahead of HEAD.
    Bun.spawnSync(
      ["git", "remote", "set-url", "origin", "file:///dev/null/nonexistent-remote"],
      { cwd: repoDir },
    );
    // Sanity: cached origin/main still shows staleness before fetch attempt.
    const mb = Bun.spawnSync(
      ["git", "merge-base", "HEAD", "origin/main"],
      { cwd: worktree },
    );
    const revCount = Bun.spawnSync(
      ["git", "rev-list", "--count", `${String(mb.stdout).trim()}..origin/main`],
      { cwd: worktree },
    );
    expect(parseInt(String(revCount.stdout).trim(), 10)).toBe(5);
    // Sanity: fetch now fails.
    const fetchResult = Bun.spawnSync(["git", "fetch", "origin", "main"], { cwd: worktree });
    expect(fetchResult.exitCode).not.toBe(0);

    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);

    // Must not emit (fetch failed) and must not update the dedup memo.
    expect(countWarnings(emitSpy)).toBe(0);
    expect(state.staleBaseLastWarned).toBeUndefined();
  });

  test("missing worktree path silently skipped", () => {
    const state = makeState({ phase: "plan", round: 1 });
    state.projectDir = "/tmp/nonexistent-project";
    state.agents[0]!.worktreePath = "/tmp/nonexistent-worktree-ludics-xyz";
    expect(() => warnStaleBase(state)).not.toThrow();
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("no coder agent → silently skipped", () => {
    const { worktree, repoDir } = setupStaleRepo(10);
    const state = stateFor(worktree, repoDir);
    // Strip coder role from both agents.
    for (const a of state.agents) a.role = "reviewer";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(0);
  });

  test("dedup: does not re-fire when count has not grown within same round", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    // Same state, same round, same origin — should not re-fire.
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
  });

  test("dedup: re-fires when count grows within same round", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    // Advance origin/main further — count grows.
    advanceOriginMain(repoDir, 3);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(2);
    expect(state.staleBaseLastWarned?.coder?.count).toBe(8);
  });

  test("dedup: resets on round change — re-fires at same or growing count", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir, 1);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    // New round — same count should be allowed to re-fire.
    state.round = 2;
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(2);
    expect(state.staleBaseLastWarned?.coder?.round).toBe(2);
    expect(state.staleBaseLastWarned?.coder?.count).toBe(5);
  });

  test("dedup: re-arms after staleness decreases within same round (rebase → drift)", () => {
    // Scenario: warning fires at 10 commits (lastCount=10); coder rebases
    // mid-round so count drops to 0; origin/main advances again past the
    // threshold. The warning MUST re-fire even though the new count (5) is
    // below the previously-warned peak (10) — this is the workflow the
    // advisory is meant to protect.
    const { worktree, repoDir } = setupStaleRepo(10);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(state.staleBaseLastWarned?.coder?.count).toBe(10);

    // Simulate `git rebase origin/main` in the worktree — fast-forwards to
    // origin/main since the worktree branch has no commits of its own.
    Bun.spawnSync(["git", "rebase", "origin/main"], { cwd: worktree });
    // Sanity: worktree is now at origin/main (0 commits behind).
    const mb = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"], { cwd: worktree });
    const behind = Bun.spawnSync(
      ["git", "rev-list", "--count", `${String(mb.stdout).trim()}..origin/main`],
      { cwd: worktree },
    );
    expect(parseInt(String(behind.stdout).trim(), 10)).toBe(0);

    // Running warnStaleBase now should observe count=0 and re-arm the memo.
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1); // below threshold, no new warn
    expect(state.staleBaseLastWarned?.coder?.count).toBe(0); // re-armed

    // Origin drifts again past the threshold (5 commits).
    advanceOriginMain(repoDir, 5);
    warnStaleBase(state);
    // Must re-fire — without the re-arm, the gate `count <= lastCount` with
    // stale lastCount=10 would suppress the 5-commit warning.
    expect(countWarnings(emitSpy)).toBe(2);
    expect(state.staleBaseLastWarned?.coder?.count).toBe(5);
  });

  test("fetch timeout silently skipped (bounded phase-entry cost)", () => {
    // Tiny timeout guarantees the fetch subprocess is killed before it can
    // complete even against a local bare remote. Bun.spawnSync returns
    // exitCode=null + SIGTERM in that case; the `!== 0` guard must treat
    // that as "skip."
    const { worktree, repoDir } = setupStaleRepo(5);
    process.env.LUDICS_WARN_FETCH_TIMEOUT_MS = "1";
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(0);
    expect(state.staleBaseLastWarned).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // gh-ludics-409: reviewer-phase coverage + per-category dedup
  // ---------------------------------------------------------------------------

  test("gh-ludics-409: fires on entry to plan-review when staleness meets threshold", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    state.phase = "plan-review";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(state.staleBaseLastWarned?.reviewer?.count).toBe(5);
    expect(state.staleBaseLastWarned?.reviewer?.round).toBe(1);
    // Coder-category memo must remain untouched.
    expect(state.staleBaseLastWarned?.coder).toBeUndefined();
  });

  test("gh-ludics-409: fires on entry to review when staleness meets threshold", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    state.phase = "review";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(state.staleBaseLastWarned?.reviewer?.count).toBe(5);
    expect(state.staleBaseLastWarned?.coder).toBeUndefined();
  });

  test("gh-ludics-409: coder-category warning at plan does not suppress reviewer warning at review in same round", () => {
    const { worktree, repoDir } = setupStaleRepo(5);
    const state = stateFor(worktree, repoDir);
    state.phase = "plan";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(state.staleBaseLastWarned?.coder?.count).toBe(5);
    // Same round, same staleness, switch category. Reviewer entry must
    // re-fire — the dedup memo is per-category, not per-round.
    state.phase = "review";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(2);
    expect(state.staleBaseLastWarned?.reviewer?.count).toBe(5);
    // Coder entry survives unchanged.
    expect(state.staleBaseLastWarned?.coder?.count).toBe(5);
  });

  test("gh-ludics-409: reviewer-category memo re-arms on count-decrease within the round", () => {
    const { worktree, repoDir } = setupStaleRepo(10);
    const state = stateFor(worktree, repoDir);
    state.phase = "review";
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1);
    expect(state.staleBaseLastWarned?.reviewer?.count).toBe(10);

    // Coder rebases mid-round; staleness drops to 0.
    Bun.spawnSync(["git", "rebase", "origin/main"], { cwd: worktree });
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(1); // below threshold post-rebase
    expect(state.staleBaseLastWarned?.reviewer?.count).toBe(0); // re-armed

    // Origin drifts again past the threshold (5 commits, below the previous
    // peak of 10).
    advanceOriginMain(repoDir, 5);
    warnStaleBase(state);
    // Must re-fire — without the re-arm, `count <= lastCount` with stale
    // lastCount=10 would suppress the 5-commit warning.
    expect(countWarnings(emitSpy)).toBe(2);
    expect(state.staleBaseLastWarned?.reviewer?.count).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // gh-ludics-409: migrateState backfill for legacy persisted memo
  // ---------------------------------------------------------------------------

  test("gh-ludics-409: migrateState backfills legacy scalar memo into staleBaseLastWarned.coder and strips legacy keys", async () => {
    const { migrateState, defaultOrchestrationConfig } = await import("./state.ts");
    type StateLike = import("./state.ts").OrchestrationState;
    const legacy = {
      slot: 1, taskId: "t", mode: "pair", phase: "work",
      round: 3, mergeRound: 0, agents: [], agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: 0, startedAt: "x",
      projectDir: "/", rootWorktree: "/", peerSyncDir: "/",
      threadIds: {},
      // Legacy scalar fields (gh-ludics-374 shape, pre-409).
      staleBaseLastWarnedRound: 3,
      staleBaseLastWarnedCount: 7,
    } as unknown as StateLike;
    const migrated = migrateState(legacy, 1);
    // Backfill happened — coder-category entry populated.
    expect(migrated.staleBaseLastWarned?.coder?.round).toBe(3);
    expect(migrated.staleBaseLastWarned?.coder?.count).toBe(7);
    // Reviewer-category remains untouched.
    expect(migrated.staleBaseLastWarned?.reviewer).toBeUndefined();
    // Legacy keys stripped — otherwise persistState would write them back
    // to disk and migrateState would re-run on every read.
    expect((migrated as unknown as Record<string, unknown>).staleBaseLastWarnedRound).toBeUndefined();
    expect((migrated as unknown as Record<string, unknown>).staleBaseLastWarnedCount).toBeUndefined();
  });

  test("gh-ludics-409: migrateState leaves staleBaseLastWarned untouched when both legacy keys absent", async () => {
    // Negative control: if the backfill ran unconditionally, the previous
    // test would still pass; this guards against that false positive by
    // confirming the migration is gated on legacy-key presence.
    const { migrateState, defaultOrchestrationConfig } = await import("./state.ts");
    type StateLike = import("./state.ts").OrchestrationState;
    const fresh = {
      slot: 1, taskId: "t", mode: "pair", phase: "work",
      round: 1, mergeRound: 0, agents: [], agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: 0, startedAt: "x",
      projectDir: "/", rootWorktree: "/", peerSyncDir: "/",
      threadIds: {},
    } as unknown as StateLike;
    const migrated = migrateState(fresh, 1);
    expect(migrated.staleBaseLastWarned).toBeUndefined();
  });

  test("gh-ludics-409: migrateState round-trips through JSON and preserves backfill", async () => {
    // Round-trip fidelity: serialize a legacy persisted state, parse it
    // back, run migrateState, and confirm the new shape persists through
    // a second JSON round-trip without re-introducing the legacy keys.
    const { migrateState, defaultOrchestrationConfig } = await import("./state.ts");
    type StateLike = import("./state.ts").OrchestrationState;
    const legacyOnDisk = JSON.stringify({
      slot: 1, taskId: "t", mode: "pair", phase: "work",
      round: 2, mergeRound: 0, agents: [], agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: 0, startedAt: "x",
      projectDir: "/", rootWorktree: "/", peerSyncDir: "/",
      threadIds: {},
      staleBaseLastWarnedRound: 2,
      staleBaseLastWarnedCount: 9,
    });
    const parsed = JSON.parse(legacyOnDisk) as StateLike;
    const migrated = migrateState(parsed, 1);
    expect(migrated.staleBaseLastWarned?.coder?.count).toBe(9);
    // Second round-trip: the migrated shape persists cleanly, legacy keys gone.
    const reparsed = JSON.parse(JSON.stringify(migrated)) as StateLike;
    expect(reparsed.staleBaseLastWarned?.coder?.round).toBe(2);
    expect(reparsed.staleBaseLastWarned?.coder?.count).toBe(9);
    expect((reparsed as unknown as Record<string, unknown>).staleBaseLastWarnedRound).toBeUndefined();
    expect((reparsed as unknown as Record<string, unknown>).staleBaseLastWarnedCount).toBeUndefined();
  });
});
