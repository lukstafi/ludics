import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { orchDiff, orchOnStop, runOrchestrationCli } from "./index.ts";
import { makeTmpDir, makePeerSyncDir, setupOrchTestState } from "./runner.test-helpers.ts";
import { readStopHookRecord } from "./peer-sync.ts";

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

describe("orchDiff / runOrchestrationCli diff", () => {
  test("happy path: prints per-agent git log <base>..HEAD --stat output", () => {
    if (!Bun.which("git")) return;
    const tmpRoot = makeTmpDir();
    const repo = join(tmpRoot, "wt-coder");
    makeRepo(repo);
    addCommits(repo, 2);

    const { cleanup } = setupOrchTestState({
      slot: 7,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
      ],
      phase: "review",
      taskId: "gh-ludics-374-test",
      tmpRoot,
    });
    try {
      const captured: string[] = [];
      orchDiff(7, undefined, (msg) => captured.push(msg));
      const out = captured.join("\n");
      expect(out).toContain("=== agent: coder (worktree: " + repo + ") ===");
      expect(out).toContain("add f1");
      expect(out).toContain("add f2");
      expect(out).toContain("f1.txt");
    } finally {
      cleanup();
    }
  });

  test("mixed-result: valid agent prints, invalid agent reports, partial-failure error thrown", () => {
    if (!Bun.which("git")) return;
    const tmpRoot = makeTmpDir();
    const repo = join(tmpRoot, "wt-valid");
    makeRepo(repo);
    addCommits(repo, 1);
    const missing = join(tmpRoot, "does-not-exist");

    const { cleanup } = setupOrchTestState({
      slot: 8,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
        { name: "reviewer", provider: "claude-code", role: "reviewer", model: "opus-4", branch: "main", worktreePath: missing },
      ],
      phase: "review",
      taskId: "gh-ludics-374-test",
      tmpRoot,
    });
    try {
      const captured: string[] = [];
      const capture = (msg: string): void => { captured.push(msg); };
      expect(() => orchDiff(8, undefined, capture)).toThrow(
        /orch diff: one or more agents failed/,
      );
      const out = captured.join("\n");
      expect(out).toContain("=== agent: coder (worktree: " + repo + ") ===");
      expect(out).toContain("add f1");
      expect(out).toContain("=== agent: reviewer (worktree: " + missing + ") ===");
      expect(out).toContain("(worktree missing on disk)");
    } finally {
      cleanup();
    }
  });

  test("master-based repo without origin: resolves base via local refs/heads/master", () => {
    if (!Bun.which("git")) return;
    const tmpRoot = makeTmpDir();
    const repo = join(tmpRoot, "wt-master");
    // Master-based repo, no origin remote at all.
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "--initial-branch", "master"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    Bun.spawnSync(["git", "add", "seed.txt"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "commit", "-m", "seed"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    // Create a feature branch with one commit ahead of master.
    Bun.spawnSync(["git", "checkout", "-b", "feat"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    Bun.spawnSync(["git", "add", "feature.txt"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "commit", "-m", "add feature"], { cwd: repo, stdout: "pipe", stderr: "pipe" });

    const { cleanup } = setupOrchTestState({
      slot: 11,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "feat", worktreePath: repo },
      ],
      phase: "review",
      taskId: "gh-ludics-374-test",
      tmpRoot,
    });
    try {
      const captured: string[] = [];
      orchDiff(11, undefined, (msg) => captured.push(msg));
      const out = captured.join("\n");
      // Resolution cascaded past origin/upstream (both absent) to local master.
      expect(out).toContain("add feature");
      expect(out).toContain("feature.txt");
      // Must NOT have silently tried `main..HEAD` and failed.
      expect(out).not.toContain("git log failed");
    } finally {
      cleanup();
    }
  });

  test("empty-ahead: HEAD equals origin/main renders as no-commits-ahead without throwing", () => {
    if (!Bun.which("git")) return;
    const tmpRoot = makeTmpDir();
    const repo = join(tmpRoot, "wt-empty");
    makeRepo(repo);
    // No extra commits — HEAD == origin/main.

    const { cleanup } = setupOrchTestState({
      slot: 9,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: repo },
      ],
      phase: "review",
      taskId: "gh-ludics-374-test",
      tmpRoot,
    });
    try {
      const captured: string[] = [];
      orchDiff(9, undefined, (msg) => captured.push(msg));
      const out = captured.join("\n");
      expect(out).toContain("(no commits ahead of origin/main)");
    } finally {
      cleanup();
    }
  });

  test("not-a-git-repo: reports under the agent header and throws partial-failure", () => {
    const tmpRoot = makeTmpDir();
    const plainDir = join(tmpRoot, "wt-plain");
    mkdirSync(plainDir, { recursive: true });

    const { cleanup } = setupOrchTestState({
      slot: 10,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: plainDir },
      ],
      phase: "review",
      taskId: "gh-ludics-374-test",
      tmpRoot,
    });
    try {
      const captured: string[] = [];
      const capture = (msg: string): void => { captured.push(msg); };
      expect(() => orchDiff(10, undefined, capture)).toThrow(
        /orch diff: one or more agents failed/,
      );
      expect(captured.join("\n")).toContain("(not a git repository)");
    } finally {
      cleanup();
    }
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

