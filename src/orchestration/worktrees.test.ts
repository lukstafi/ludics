import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { autoCommitWorktree, cleanupWorktrees, createWorktrees, deleteBranches, ensureGitExcludes, GIT_EXCLUDE_ENTRIES, orchBranchName, orchWorktreeStem, removeWorktreeByPath, symlinkPeerSync } from "./worktrees.ts";

const TMP = join(import.meta.dir, ".test-tmp-worktrees");

function run(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || cmd.join(" "));
  }
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("worktrees", () => {
  test("creates and links orchestration worktrees", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    run(["git", "add", "README.md"], repo);
    run(["git", "commit", "-m", "init"], repo);

    const setup = createWorktrees(repo, "feat", [{ name: "agent1" }, { name: "agent2" }], "main", 3);
    expect(existsSync(setup.rootWorktree)).toBe(true);
    expect(existsSync(setup.agentWorktrees.agent1!)).toBe(true);

    mkdirSync(setup.peerSyncDir, { recursive: true });
    symlinkPeerSync(setup.peerSyncDir, setup.agentWorktrees);
    const link = join(setup.agentWorktrees.agent1!, ".peer-sync");
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    cleanupWorktrees(repo, "feat", [{ name: "agent1" }, { name: "agent2" }], 3);
  });

  test("solo mode: single agent shares the root worktree (no sibling created)", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-solo");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    run(["git", "add", "README.md"], repo);
    run(["git", "commit", "-m", "init"], repo);

    const setup = createWorktrees(repo, "solo-feat", [{ name: "coder" }], "main", 5, "solo");
    expect(existsSync(setup.rootWorktree)).toBe(true);
    // Coder's worktree is the root worktree (pair-style layout reused for solo)
    expect(setup.agentWorktrees.coder).toBe(setup.rootWorktree);
    // No per-agent sibling worktree: the duo-style path "<stem>-coder" must NOT exist.
    const siblingPath = `${setup.rootWorktree}-coder`;
    expect(existsSync(siblingPath)).toBe(false);
    // Coder's branch equals the root branch
    expect(setup.branches.coder).toBe(setup.branches.root);

    // symlinkPeerSync deduplicates; only one .peer-sync symlink should exist (root)
    mkdirSync(setup.peerSyncDir, { recursive: true });
    symlinkPeerSync(setup.peerSyncDir, setup.agentWorktrees);
    expect(existsSync(join(setup.rootWorktree, ".peer-sync"))).toBe(true);

    cleanupWorktrees(repo, "solo-feat", [{ name: "coder" }], 5, "solo");
  });
});

// ---------------------------------------------------------------------------
// autoCommitWorktree
// ---------------------------------------------------------------------------

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(["git", "init", "-b", "main"], dir);
  run(["git", "config", "user.email", "test@example.com"], dir);
  run(["git", "config", "user.name", "Test User"], dir);
  writeFileSync(join(dir, "README.md"), "init\n");
  run(["git", "add", "README.md"], dir);
  run(["git", "commit", "-m", "init"], dir);
}

