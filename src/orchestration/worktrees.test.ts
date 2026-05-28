import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { autoCommitWorktree, classifyOrphanDir, cleanupWorktrees, clearGhResolvedMarkers, createWorktrees, deleteBranches, ensureGitExcludes, GIT_EXCLUDE_ENTRIES, ORPHAN_RECOVERY_ALLOWLIST, orchBranchName, orchWorktreeStem, parseRegisteredWorktreeMatches, purgeOrphanDirIfRecoverable, refreshMainBranchFromRemote, removeWorktreeByPath, symlinkPeerSync } from "./worktrees.ts";
import { captureConsoleError } from "../test-utils.ts";

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

  test("createWorktrees clears gh-resolved markers on origin and upstream (defense-in-depth)", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-gh-resolved");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    run(["git", "add", "README.md"], repo);
    run(["git", "commit", "-m", "init"], repo);

    // Simulate a poisoned state: both origin and upstream carry gh-resolved=base.
    // (The remotes themselves don't need to exist; gh-resolved lives under
    // `remote.<name>.gh-resolved` in .git/config regardless of remote presence.)
    run(["git", "config", "remote.origin.gh-resolved", "base"], repo);
    run(["git", "config", "remote.upstream.gh-resolved", "base"], repo);
    expect(Bun.spawnSync(["git", "config", "--get", "remote.origin.gh-resolved"], { cwd: repo }).stdout.toString().trim()).toBe("base");
    expect(Bun.spawnSync(["git", "config", "--get", "remote.upstream.gh-resolved"], { cwd: repo }).stdout.toString().trim()).toBe("base");

    createWorktrees(repo, "gh-resolved-feat", [{ name: "coder" }], "main", 7, "solo");

    // Both markers must be cleared from the parent repo's .git/config.
    // (Worktrees share .git/config with the parent, so clearing once is sufficient.)
    expect(Bun.spawnSync(["git", "config", "--get", "remote.origin.gh-resolved"], { cwd: repo }).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["git", "config", "--get", "remote.upstream.gh-resolved"], { cwd: repo }).exitCode).not.toBe(0);

    cleanupWorktrees(repo, "gh-resolved-feat", [{ name: "coder" }], 7, "solo");
  });

  test("clearGhResolvedMarkers removes all values for a multi-valued gh-resolved key (P1 Codex review)", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-gh-resolved-multi");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);

    // Force a multi-valued key with --add (simulates a prior gh invocation adding
    // a second value, or a hand-edited .git/config). `git config --unset` would
    // fail with exit code 5 here; `--unset-all` must succeed.
    run(["git", "config", "--add", "remote.origin.gh-resolved", "base"], repo);
    run(["git", "config", "--add", "remote.origin.gh-resolved", "head"], repo);
    run(["git", "config", "--add", "remote.upstream.gh-resolved", "base"], repo);
    run(["git", "config", "--add", "remote.upstream.gh-resolved", "head"], repo);

    // Sanity: before clearing, both keys have 2 values each.
    const preOrigin = Bun.spawnSync(["git", "config", "--get-all", "remote.origin.gh-resolved"], { cwd: repo }).stdout.toString().trim().split("\n");
    expect(preOrigin.length).toBe(2);

    clearGhResolvedMarkers(repo);

    // After clearing, both keys must be fully absent (exit 1, not exit 5).
    expect(Bun.spawnSync(["git", "config", "--get-all", "remote.origin.gh-resolved"], { cwd: repo }).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["git", "config", "--get-all", "remote.upstream.gh-resolved"], { cwd: repo }).exitCode).not.toBe(0);
  });

  test("clearGhResolvedMarkers is idempotent and safe when markers are absent", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-gh-resolved-idem");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);

    // No gh-resolved set yet — must not throw.
    clearGhResolvedMarkers(repo);

    // Set only origin, then clear twice — second clear must also not throw.
    run(["git", "config", "remote.origin.gh-resolved", "base"], repo);
    clearGhResolvedMarkers(repo);
    clearGhResolvedMarkers(repo);
    expect(Bun.spawnSync(["git", "config", "--get", "remote.origin.gh-resolved"], { cwd: repo }).exitCode).not.toBe(0);
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

  test("idempotent no-op: unchanged HEAD when no UNTRACK_PATHS are tracked", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-untrack-noop");
    initRepo(repo);
    const headBefore = gitLog(repo, "%H").split("\n")[0];
    const countBefore = gitLogCount(repo);

    ensureGitExcludes(repo);
    ensureGitExcludes(repo);

    expect(gitLog(repo, "%H").split("\n")[0]).toBe(headBefore);
    expect(gitLogCount(repo)).toBe(countBefore);
  });

  test("untracks previously-tracked .peer-sync with a chore commit on current branch", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-untrack-peer-sync");
    initRepo(repo);
    mkdirSync(join(repo, ".peer-sync"), { recursive: true });
    writeFileSync(join(repo, ".peer-sync", "x"), "peer\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "track peer-sync"], repo);
    const countBefore = gitLogCount(repo);

    ensureGitExcludes(repo);

    // File no longer in the index
    const lsFiles = Bun.spawnSync(["git", "ls-files"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(lsFiles).not.toContain(".peer-sync/x");

    // Working tree file still present
    expect(existsSync(join(repo, ".peer-sync", "x"))).toBe(true);

    // Exactly one new chore commit at HEAD
    expect(gitLogCount(repo)).toBe(countBefore + 1);
    expect(gitLog(repo, "%s").split("\n")[0]).toBe("chore: untrack orchestration-internal files");

    // Second call is a no-op: no further commit
    ensureGitExcludes(repo);
    expect(gitLogCount(repo)).toBe(countBefore + 1);
  });

  test("does NOT untrack .claude/ — user-tracked orchestration paths are preserved", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-preserve-claude");
    initRepo(repo);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), '{"ok":true}\n');
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "track claude"], repo);
    const countBefore = gitLogCount(repo);

    ensureGitExcludes(repo);

    const lsFiles = Bun.spawnSync(["git", "ls-files"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(lsFiles).toContain(".claude/settings.json");

    // No new chore commit
    expect(gitLogCount(repo)).toBe(countBefore);
  });

  test("skips untrack when pre-existing staged changes would be swept into the chore commit", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-untrack-skip-prestaged");
    initRepo(repo);
    // Track a .peer-sync file (would normally be untracked by ensureGitExcludes)
    mkdirSync(join(repo, ".peer-sync"), { recursive: true });
    writeFileSync(join(repo, ".peer-sync", "x"), "peer\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "track peer-sync"], repo);
    // Pre-stage an unrelated change that must not be swept into the chore commit
    writeFileSync(join(repo, "README.md"), "modified\n");
    run(["git", "add", "README.md"], repo);
    const countBefore = gitLogCount(repo);

    // Silence the expected warning so test output stays clean
    const { lines: warnings } = captureConsoleError(() => ensureGitExcludes(repo));

    // Warning emitted about the skip
    expect(warnings.some((w) => w.includes("skipping untrack") && w.includes("pre-existing staged"))).toBe(true);

    // No chore commit created
    expect(gitLogCount(repo)).toBe(countBefore);

    // .peer-sync/x is still tracked (untrack skipped)
    const lsFiles = Bun.spawnSync(["git", "ls-files"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(lsFiles).toContain(".peer-sync/x");

    // User's pre-staged README change is still staged and intact
    const stagedDiff = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(stagedDiff.trim()).toBe("README.md");
  });

  test("round-commit flow: after ensureGitExcludes untracks .peer-sync, autoCommitWorktree commits real changes only", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "exclude-untrack-round-flow");
    initRepo(repo);
    mkdirSync(join(repo, ".peer-sync"), { recursive: true });
    writeFileSync(join(repo, ".peer-sync", "coder.status"), "pending\n");
    run(["git", "add", "-A"], repo);
    run(["git", "commit", "-m", "track peer-sync"], repo);

    ensureGitExcludes(repo);
    // After the chore commit, `.peer-sync/coder.status` is untracked, and the
    // working-tree copy remains (may even be modified by orchestration later).
    writeFileSync(join(repo, ".peer-sync", "coder.status"), "done\n");

    // Real source change should still commit
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "main.ts"), "export const y = 2;\n");

    const result = autoCommitWorktree(repo, "round: real changes");
    expect(result.dirty).toBe(true);
    expect(result.committed).toBe(true);

    const showStat = Bun.spawnSync(["git", "show", "--stat", "--format=", "HEAD"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(showStat).toContain("src/main.ts");
    expect(showStat).not.toContain(".peer-sync");
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

    const { lines: warnings } = captureConsoleError(() => {
      removeWorktreeByPath(repo, "/some/random/path");
    });

    expect(warnings.some((w) => w.includes("refusing") && w.includes("random"))).toBe(true);
  });

  test("refuses repo-prefixed non-task paths like backup or scratch", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "remove-guard-generic");
    initRepo(repo);

    const { lines: warnings } = captureConsoleError(() => {
      // These share the repo prefix but are not orchestration worktrees
      removeWorktreeByPath(repo, join(dirname(repo), "remove-guard-generic-backup"));
      removeWorktreeByPath(repo, join(dirname(repo), "remove-guard-generic-scratch"));
      removeWorktreeByPath(repo, join(dirname(repo), "remove-guard-generic-OLD"));
    });

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
    const { lines: warnings } = captureConsoleError(() => {
      removeWorktreeByPath(repo, setup.rootWorktree);
    });

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

    const { lines: warnings } = captureConsoleError(() => {
      removeWorktreeByPath(repo, setup.rootWorktree);
    });

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
    const { lines: warnings } = captureConsoleError(() => {
      deleteBranches(repo, [
        "ludics/test-task-s1/root",
        "main",
        "feature-safe",
        "master",
      ]);
    });

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

