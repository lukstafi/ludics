import { describe, expect, test, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { autoCommitAgent, autoCommitAllAgents } from "./runner.ts";
import { makeState } from "./runner.test-helpers.ts";

setDefaultTimeout(20_000);

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  writeFileSync(join(dir, "README.md"), "init\n");
  Bun.spawnSync(["git", "add", "README.md"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
}

function gitLastCommitMsg(dir: string): string {
  return Bun.spawnSync(["git", "log", "--format=%s", "-1"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  }).stdout.toString().trim();
}

function gitCommitCount(dir: string): number {
  const out = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  }).stdout.toString().trim();
  return parseInt(out, 10);
}
describe("autoCommitAgent", () => {
  afterEach(() => {
    rmSync(join(import.meta.dir, ".test-tmp-autocommit"), { recursive: true, force: true });
  });

  test("commit message format: '[round N] <statusMessage>'", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "msg-fmt");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      round: 3,
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "implemented tensor syntax", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 3] implemented tensor syntax");
  });

  test("falls back to slotTitle when statusMessage is empty", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "title-fallback");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "review",
      round: 2,
      slotTitle: "add widget support",
      agents: [{ name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 2] add widget support");
  });

  test("falls back to WIP when both statusMessage and slotTitle are empty", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "wip-fallback");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "review",
      agents: [{ name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 1] WIP");
  });

  test("collapses multiline statusMessage to single line", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "multiline");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "line1\nline2\n  line3", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitLastCommitMsg(repo)).toBe("[round 1] line1 line2 line3");
  });

  test("no-op on clean worktree", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "clean");
    initGitRepo(repo);

    const state = makeState({
      phase: "work",
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo }],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "done", prUrl: null, interrupted: false },
      },
    });

    autoCommitAgent(state, state.agents[0]!, false);
    expect(gitCommitCount(repo)).toBe(1); // only the init commit
  });
});

describe("autoCommitAllAgents", () => {
  afterEach(() => {
    rmSync(join(import.meta.dir, ".test-tmp-autocommit"), { recursive: true, force: true });
  });

  test("pair mode: commits once for shared worktree", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "pair-dedup");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      mode: "pair",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo },
      ],
      agentStates: {
        coder: { status: "done", statusEpoch: 200, statusMessage: "coded it", prUrl: null, interrupted: false },
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "reviewed", prUrl: null, interrupted: false },
      },
    });

    autoCommitAllAgents(state, state.agents, false);
    // Only 1 new commit (init + auto-commit = 2 total), not 2 new commits
    expect(gitCommitCount(repo)).toBe(2);
  });

  test("pair mode: attributes to agent with newest statusEpoch", () => {
    if (!Bun.which("git")) return;
    const repo = join(import.meta.dir, ".test-tmp-autocommit", "pair-attr");
    initGitRepo(repo);
    writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");

    const state = makeState({
      phase: "work",
      mode: "pair",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo },
      ],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "coded", prUrl: null, interrupted: false },
        reviewer: { status: "done", statusEpoch: 200, statusMessage: "reviewed it", prUrl: null, interrupted: false },
      },
    });

    autoCommitAllAgents(state, state.agents, false);
    // Reviewer has higher epoch → commit attributed to reviewer
    expect(gitLastCommitMsg(repo)).toBe("[round 1] reviewed it");
  });

  test("duo mode: commits independently per worktree", () => {
    if (!Bun.which("git")) return;
    const repo1 = join(import.meta.dir, ".test-tmp-autocommit", "duo-1");
    const repo2 = join(import.meta.dir, ".test-tmp-autocommit", "duo-2");
    initGitRepo(repo1);
    initGitRepo(repo2);
    writeFileSync(join(repo1, "code.ts"), "coder work\n");
    writeFileSync(join(repo2, "review.md"), "reviewer notes\n");

    const state = makeState({
      phase: "work",
      mode: "duo",
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo1 },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: repo2 },
      ],
      agentStates: {
        coder: { status: "done", statusEpoch: 100, statusMessage: "coded", prUrl: null, interrupted: false },
        reviewer: { status: "done", statusEpoch: 100, statusMessage: "reviewed", prUrl: null, interrupted: false },
      },
    });

    autoCommitAllAgents(state, state.agents, false);
    expect(gitCommitCount(repo1)).toBe(2);
    expect(gitCommitCount(repo2)).toBe(2);
    expect(gitLastCommitMsg(repo1)).toBe("[round 1] coded");
    expect(gitLastCommitMsg(repo2)).toBe("[round 1] reviewed");
  });
});

// ===========================================================================
// Snapshot reconciliation for stuck dispatched lifecycles
// ===========================================================================

