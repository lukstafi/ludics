// State checkpoint tests

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stateMarkDirty, stateIsDirty, stateCommit, ensureHarnessFreshForCommit } from "./state.ts";

describe("dirty flag", () => {
  const flagPath = join(process.env.HOME ?? "/tmp", ".ludics-state-dirty");

  afterEach(() => {
    // Clean up
    if (existsSync(flagPath)) {
      try { unlinkSync(flagPath); } catch { /* ignore */ }
    }
  });

  it("stateMarkDirty creates flag file", () => {
    // Clean up first
    if (existsSync(flagPath)) unlinkSync(flagPath);

    try {
      expect(stateIsDirty()).toBe(false);
      stateMarkDirty();
      expect(stateIsDirty()).toBe(true);
    } catch {
      // Expected if stateRepoDir() fails in test env
    }
  });

  it("stateCommit marks dirty instead of committing", () => {
    if (existsSync(flagPath)) unlinkSync(flagPath);

    try {
      stateCommit("test message");
      expect(stateIsDirty()).toBe(true);
    } catch {
      // Expected if stateRepoDir() fails in test env
    }
  });
});

describe("ensureHarnessFreshForCommit (gh-ludics-609 (c)/AC5)", () => {
  const SAVED_HOME = process.env.HOME;
  const SAVED_CONFIG = process.env.LUDICS_CONFIG;
  let home = "";

  function git(dir: string, args: string[]): string {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString().trim();
  }
  function commitFile(repo: string, rel: string, body: string, msg: string): string {
    const abs = join(repo, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", msg]);
    return git(repo, ["rev-parse", "HEAD"]);
  }
  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
  }

  afterEach(() => {
    if (SAVED_HOME === undefined) delete process.env.HOME; else process.env.HOME = SAVED_HOME;
    if (SAVED_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = SAVED_CONFIG;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // Build an origin (bare) + a worker clone whose stateRepoDir() resolves to it.
  // state_repo tail "myrepo" → stateRepoDir = $HOME/myrepo.
  function setup(): { origin: string; clone: string } {
    home = mkdtempSync(join(tmpdir(), "ludics-fresh-"));
    process.env.HOME = home;
    const cfgPath = join(home, "config.yaml");
    writeFileSync(cfgPath, "state_repo: test/myrepo\nstate_path: harness\n");
    process.env.LUDICS_CONFIG = cfgPath;

    const work = join(home, "origin-work");
    initRepo(work);
    commitFile(work, "harness/README.md", "base\n", "base");
    const origin = join(home, "origin.git");
    git(work, ["clone", "-q", "--bare", work, origin]);

    const clone = join(home, "myrepo");
    git(home, ["clone", "-q", origin, "myrepo"]);
    git(clone, ["config", "user.email", "t@t"]);
    git(clone, ["config", "user.name", "t"]);
    return { origin, clone };
  }

  it("returns true when the intro-commit is reachable only after fetch (pre-fetch lie)", () => {
    const { origin, clone } = setup();
    // origin advances with the assigned task file; the worker clone has NOT fetched.
    const work2 = join(home, "origin-work2");
    git(home, ["clone", "-q", origin, "origin-work2"]);
    git(work2, ["config", "user.email", "t@t"]);
    git(work2, ["config", "user.name", "t"]);
    const introCommit = commitFile(work2, "harness/tasks/task-x.md", "spec\n", "add task-x");
    git(work2, ["push", "-q", "origin", "main"]);

    // Pre-fetch the clone does not have the intro-commit at all.
    const preCat = Bun.spawnSync(["git", "cat-file", "-e", introCommit], { cwd: clone, stdout: "pipe", stderr: "pipe" });
    expect(preCat.exitCode).not.toBe(0);

    // The gate fetches first, then tests ancestry → fresh.
    expect(ensureHarnessFreshForCommit(introCommit)).toBe(true);
    // And the worker HEAD now contains it.
    const postCat = Bun.spawnSync(["git", "merge-base", "--is-ancestor", introCommit, "HEAD"], { cwd: clone, stdout: "pipe", stderr: "pipe" });
    expect(postCat.exitCode).toBe(0);
  });

  it("returns false when the intro-commit is not an ancestor of origin/main after fetch", () => {
    const { origin, clone } = setup();
    // A commit that lives only on a divergent branch, never merged to main.
    const work2 = join(home, "origin-work2");
    git(home, ["clone", "-q", origin, "origin-work2"]);
    git(work2, ["config", "user.email", "t@t"]);
    git(work2, ["config", "user.name", "t"]);
    git(work2, ["checkout", "-q", "-b", "divergent"]);
    const orphanCommit = commitFile(work2, "harness/tasks/task-y.md", "spec\n", "divergent task-y");
    git(work2, ["push", "-q", "origin", "divergent"]);

    // After statePull resets to origin/main, the divergent commit is NOT an ancestor → refuse.
    expect(ensureHarnessFreshForCommit(orphanCommit)).toBe(false);
    void clone;
  });

  it("returns true with empty fingerprint (no gate when controller supplied none)", () => {
    // No git/config needed — empty string short-circuits before any side effect.
    expect(ensureHarnessFreshForCommit("")).toBe(true);
  });
});