// ---------------------------------------------------------------------------
// orphan-worktree recovery (task-d2a16a60)
// ---------------------------------------------------------------------------

/** Seed the parent dir of the orchestration root worktree with allow-list scaffolding,
 *  simulating the state where a prior `git worktree prune` (or partial removal) left
 *  the directory on disk while git no longer knows it as a registered worktree. */
function seedOrphanLayout(orphanPath: string, options: {
  withDsStore?: boolean;
  withStray?: { name: string; contents: string };
} = {}): void {
  mkdirSync(orphanPath, { recursive: true });
  mkdirSync(join(orphanPath, ".peer-sync"), { recursive: true });
  writeFileSync(join(orphanPath, ".peer-sync", "coder.status"), "pending|0|seed\n");
  mkdirSync(join(orphanPath, ".claude"), { recursive: true });
  writeFileSync(join(orphanPath, ".claude", "settings.local.json"), '{"hooks":{}}\n');
  writeFileSync(join(orphanPath, ".ludics-orchestration.json"), '{"agentName":"coder"}\n');
  if (options.withDsStore) writeFileSync(join(orphanPath, ".DS_Store"), "macos-finder-noise\n");
  if (options.withStray) writeFileSync(join(orphanPath, options.withStray.name), options.withStray.contents);
}