function gitLog(dir: string, format: string = "%s"): string {
  const result = Bun.spawnSync(["git", "log", `--format=${format}`], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  return result.stdout.toString().trim();
}

function gitLogCount(dir: string): number {
  return gitLog(dir, "%H").split("\n").filter(Boolean).length;
}

describe("autoCommitWorktree", () => {
  test("commits when worktree has uncommitted tracked changes", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-dirty");
    initRepo(repo);
    writeFileSync(join(repo, "README.md"), "modified\n");

    const result = autoCommitWorktree(repo, "test: dirty commit");
    expect(result.dirty).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.commitSha).toMatch(/^[a-f0-9]+$/);
    expect(result.error).toBeUndefined();
    expect(gitLog(repo, "%s").split("\n")[0]).toBe("test: dirty commit");
    expect(gitLogCount(repo)).toBe(2);
  });

  test("commits untracked files", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-untracked");
    initRepo(repo);
    writeFileSync(join(repo, "newfile.ts"), "export const x = 1;\n");

    const result = autoCommitWorktree(repo, "test: untracked");
    expect(result.dirty).toBe(true);
    expect(result.committed).toBe(true);
    // Verify the new file is in the commit
    const showStat = Bun.spawnSync(["git", "show", "--stat", "--format=", "HEAD"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(showStat).toContain("newfile.ts");
  });

  test("no-op when worktree is clean", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-clean");
    initRepo(repo);

    const result = autoCommitWorktree(repo, "should not appear");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(gitLogCount(repo)).toBe(1);
  });

  test("excludes .peer-sync from staging and dirty check", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-exclude-peer-sync");
    initRepo(repo);
    ensureGitExcludes(repo);
    mkdirSync(join(repo, ".peer-sync"), { recursive: true });
    writeFileSync(join(repo, ".peer-sync", "coder.status"), "done|123|finished\n");

    const result = autoCommitWorktree(repo, "should not commit");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
  });

  test("excludes .ludics-orchestration.json from staging", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-exclude-marker");
    initRepo(repo);
    ensureGitExcludes(repo);
    writeFileSync(join(repo, ".ludics-orchestration.json"), '{"agentName":"coder"}\n');

    const result = autoCommitWorktree(repo, "should not commit");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
  });

  test("excludes .claude/ from staging", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-exclude-claude");
    initRepo(repo);
    ensureGitExcludes(repo);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.local.json"), '{"hooks":{}}\n');

    const result = autoCommitWorktree(repo, "should not commit");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
  });

  test("commits real files while excluding orchestration files", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-mixed");
    initRepo(repo);
    ensureGitExcludes(repo);
    // Real code change
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "main.ts"), "export const y = 2;\n");
    // Orchestration files that should be excluded
    mkdirSync(join(repo, ".peer-sync"), { recursive: true });
    writeFileSync(join(repo, ".peer-sync", "coder.status"), "done|123|ok\n");
    writeFileSync(join(repo, ".ludics-orchestration.json"), '{"agentName":"coder"}\n');

    const result = autoCommitWorktree(repo, "mixed changes");
    expect(result.dirty).toBe(true);
    expect(result.committed).toBe(true);

    // Verify the real file is in the commit
    const showStat = Bun.spawnSync(["git", "show", "--stat", "--format=", "HEAD"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(showStat).toContain("src/main.ts");
    expect(showStat).not.toContain(".peer-sync");
    expect(showStat).not.toContain(".ludics-orchestration.json");
  });

  test("returns error on invalid directory", () => {
    const result = autoCommitWorktree("/nonexistent/path/xxxxx", "msg");
    expect(result.committed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("failed");
  });

  test("idempotent: second call on clean tree is no-op", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-idempotent");
    initRepo(repo);
    writeFileSync(join(repo, "file.ts"), "content\n");

    const r1 = autoCommitWorktree(repo, "first");
    expect(r1.committed).toBe(true);

    const r2 = autoCommitWorktree(repo, "second");
    expect(r2.dirty).toBe(false);
    expect(r2.committed).toBe(false);
    expect(gitLogCount(repo)).toBe(2); // init + first, no second
  });

  test("ignores .agents and node_modules via .git/info/exclude", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-expanded-excludes");
    initRepo(repo);
    ensureGitExcludes(repo);
    mkdirSync(join(repo, ".agents"), { recursive: true });
    writeFileSync(join(repo, ".agents", "marker"), "1\n");
    mkdirSync(join(repo, ".agent-sessions"), { recursive: true });
    writeFileSync(join(repo, ".agent-sessions", "s1"), "data\n");
    // Create a node_modules symlink (like createWorktrees does)
    try { symlinkSync("/tmp", join(repo, "node_modules")); } catch { /* */ }

    const result = autoCommitWorktree(repo, "should not commit");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
  });

  test("excludes already-tracked orchestration files from commits", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-tracked-orch");
    initRepo(repo);
    // Simulate orchestration files that were tracked before ensureGitExcludes
    mkdirSync(join(repo, ".agents"), { recursive: true });
    writeFileSync(join(repo, ".agents", "marker"), "1\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "track agents"], repo);
    // Now set up excludes (like createWorktrees would)
    ensureGitExcludes(repo);
    // Modify the tracked orchestration file
    writeFileSync(join(repo, ".agents", "marker"), "2\n");

    const result = autoCommitWorktree(repo, "should not commit");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
    expect(gitLogCount(repo)).toBe(2); // init + track agents, no new commit
  });

  test("excludes _build_review* dirs while committing real changes", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-build-review");
    initRepo(repo);
    ensureGitExcludes(repo);
    // Build-review artifacts at root and nested — both should be excluded
    mkdirSync(join(repo, "_build_review"), { recursive: true });
    writeFileSync(join(repo, "_build_review", "artifact.o"), "obj\n");
    mkdirSync(join(repo, "_build_review_round3"), { recursive: true });
    writeFileSync(join(repo, "_build_review_round3", "artifact.o"), "obj\n");
    mkdirSync(join(repo, "sub", "_build_review_round3"), { recursive: true });
    writeFileSync(join(repo, "sub", "_build_review_round3", "nested.o"), "obj\n");
    // Real code change that should be committed
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "lib.ml"), "let () = ()\n");

    const result = autoCommitWorktree(repo, "real changes only");
    expect(result.dirty).toBe(true);
    expect(result.committed).toBe(true);

    const showStat = Bun.spawnSync(["git", "show", "--stat", "--format=", "HEAD"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(showStat).toContain("src/lib.ml");
    expect(showStat).not.toContain("_build_review");
  });
});

