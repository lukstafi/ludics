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

/** Add a commit on main in the given repo and refresh origin/main to it. */
function advanceOriginMain(repoDir: string, n: number = 1): void {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repoDir, `main-advance-${Date.now()}-${i}.txt`), `c${i}`);
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-m", `advance-${i}`], { cwd: repoDir });
  }
  Bun.spawnSync(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir });
}

/** Fork a worktree off the current origin/main and leave HEAD behind. */
function forkWorktree(repoDir: string): string {
  // Check out a detached branch at current HEAD so main can advance past us.
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
    env = envSandbox(["LUDICS_WARN_BASE_STALENESS_THRESHOLD"]);
  });
  afterEach(() => {
    env.restore();
    emitSpy.mockRestore();
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  function setupStaleRepo(advanceCount: number): { worktree: string; repoDir: string } {
    const repoDir = makeGitRepo();
    cleanup.push(join(repoDir, ".."));
    const worktree = forkWorktree(repoDir);
    advanceOriginMain(repoDir, advanceCount);
    return { worktree, repoDir };
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
    expect(state.staleBaseLastWarnedCount).toBe(5);
    expect(state.staleBaseLastWarnedRound).toBe(1);
  });

  test("no warning when below threshold (happy path)", () => {
    const { worktree, repoDir } = setupStaleRepo(3);
    const state = stateFor(worktree, repoDir);
    warnStaleBase(state);
    expect(countWarnings(emitSpy)).toBe(0);
    // Memo reset to 0 for current round but no warning fired.
    expect(state.staleBaseLastWarnedCount).toBe(0);
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
    expect(state.staleBaseLastWarnedRound).toBeUndefined();

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
    expect(state.staleBaseLastWarnedCount).toBe(8);
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
    expect(state.staleBaseLastWarnedRound).toBe(2);
    expect(state.staleBaseLastWarnedCount).toBe(5);
  });
});