describe("classifyOrphanDir", () => {
  test("recognises pure allow-list contents as recoverable", () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, "classify-recoverable");
    seedOrphanLayout(path);

    const result = classifyOrphanDir(path);
    expect(result.kind).toBe("recoverable");
    if (result.kind !== "recoverable") return;
    expect(result.preserve.sort()).toEqual([".claude", ".ludics-orchestration.json", ".peer-sync"].sort());
  });

  test("flags any unrecognised entry, naming the offender", () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, "classify-unrecognised");
    seedOrphanLayout(path, { withStray: { name: "user-notes.md", contents: "do not lose\n" } });

    const result = classifyOrphanDir(path);
    expect(result.kind).toBe("unrecognized");
    if (result.kind !== "unrecognized") return;
    expect(result.offending).toContain("user-notes.md");
    // Stray file MUST remain on disk — the throw path is non-destructive.
    expect(existsSync(join(path, "user-notes.md"))).toBe(true);
  });

  test("silently drops .DS_Store and still classifies as recoverable", () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, "classify-ds-store");
    seedOrphanLayout(path, { withDsStore: true });

    const result = classifyOrphanDir(path);
    expect(result.kind).toBe("recoverable");
    expect(existsSync(join(path, ".DS_Store"))).toBe(false);
    // Allow-list entries unchanged
    expect(existsSync(join(path, ".peer-sync", "coder.status"))).toBe(true);
  });

  test("does NOT include .DS_Store in the preserve list (allow-list constant carve-out)", () => {
    expect(ORPHAN_RECOVERY_ALLOWLIST).not.toContain(".DS_Store");
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, "classify-ds-only-no-recovery");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".DS_Store"), "noise\n");

    const result = classifyOrphanDir(path);
    expect(result.kind).toBe("recoverable");
    if (result.kind !== "recoverable") return;
    // .DS_Store is silently dropped, never preserved
    expect(result.preserve).toEqual([]);
  });
});