describe("runOrchestrationCli unknown-subcommand listing (gh-ludics-438)", () => {
  // Invariant: the default-case error names every public subcommand and
  // excludes internal entry points. `run-internal` (self-relaunch) and
  // `on-stop` (Stop-hook entry) stay callable but are absent from public
  // help — mirrors INTERNAL_HIDDEN.orch in scripts/lint-cli-subcommands.ts
  // and the templates/hooks/ludics-on-stop.sh:106 caller.
  //
  // Harness condition: invoke runOrchestrationCli with a sentinel sub that
  // is not a real case label and not the empty default; the dispatcher
  // takes the unknown-subcommand branch.

  test("emits canonical (use: ...) listing and excludes internal entries", async () => {
    let err: Error | null = null;
    try {
      await runOrchestrationCli(["__bogus__"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toBe(
      "unknown orch subcommand: __bogus__ (use: status, confirm, interrupt, skip, log, diff)",
    );
    // Both internal entries must be absent from user-facing help.
    const useMatch = msg.match(/\(use: ([^)]*)\)/);
    expect(useMatch).not.toBeNull();
    const useEntries = useMatch![1]!.split(/,\s*/);
    expect(useEntries).not.toContain("run-internal");
    expect(useEntries).not.toContain("on-stop");
  });
});

// gh-ludics-589 (Part C): a blank cwd must be handled gracefully by orchOnStop —
// no `usage: ...` + exit(1) that blocks phase advancement. A blank cwd from ANY
// cause (the shell hook also defaults it to $PWD as defense in depth) falls
// through to env/marker peer-sync resolution + env/status agent attribution.
describe("orchOnStop blank-cwd handling (gh-ludics-589)", () => {
  const ORIG_PSD = process.env.LUDICS_PEER_SYNC_DIR;
  const ORIG_AGENT = process.env.LUDICS_AGENT_NAME;

  afterEach(() => {
    if (ORIG_PSD === undefined) delete process.env.LUDICS_PEER_SYNC_DIR;
    else process.env.LUDICS_PEER_SYNC_DIR = ORIG_PSD;
    if (ORIG_AGENT === undefined) delete process.env.LUDICS_AGENT_NAME;
    else process.env.LUDICS_AGENT_NAME = ORIG_AGENT;
  });

  test("orchOnStop([]) / orchOnStop([\"\"]) return without usage error or process.exit", () => {
    delete process.env.LUDICS_PEER_SYNC_DIR; // nothing resolves → silent no-op
    delete process.env.LUDICS_AGENT_NAME;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Invariant: a blank cwd never reaches `process.exit(1)` / the usage error.
      // Mutation: restoring `if (!cwd) { usage; process.exit(1); }` makes exitSpy
      // fire (and throw) here.
      expect(() => orchOnStop([])).not.toThrow();
      expect(() => orchOnStop([""])).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
      const usagePrinted = errSpy.mock.calls.some(c => String(c[0] ?? "").includes("usage: ludics orch on-stop"));
      expect(usagePrinted).toBe(false);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test("blank cwd still attributes via LUDICS_AGENT_NAME and writes a stop record", () => {
    // Harness condition: a live orchestration (phase + token + worktrees) with the
    // agent identified only by env — exactly the slotB case where the worktree-cwd
    // match is unavailable because cwd is blank.
    const dir = makePeerSyncDir(
      { root: "/wt/root", coder: "/wt/coder", reviewer: "/wt/reviewer" },
      { coder: "working" },
    );
    process.env.LUDICS_PEER_SYNC_DIR = dir;
    process.env.LUDICS_AGENT_NAME = "coder";

    // Invariant: with a blank cwd, env attribution fires and a stop record lands,
    // so the runner sees turn completion. Mutation: the old exit(1) on blank cwd
    // would abort before any attribution and no record would be written.
    orchOnStop([""]);
    const rec = readStopHookRecord(dir, "coder");
    expect(rec).not.toBeNull();
    expect(rec!.agent).toBe("coder");
    expect(rec!.phaseToken).toBe("phase-test-token");
  });
});