// ---------------------------------------------------------------------------
// ensureGitExcludes
// ---------------------------------------------------------------------------

function readExcludeFile(repoPath: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
    cwd: repoPath, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  const gitDir = result.stdout.toString().trim();
  const resolved = gitDir.startsWith("/") ? gitDir : join(repoPath, gitDir);
  const excludePath = join(resolved, "info", "exclude");
  try { return readFileSync(excludePath, "utf-8"); } catch { return ""; }
}

describe("ensureGitExcludes", () => {
  test("writes all entries to a repo's info/exclude", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-basic");
    initRepo(repo);

    ensureGitExcludes(repo);

    const content = readExcludeFile(repo);
    for (const entry of GIT_EXCLUDE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  test("idempotent: calling twice does not duplicate entries", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-idempotent");
    initRepo(repo);

    ensureGitExcludes(repo);
    ensureGitExcludes(repo);

    const content = readExcludeFile(repo);
    for (const entry of GIT_EXCLUDE_ENTRIES) {
      const count = content.split("\n").filter((l: string) => l === entry).length;
      expect(count).toBe(1);
    }
  });

  test("preserves existing exclude content", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-preserve");
    initRepo(repo);
    writeFileSync(join(repo, ".git", "info", "exclude"), "my-custom-ignore\n");

    ensureGitExcludes(repo);

    const content = readExcludeFile(repo);
    expect(content).toContain("my-custom-ignore");
    for (const entry of GIT_EXCLUDE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  test("createWorktrees writes excludes to projectDir and all worktrees", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-excludes");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    run(["git", "add", "README.md"], repo);
    run(["git", "commit", "-m", "init"], repo);

    const setup = createWorktrees(repo, "excl", [{ name: "a1" }, { name: "a2" }], "main", 7);

    // Check projectDir
    const mainContent = readExcludeFile(repo);
    for (const entry of GIT_EXCLUDE_ENTRIES) {
      expect(mainContent).toContain(entry);
    }

    // Check root worktree
    const rootContent = readExcludeFile(setup.rootWorktree);
    for (const entry of GIT_EXCLUDE_ENTRIES) {
      expect(rootContent).toContain(entry);
    }

    // Check agent worktrees
    for (const wt of Object.values(setup.agentWorktrees)) {
      const content = readExcludeFile(wt);
      for (const entry of GIT_EXCLUDE_ENTRIES) {
        expect(content).toContain(entry);
      }
    }

    cleanupWorktrees(repo, "excl", [{ name: "a1" }, { name: "a2" }], 7);
  });

  test("git add -A in a worktree ignores orchestration files", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-gitadd");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    run(["git", "add", "README.md"], repo);
    run(["git", "commit", "-m", "init"], repo);

    const setup = createWorktrees(repo, "ga", [{ name: "c1" }], "main", 8);
    const wt = setup.agentWorktrees.c1!;

    // Create orchestration files
    writeFileSync(join(wt, ".ludics-orchestration.json"), "{}");
    mkdirSync(join(wt, ".peer-sync"), { recursive: true });
    writeFileSync(join(wt, ".peer-sync", "foo"), "x");
    mkdirSync(join(wt, ".claude"), { recursive: true });
    writeFileSync(join(wt, ".claude", "settings.json"), "{}");
    mkdirSync(join(wt, ".agents"), { recursive: true });
    writeFileSync(join(wt, ".agents", "marker"), "1");
    mkdirSync(join(wt, ".agent-sessions"), { recursive: true });
    writeFileSync(join(wt, ".agent-sessions", "s1"), "1");
    try { symlinkSync("/tmp", join(wt, "node_modules")); } catch { /* */ }

    // Create a real source file
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "main.ts"), "export const x = 1;\n");

    run(["git", "add", "-A"], wt);
    const status = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: wt, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();

    expect(status).toContain("src/main.ts");
    expect(status).not.toContain(".peer-sync");
    expect(status).not.toContain(".ludics-orchestration.json");
    expect(status).not.toContain(".claude");
    expect(status).not.toContain(".agents");
    expect(status).not.toContain(".agent-sessions");
    expect(status).not.toContain("node_modules");

    cleanupWorktrees(repo, "ga", [{ name: "c1" }], 8);
  });
});