describe("addWorktree orphan recovery", () => {
  test("recovers an orphan dir whose contents match the allow-list", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "orphan-recover-ok");
    initRepo(repo);

    // Pre-seed the canonical root-worktree path with allow-list scaffolding.
    const stem = orchWorktreeStem("orphan-recover-ok", "task-orphan", 1);
    const orphanPath = join(dirname(repo), stem);
    seedOrphanLayout(orphanPath);
    // Assert pre-condition: dir exists, no git registration.
    expect(existsSync(orphanPath)).toBe(true);
    const preList = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(preList).not.toContain(`worktree ${orphanPath}`);

    // createWorktrees calls addWorktree(repo, orphanPath, ...) under the hood.
    const setup = createWorktrees(repo, "task-orphan", [{ name: "coder" }], "main", 1, "pair");

    // Worktree is now registered with git.
    expect(setup.rootWorktree).toBe(orphanPath);
    const postList = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(postList).toContain(`worktree ${orphanPath}`);

    // Orchestration entries restored with original contents.
    expect(readFileSync(join(orphanPath, ".peer-sync", "coder.status"), "utf-8")).toBe("pending|0|seed\n");
    expect(readFileSync(join(orphanPath, ".ludics-orchestration.json"), "utf-8")).toBe('{"agentName":"coder"}\n');
    expect(readFileSync(join(orphanPath, ".claude", "settings.local.json"), "utf-8")).toBe('{"hooks":{}}\n');

    // Recovery temp dir cleaned up.
    expect(existsSync(`${orphanPath}.orphan-recover`)).toBe(false);

    cleanupWorktrees(repo, "task-orphan", [{ name: "coder" }], 1, "pair");
  });

  test("throws clearer error and leaves dir untouched when stray content is present", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "orphan-recover-stray");
    initRepo(repo);

    const stem = orchWorktreeStem("orphan-recover-stray", "task-stray", 1);
    const orphanPath = join(dirname(repo), stem);
    seedOrphanLayout(orphanPath, { withStray: { name: "user-WIP.txt", contents: "important work\n" } });

    expect(() =>
      createWorktrees(repo, "task-stray", [{ name: "coder" }], "main", 1, "pair"),
    ).toThrow(/orphan worktree-directory detected at .* with non-orchestration content \(.*user-WIP\.txt.*\); manual recovery needed/);

    // Stray file must be untouched on disk and the worktree remains unregistered.
    expect(existsSync(join(orphanPath, "user-WIP.txt"))).toBe(true);
    expect(readFileSync(join(orphanPath, "user-WIP.txt"), "utf-8")).toBe("important work\n");
    const postList = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(postList).not.toContain(`worktree ${orphanPath}`);
    // Recovery temp dir was never created.
    expect(existsSync(`${orphanPath}.orphan-recover`)).toBe(false);
  });

  test("recovery silently drops .DS_Store and still registers the worktree", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "orphan-recover-ds-store");
    initRepo(repo);

    const stem = orchWorktreeStem("orphan-recover-ds-store", "task-ds", 2);
    const orphanPath = join(dirname(repo), stem);
    seedOrphanLayout(orphanPath, { withDsStore: true });

    const setup = createWorktrees(repo, "task-ds", [{ name: "coder" }], "main", 2, "pair");
    expect(setup.rootWorktree).toBe(orphanPath);
    expect(existsSync(join(orphanPath, ".DS_Store"))).toBe(false);
    expect(existsSync(join(orphanPath, ".peer-sync", "coder.status"))).toBe(true);

    cleanupWorktrees(repo, "task-ds", [{ name: "coder" }], 2, "pair");
  });
});

