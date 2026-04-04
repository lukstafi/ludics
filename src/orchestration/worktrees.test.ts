import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { autoCommitWorktree, cleanupWorktrees, createWorktrees, ensureGitExcludes, GIT_EXCLUDE_ENTRIES, symlinkPeerSync } from "./worktrees.ts";

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
    writeFileSync(join(repo, ".ludics-orchestration.json"), '{"agentName":"coder"}\n');

    const result = autoCommitWorktree(repo, "should not commit");
    expect(result.dirty).toBe(false);
    expect(result.committed).toBe(false);
  });

  test("excludes .claude/ from staging", () => {
    if (!Bun.which("git")) return;
    const repo = join(TMP, "auto-commit-exclude-claude");
    initRepo(repo);
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

  test("ignores .agents and node_modules (expanded ORCHESTRATION_EXCLUDES)", () => {
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