// ---------------------------------------------------------------------------
// cleanupWorktrees resilience
// ---------------------------------------------------------------------------

describe("cleanupWorktrees resilience", () => {
  test("does not throw when projectDir does not exist", () => {
    expect(() =>
      cleanupWorktrees("/nonexistent/path/xxxxx", "task-1", [{ name: "a1" }, { name: "a2" }], 1),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// orchBranchName
// ---------------------------------------------------------------------------

describe("orchBranchName", () => {
  test("standard case with slot", () => {
    expect(orchBranchName("task-abc", 2, "root")).toBe("ludics/task-abc-s2/root");
  });

  test("no slot", () => {
    expect(orchBranchName("task-abc", undefined, "coder")).toBe("ludics/task-abc/coder");
  });

  test("GitHub issue ID", () => {
    expect(orchBranchName("gh-ludics-42", 1, "reviewer")).toBe("ludics/gh-ludics-42-s1/reviewer");
  });

  test("special characters in taskId are slugified", () => {
    expect(orchBranchName("My Task!@#$", undefined, "root")).toBe("ludics/my-task/root");
  });

  test("long task ID preserves content", () => {
    const longId = "task-" + "a".repeat(100);
    const result = orchBranchName(longId, 3, "coder");
    expect(result).toStartWith("ludics/task-");
    expect(result).toEndWith("-s3/coder");
  });

  test("suffix is used verbatim", () => {
    expect(orchBranchName("t1", 1, "my-agent")).toBe("ludics/t1-s1/my-agent");
  });
});

// ---------------------------------------------------------------------------
// orchWorktreeStem
// ---------------------------------------------------------------------------

describe("orchWorktreeStem", () => {
  test("standard case with slot", () => {
    expect(orchWorktreeStem("myrepo", "task-abc", 2)).toBe("myrepo-task-abc-s2");
  });

  test("without slot", () => {
    expect(orchWorktreeStem("myrepo", "task-abc")).toBe("myrepo-task-abc");
  });

  test("slot explicitly undefined", () => {
    expect(orchWorktreeStem("myrepo", "task-abc", undefined)).toBe("myrepo-task-abc");
  });

  test("special characters in taskId", () => {
    expect(orchWorktreeStem("repo", "My Task!@#$", 1)).toBe("repo-my-task-s1");
  });
});

// ---------------------------------------------------------------------------
// removeWorktreeByPath prefix guard
// ---------------------------------------------------------------------------

describe("removeWorktreeByPath prefix guard", () => {
  test("refuses to remove path that does not match repo naming", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "remove-guard");
    initRepo(repo);

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      removeWorktreeByPath(repo, "/some/random/path");
    } finally {
      console.error = origErr;
    }

    expect(warnings.some((w) => w.includes("refusing") && w.includes("random"))).toBe(true);
  });

  test("refuses repo-prefixed non-task paths like backup or scratch", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "remove-guard-generic");
    initRepo(repo);

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      // These share the repo prefix but are not orchestration worktrees
      removeWorktreeByPath(repo, join(dirname(repo), "remove-guard-generic-backup"));
      removeWorktreeByPath(repo, join(dirname(repo), "remove-guard-generic-scratch"));
      removeWorktreeByPath(repo, join(dirname(repo), "remove-guard-generic-OLD"));
    } finally {
      console.error = origErr;
    }

    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.includes("refusing"))).toBe(true);
  });

  test("allows removal of path matching orchestration naming", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "remove-guard-ok");
    initRepo(repo);

    // Create a worktree with proper task-style naming
    const setup = createWorktrees(repo, "task-abc123", [{ name: "a1" }], "main", 1);

    // Should not warn — path matches orchestration naming
    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      removeWorktreeByPath(repo, setup.rootWorktree);
    } finally {
      console.error = origErr;
    }

    expect(warnings.filter((w) => w.includes("refusing"))).toHaveLength(0);

    // Clean up remaining worktrees
    cleanupWorktrees(repo, "task-abc123", [{ name: "a1" }], 1);
  });

  test("allows single-token slug with slot suffix (e.g. feat-s1)", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "remove-guard-single-slug");
    initRepo(repo);

    // Create a worktree with single-token taskId + slot
    const setup = createWorktrees(repo, "feat", [{ name: "a1" }], "main", 1);

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      removeWorktreeByPath(repo, setup.rootWorktree);
    } finally {
      console.error = origErr;
    }

    expect(warnings.filter((w) => w.includes("refusing"))).toHaveLength(0);

    cleanupWorktrees(repo, "feat", [{ name: "a1" }], 1);
  });
});