describe("purgeOrphanDirIfRecoverable", () => {
  test("returns true and removes allow-list entries", () => {
    mkdirSync(TMP, { recursive: true });
    const projectDir = join(TMP, "myrepo");
    mkdirSync(projectDir, { recursive: true });
    const path = join(TMP, "myrepo-task-purge-s1");
    seedOrphanLayout(path);

    expect(purgeOrphanDirIfRecoverable(projectDir, path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("returns false and leaves dir intact when contents are unrecognised", () => {
    mkdirSync(TMP, { recursive: true });
    const projectDir = join(TMP, "myrepo");
    mkdirSync(projectDir, { recursive: true });
    const path = join(TMP, "myrepo-task-unrec-s1");
    seedOrphanLayout(path, { withStray: { name: "user-notes.md", contents: "keep me\n" } });

    const { lines: warnings } = captureConsoleError(() => {
      expect(purgeOrphanDirIfRecoverable(projectDir, path)).toBe(false);
    });
    // No console.error from the purge itself — classify-only path is silent.
    expect(warnings).toHaveLength(0);
    expect(existsSync(join(path, "user-notes.md"))).toBe(true);
    expect(existsSync(join(path, ".peer-sync"))).toBe(true);
  });

  test("returns true when path does not exist (and matches orchestration naming)", () => {
    mkdirSync(TMP, { recursive: true });
    const projectDir = join(TMP, "myrepo");
    mkdirSync(projectDir, { recursive: true });
    expect(purgeOrphanDirIfRecoverable(projectDir, join(TMP, "myrepo-task-noexist-s1"))).toBe(true);
  });

  // Regression for P1 reviewer comment: a corrupted cleanup manifest could list
  // a path whose contents happen to be a subset of the allow-list (e.g. a user's
  // ~/Code/myproject/node_modules) but whose basename is NOT the canonical
  // orchestration worktree shape. The orchestration-name guard inside
  // purgeOrphanDirIfRecoverable must refuse such paths even though their
  // contents would otherwise classify as "recoverable".
  test("refuses path whose basename does not match orchestration naming, even if contents are allow-list-only", () => {
    mkdirSync(TMP, { recursive: true });
    const projectDir = join(TMP, "myrepo");
    mkdirSync(projectDir, { recursive: true });
    // Path basename is "user-data" — not "{repoName}-{taskSlug}(-s{N})?(-{agent})?"
    const path = join(TMP, "user-data");
    seedOrphanLayout(path); // pure allow-list content

    const { lines: warnings } = captureConsoleError(() => {
      expect(purgeOrphanDirIfRecoverable(projectDir, path)).toBe(false);
    });
    expect(warnings.some((w) => w.includes("refusing to purge") && w.includes("user-data"))).toBe(true);
    // Contents preserved.
    expect(existsSync(join(path, ".peer-sync", "coder.status"))).toBe(true);
    expect(existsSync(join(path, ".claude"))).toBe(true);
    expect(existsSync(join(path, ".ludics-orchestration.json"))).toBe(true);
  });

  test("refuses repo-prefixed non-task paths like backup or scratch (matches removeWorktreeByPath guard)", () => {
    mkdirSync(TMP, { recursive: true });
    const projectDir = join(TMP, "myrepo");
    mkdirSync(projectDir, { recursive: true });
    // "myrepo-backup" shares the prefix but the suffix "backup" is a single
    // segment without a slot marker — same shape rejected by isOrchWorktreeSuffix.
    const path = join(TMP, "myrepo-backup");
    seedOrphanLayout(path);

    const { lines: warnings } = captureConsoleError(() => {
      expect(purgeOrphanDirIfRecoverable(projectDir, path)).toBe(false);
    });
    expect(warnings.some((w) => w.includes("refusing to purge"))).toBe(true);
    expect(existsSync(join(path, ".peer-sync"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope (2): per-agent branches inherit commits placed on main BEFORE
// createWorktrees runs. Pins the invariant that paired with scope (1)
// guarantees the proposal commit reaches both coder and reviewer in duo mode.
// (`proposal-commit-on-main-and-worktree-resume`.)
// ---------------------------------------------------------------------------

describe("createWorktrees forks per-agent branches from the default branch", () => {
  test("duo mode: commits placed on main before createWorktrees are visible on every per-agent branch", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "fork-from-main");
    initRepo(repo);

    // Place a "proposal" commit on main BEFORE createWorktrees runs.
    // This is the canonical scope-(1)-then-(2) sequence: proposal on
    // default branch first, then orchestration forks per-agent worktrees.
    writeFileSync(join(repo, "PROPOSAL.md"), "proposal body\n");
    run(["git", "add", "PROPOSAL.md"], repo);
    run(["git", "commit", "-m", "proposal: scope-2 fixture"], repo);

    const setup = createWorktrees(
      repo,
      "fork-feat",
      [{ name: "coder" }, { name: "reviewer" }],
      "main",
      9,
      "duo",
    );

    // Per-agent branches must inherit the proposal commit, so the file
    // exists in each per-agent worktree's checkout.
    for (const agent of ["coder", "reviewer"]) {
      const wt = setup.agentWorktrees[agent]!;
      expect(existsSync(join(wt, "PROPOSAL.md"))).toBe(true);
      expect(readFileSync(join(wt, "PROPOSAL.md"), "utf-8")).toBe("proposal body\n");
      // Branch is forked, not shared.
      expect(setup.branches[agent]).not.toBe(setup.branches.root);
    }
    // Root worktree also carries the commit.
    expect(existsSync(join(setup.rootWorktree, "PROPOSAL.md"))).toBe(true);

    cleanupWorktrees(repo, "fork-feat", [{ name: "coder" }, { name: "reviewer" }], 9, "duo");
  });
});

// ---------------------------------------------------------------------------
// Scope (3b): resume short-circuit preserves worktree directory contents.
// (`proposal-commit-on-main-and-worktree-resume`.)
// ---------------------------------------------------------------------------

describe("addWorktree resume short-circuit", () => {
  test("re-creating an existing worktree+branch preserves uncommitted scratch and branch HEAD", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "resume-shortcircuit");
    initRepo(repo);

    // First call: cold-start. createWorktrees materialises the worktrees
    // and forks per-agent branches from main.
    const taskId = "resume-feat";
    const agents = [{ name: "coder" }, { name: "reviewer" }];
    const slot = 11;
    const first = createWorktrees(repo, taskId, agents, "main", slot, "duo");

    // Capture the branch HEADs and write uncommitted scratch into one of
    // the worktrees, simulating an agent's mid-round work-in-progress.
    const headsBefore: Record<string, string> = {};
    for (const agent of ["coder", "reviewer"]) {
      const wt = first.agentWorktrees[agent]!;
      headsBefore[agent] = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: wt, stdout: "pipe", stderr: "pipe",
        env: process.env as Record<string, string>,
      }).stdout.toString().trim();
    }
    const scratchPath = join(first.agentWorktrees.coder!, "SCRATCH-WIP.txt");
    writeFileSync(scratchPath, "agent uncommitted work\n");

    // Second call: simulates resume / restart of the slot. Same args, same
    // stem — addWorktree should short-circuit instead of removing+re-adding.
    const second = createWorktrees(repo, taskId, agents, "main", slot, "duo");

    // Identity: worktree paths must be the same.
    expect(second.rootWorktree).toBe(first.rootWorktree);
    expect(second.agentWorktrees.coder).toBe(first.agentWorktrees.coder);
    expect(second.agentWorktrees.reviewer).toBe(first.agentWorktrees.reviewer);

    // Invariant: uncommitted scratch survives the resume (the property the
    // short-circuit exists to enforce — `git worktree remove --force`
    // would have wiped this file).
    expect(existsSync(scratchPath)).toBe(true);
    expect(readFileSync(scratchPath, "utf-8")).toBe("agent uncommitted work\n");

    // Invariant: branches are not reset. (addWorktree never ran `git
    // reset`, but pin it here for the short-circuit path explicitly so a
    // future refactor cannot silently introduce a reset.)
    for (const agent of ["coder", "reviewer"]) {
      const wt = second.agentWorktrees[agent]!;
      const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: wt, stdout: "pipe", stderr: "pipe",
        env: process.env as Record<string, string>,
      }).stdout.toString().trim();
      expect(head).toBe(headsBefore[agent]!);
    }

    cleanupWorktrees(repo, "resume-feat", [{ name: "coder" }, { name: "reviewer" }], 11, "duo");
  });

  test("falls through to teardown-and-recreate when the directory exists but git does NOT register it (orphan)", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "shortcircuit-fallthrough-orphan");
    initRepo(repo);

    // Pre-seed the canonical worktree path with allow-list scaffolding but
    // no git registration — same shape as the orphan-recovery test, which
    // is exactly the "directory exists but registration disagrees" case
    // the short-circuit must NOT short-circuit.
    const stem = orchWorktreeStem("shortcircuit-fallthrough-orphan", "task-fallthrough", 4);
    const orphanPath = join(dirname(repo), stem);
    seedOrphanLayout(orphanPath);

    // Pre-condition: dir exists, no git registration.
    expect(existsSync(orphanPath)).toBe(true);
    const preList = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(preList).not.toContain(`worktree ${orphanPath}`);

    // createWorktrees must fall through to the orphan-recovery path,
    // not short-circuit on directory-exists alone.
    const setup = createWorktrees(repo, "task-fallthrough", [{ name: "coder" }], "main", 4, "pair");
    expect(setup.rootWorktree).toBe(orphanPath);
    const postList = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: process.env as Record<string, string>,
    }).stdout.toString();
    expect(postList).toContain(`worktree ${orphanPath}`);

    cleanupWorktrees(repo, "task-fallthrough", [{ name: "coder" }], 4, "pair");
  });

  test("falls through when the registered branch differs from the requested branch", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "shortcircuit-fallthrough-branch");
    initRepo(repo);

    // First, materialise a worktree on branch `wrong-branch` at the
    // canonical orchestration path.
    const stem = orchWorktreeStem("shortcircuit-fallthrough-branch", "task-fb", 5);
    const path = join(dirname(repo), stem);
    run(["git", "branch", "wrong-branch"], repo);
    run(["git", "worktree", "add", path, "wrong-branch"], repo);
    expect(existsSync(path)).toBe(true);

    // Now ask createWorktrees to materialise a pair-mode worktree at the
    // same path, but for a different branch (the canonical
    // `ludics/task-fb-s5/root`). The short-circuit MUST decline because
    // the registered branch differs — short-circuiting would silently
    // leave the worktree on `wrong-branch`.
    //
    // The teardown-and-recreate path (`git worktree remove --force` then
    // `git worktree add path branch`) handles this case correctly.
    const setup = createWorktrees(repo, "task-fb", [{ name: "coder" }], "main", 5, "pair");
    expect(setup.rootWorktree).toBe(path);

    // Worktree must now be on the canonical orchestration branch, not on
    // `wrong-branch` — proving the short-circuit fell through.
    const head = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: path, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> },
    ).stdout.toString().trim();
    expect(head).toBe(setup.branches.root);
    expect(head).not.toBe("wrong-branch");

    cleanupWorktrees(repo, "task-fb", [{ name: "coder" }], 5, "pair");
    safeRun(["git", "branch", "-D", "wrong-branch"], repo);
  });

});

