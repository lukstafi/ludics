import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { orchDiff, runOrchestrationCli } from "./index.ts";
import {
  defaultOrchestrationConfig,
  initAgentRuntimeState,
  orchestrationDir,
  stateFilePath,
  type AgentConfig,
  type OrchestrationState,
} from "./state.ts";

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "--initial-branch", "main"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  Bun.spawnSync(["git", "add", "seed.txt"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "commit", "-m", "seed"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
}

function addCommits(dir: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `line ${i}\n`);
    Bun.spawnSync(["git", "add", `f${i}.txt`], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "commit", "-m", `add f${i}`], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  }
}

function makeState(slot: number, agents: AgentConfig[]): OrchestrationState {
  return {
    slot,
    taskId: "gh-ludics-374-test",
    mode: "pair",
    phase: "review",
    round: 1,
    mergeRound: 0,
    agents,
    agentStates: initAgentRuntimeState(agents.map((a) => a.name)),
    config: defaultOrchestrationConfig(),
    phaseStartedAt: 0,
    startedAt: "2026-04-25T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project",
    peerSyncDir: "/tmp/peer-sync",
    threadIds: {},
  };
}

describe("orchDiff / runOrchestrationCli diff", () => {
  let harness: string;
  let tmpRoot: string;
  const prevHarness = process.env.LUDICS_HARNESS_DIR;
  let captured: string[];
  const capture = (msg: string): void => {
    captured.push(msg);
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ludics-orch-diff-"));
    harness = join(tmpRoot, "harness");
    mkdirSync(orchestrationDir(harness), { recursive: true });
    process.env.LUDICS_HARNESS_DIR = harness;
    captured = [];
  });

  afterEach(() => {
    if (prevHarness === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = prevHarness;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeState(state: OrchestrationState): void {
    writeFileSync(stateFilePath(state.slot, harness), JSON.stringify(state));
  }

  test("happy path: prints per-agent git log <base>..HEAD --stat output", () => {
    if (!Bun.which("git")) return;
    const repo = join(tmpRoot, "wt-coder");
    makeRepo(repo);
    addCommits(repo, 2);

    writeState(
      makeState(7, [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
      ]),
    );

    orchDiff(7, undefined, capture);
    const out = captured.join("\n");
    expect(out).toContain("=== agent: coder (worktree: " + repo + ") ===");
    expect(out).toContain("add f1");
    expect(out).toContain("add f2");
    expect(out).toContain("f1.txt");
  });

  test("mixed-result: valid agent prints, invalid agent reports, partial-failure error thrown", () => {
    if (!Bun.which("git")) return;
    const repo = join(tmpRoot, "wt-valid");
    makeRepo(repo);
    addCommits(repo, 1);

    writeState(
      makeState(8, [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: join(tmpRoot, "does-not-exist") },
      ]),
    );

    expect(() => orchDiff(8, undefined, capture)).toThrow(
      /orch diff: one or more agents failed/,
    );
    const out = captured.join("\n");
    expect(out).toContain("=== agent: coder (worktree: " + repo + ") ===");
    expect(out).toContain("add f1");
    expect(out).toContain("=== agent: reviewer (worktree: " + join(tmpRoot, "does-not-exist") + ") ===");
    expect(out).toContain("(worktree missing on disk)");
  });

  test("empty-ahead: HEAD equals origin/main renders as no-commits-ahead without throwing", () => {
    if (!Bun.which("git")) return;
    const repo = join(tmpRoot, "wt-empty");
    makeRepo(repo);
    // No extra commits — HEAD == origin/main.

    writeState(
      makeState(9, [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
      ]),
    );

    orchDiff(9, undefined, capture);
    const out = captured.join("\n");
    expect(out).toContain("(no commits ahead of origin/main)");
  });

  test("not-a-git-repo: reports under the agent header and throws partial-failure", () => {
    const plainDir = join(tmpRoot, "wt-plain");
    mkdirSync(plainDir, { recursive: true });

    writeState(
      makeState(10, [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: plainDir },
      ]),
    );

    expect(() => orchDiff(10, undefined, capture)).toThrow(
      /orch diff: one or more agents failed/,
    );
    expect(captured.join("\n")).toContain("(not a git repository)");
  });

  test("missing slot argument throws slot-number-required", async () => {
    await expect(runOrchestrationCli(["diff"])).rejects.toThrow(/slot number required/);
  });

  test("no state for slot throws orchestration-state-not-found", async () => {
    await expect(runOrchestrationCli(["diff", "999"])).rejects.toThrow(
      /orchestration state not found for slot 999/,
    );
  });
});