// ---------------------------------------------------------------------------
// deleteBranches prefix guard
// ---------------------------------------------------------------------------

describe("deleteBranches prefix guard", () => {
  test("deletes ludics/-prefixed branches and skips non-prefixed ones", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "delete-branches-guard");
    initRepo(repo);

    // Create a ludics-prefixed branch to be deleted
    run(["git", "branch", "ludics/test-task-s1/root"], repo);
    // Create a non-prefixed branch that must NOT be deleted
    run(["git", "branch", "feature-safe"], repo);

    // Capture stderr to verify warning
    const origErr = console.error;
    const warnings: string[] = [];
    console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };

    try {
      deleteBranches(repo, [
        "ludics/test-task-s1/root",
        "main",
        "feature-safe",
        "master",
      ]);
    } finally {
      console.error = origErr;
    }

    // The ludics/ branch should have been deleted
    const branchList = Bun.spawnSync(["git", "branch", "--list"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(branchList).not.toContain("ludics/test-task-s1/root");

    // Protected / non-prefixed branches must still exist
    expect(branchList).toContain("main");
    expect(branchList).toContain("feature-safe");

    // Warnings emitted for each skipped branch
    expect(warnings.some((w) => w.includes("main") && w.includes("refusing"))).toBe(true);
    expect(warnings.some((w) => w.includes("feature-safe") && w.includes("refusing"))).toBe(true);
    expect(warnings.some((w) => w.includes("master") && w.includes("refusing"))).toBe(true);
  });
});