// Regression for Codex P2 reviewer note on PR #519: `git worktree list
// --porcelain` can emit `prunable <reason>` (not just bare `prunable`),
// so an exact-equality check on `prunable` lets the short-circuit
// silently accept a stale registration. parseRegisteredWorktreeMatches
// is the pure helper extracted so this can be tested directly without
// having to manufacture the messy on-disk state.
describe("parseRegisteredWorktreeMatches: prunable-with-reason rejection", () => {
  const PATH = "/tmp/wt-path";
  const BRANCH = "ludics/task-x/coder";

  test("returns true for a clean registered record matching path + branch", () => {
    const porcelain = [
      `worktree ${PATH}`,
      `HEAD abc123`,
      `branch refs/heads/${BRANCH}`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(true);
  });

  test("returns false when the record carries a bare `prunable` line (existing behaviour)", () => {
    const porcelain = [
      `worktree ${PATH}`,
      `HEAD abc123`,
      `branch refs/heads/${BRANCH}`,
      `prunable`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(false);
  });

  // Load-bearing assertion for the Codex P2 fix: a real-world git
  // emission shape (`prunable gitdir file points to non-existent
  // location`) must be rejected, not accepted. Mutation: reverting the
  // prefix-match in parseRegisteredWorktreeMatches to a literal
  // `=== "prunable"` makes this assertion flip from false→true.
  test("returns false when the record carries a `prunable <reason>` line (Codex P2 reviewer fix)", () => {
    const porcelain = [
      `worktree ${PATH}`,
      `HEAD abc123`,
      `branch refs/heads/${BRANCH}`,
      `prunable gitdir file points to non-existent location`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(false);
  });

  // Defence-in-depth: leading whitespace on the prunable line should
  // also be rejected. Some git versions / locales may indent.
  test("returns false when the prunable line has leading whitespace", () => {
    const porcelain = [
      `worktree ${PATH}`,
      `HEAD abc123`,
      `branch refs/heads/${BRANCH}`,
      `  prunable some reason`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(false);
  });

  // Negative control: a line that merely contains the substring
  // "prunable" but is not the prunable marker (e.g. a hypothetical
  // future record field) must NOT trigger rejection — exact prefix
  // match, not substring match.
  test("does NOT reject lines that merely contain 'prunable' as a substring", () => {
    const porcelain = [
      `worktree ${PATH}`,
      `HEAD abc123`,
      `branch refs/heads/${BRANCH}`,
      `# this comment mentions prunable but is not the marker`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(true);
  });

  test("returns false when the record's branch differs from the requested branch", () => {
    const porcelain = [
      `worktree ${PATH}`,
      `HEAD abc123`,
      `branch refs/heads/different-branch`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(false);
  });

  test("returns false when path is not registered at all", () => {
    const porcelain = [
      `worktree /tmp/some-other`,
      `HEAD abc123`,
      `branch refs/heads/some-other`,
      ``,
    ].join("\n");
    expect(parseRegisteredWorktreeMatches(porcelain, PATH, BRANCH)).toBe(false);
  });
});

function safeRun(cmd: string[], cwd: string): void {
  Bun.spawnSync(cmd, {
    cwd, stdout: "pipe", stderr: "pipe",
    env: process.env as Record<string, string>,
  });
}

/** Set up an origin/clone pair with one commit on `main`, then add one commit
 *  on `origin/main` so the clone is exactly one commit behind. Returns the
 *  clone path (the "project repo") and the resolved upstream HEAD sha. */
function setupOriginAhead(rootDir: string): { repo: string; upstreamSha: string } {
  const origin = join(rootDir, "origin.git");
  const repo = join(rootDir, "repo");
  // Bare origin
  run(["git", "init", "--bare", "-b", "main", origin], rootDir);
  // Seed via a throwaway working clone so origin has a starting commit on main.
  const seed = join(rootDir, "seed");
  run(["git", "clone", origin, seed], rootDir);
  run(["git", "config", "user.email", "test@example.com"], seed);
  run(["git", "config", "user.name", "Test User"], seed);
  writeFileSync(join(seed, "README.md"), "seed\n");
  run(["git", "add", "README.md"], seed);
  run(["git", "commit", "-m", "seed"], seed);
  run(["git", "push", "origin", "main"], seed);
  // Project repo — clone of origin, will lag.
  run(["git", "clone", origin, repo], rootDir);
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  // Advance origin past the project repo.
  writeFileSync(join(seed, "added.txt"), "from upstream\n");
  run(["git", "add", "added.txt"], seed);
  run(["git", "commit", "-m", "upstream advance"], seed);
  run(["git", "push", "origin", "main"], seed);
  const upstreamSha = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: seed }).stdout.toString().trim();
  return { repo, upstreamSha };
}

function headSha(repo: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
}

describe("refreshMainBranchFromRemote", () => {
  test("fast-forwards local main when origin is ahead", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const { repo, upstreamSha } = setupOriginAhead(TMP);
    // Sanity: clone HEAD is behind origin/main.
    expect(headSha(repo)).not.toBe(upstreamSha);
    refreshMainBranchFromRemote(repo, "main");
    expect(headSha(repo)).toBe(upstreamSha);
    // The new file from origin is visible.
    expect(existsSync(join(repo, "added.txt"))).toBe(true);
  });

  test("skips silently when no origin remote exists", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const repo = join(TMP, "repo-no-origin");
    mkdirSync(repo, { recursive: true });
    run(["git", "init", "-b", "main"], repo);
    run(["git", "config", "user.email", "test@example.com"], repo);
    run(["git", "config", "user.name", "Test User"], repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    run(["git", "add", "README.md"], repo);
    run(["git", "commit", "-m", "init"], repo);
    const beforeSha = headSha(repo);
    const { lines: captured } = captureConsoleError(() => {
      refreshMainBranchFromRemote(repo, "main");
    });
    expect(headSha(repo)).toBe(beforeSha);
    // Skip is silent — no warning when origin is simply absent.
    expect(captured.find((l) => l.includes("refreshMainBranchFromRemote"))).toBeUndefined();
  });

  test("skips when working tree is on a different branch", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const { repo, upstreamSha } = setupOriginAhead(TMP);
    run(["git", "checkout", "-b", "feature"], repo);
    const beforeSha = headSha(repo);
    expect(beforeSha).not.toBe(upstreamSha);
    refreshMainBranchFromRemote(repo, "main");
    // main was not touched (we're on feature) — main ref should still lag origin.
    const mainSha = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: repo }).stdout.toString().trim();
    expect(mainSha).not.toBe(upstreamSha);
    expect(headSha(repo)).toBe(beforeSha);
  });

  test("skips when working tree has uncommitted changes", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const { repo, upstreamSha } = setupOriginAhead(TMP);
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
    const beforeSha = headSha(repo);
    refreshMainBranchFromRemote(repo, "main");
    expect(headSha(repo)).toBe(beforeSha);
    expect(headSha(repo)).not.toBe(upstreamSha);
    // The dirty file is preserved.
    expect(readFileSync(join(repo, "dirty.txt"), "utf8")).toBe("uncommitted\n");
  });

  test("warns and skips when local has diverged from origin (non-ff)", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const { repo } = setupOriginAhead(TMP);
    // Diverge: commit on local main without pulling.
    writeFileSync(join(repo, "local.txt"), "local-only\n");
    run(["git", "add", "local.txt"], repo);
    run(["git", "commit", "-m", "local divergence"], repo);
    const beforeSha = headSha(repo);
    const { lines: captured } = captureConsoleError(() => {
      refreshMainBranchFromRemote(repo, "main");
    });
    // Local commit preserved — no force, no reset.
    expect(headSha(repo)).toBe(beforeSha);
    expect(existsSync(join(repo, "local.txt"))).toBe(true);
    // Warning was emitted so the operator can see why ff failed.
    expect(captured.some((l) => l.includes("ff-only merge") && l.includes("diverged"))).toBe(true);
  });
});

describe("createWorktrees refreshes main before forking", () => {
  test("integration: stale local main is advanced before worktree branches off", () => {
    if (!Bun.which("git")) return;
    mkdirSync(TMP, { recursive: true });
    const { repo, upstreamSha } = setupOriginAhead(TMP);
    // Confirm precondition: local main is behind.
    expect(headSha(repo)).not.toBe(upstreamSha);
    const setup = createWorktrees(repo, "feat", [{ name: "agent1" }], "main", 7);
    // After createWorktrees, local main has advanced to upstream …
    const mainSha = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: repo }).stdout.toString().trim();
    expect(mainSha).toBe(upstreamSha);
    // … and the new worktree carries the upstream commit.
    const worktreeSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: setup.rootWorktree }).stdout.toString().trim();
    expect(worktreeSha).toBe(upstreamSha);
    expect(existsSync(join(setup.rootWorktree, "added.txt"))).toBe(true);
    cleanupWorktrees(repo, "feat", [{ name: "agent1" }], 7);
  });
});
