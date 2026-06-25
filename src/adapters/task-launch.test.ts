import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  assertRepoRelativeProposalPath,
  readProposalLaunchMetadata,
  resolveTaskContentForSetup,
  taskFileIntroCommit,
} from "./task-launch.ts";

/** Initialize a throwaway git repo at `dir` and return a committer that stages all
 *  and commits, returning the new HEAD sha. Used for the freshness-fingerprint tests. */
function gitRepo(dir: string): (msg: string) => string {
  const git = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString().trim();
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  return (msg: string) => {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", msg]);
    return git(["rev-parse", "HEAD"]);
  };
}

const TMP = join(import.meta.dir, ".test-tmp-task-launch");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readProposalLaunchMetadata", () => {
  test("returns proposal-derived launch feature when proposal file exists", () => {
    const harnessDir = join(TMP, "harness");
    const projectDir = join(TMP, "project");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    mkdirSync(join(projectDir, "docs"), { recursive: true });

    writeFileSync(
      join(harnessDir, "tasks", "task-101.md"),
      [
        "---",
        "id: task-101",
        "proposal: docs/refactor-queue.md",
        "---",
        "",
        "# Task",
      ].join("\n"),
    );
    writeFileSync(join(projectDir, "docs", "refactor-queue.md"), "# Proposal\n");

    const metadata = readProposalLaunchMetadata("agent-codex", harnessDir, "task-101", projectDir);
    expect(metadata).not.toBeNull();
    expect(metadata!.launchFeature).toBe("refactor-queue");
    expect(metadata!.proposalFile).toBe(join(projectDir, "docs", "refactor-queue.md"));
  });

  test("returns null when task has no proposal metadata", () => {
    const harnessDir = join(TMP, "harness");
    const projectDir = join(TMP, "project");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(harnessDir, "tasks", "task-102.md"),
      ["---", "id: task-102", "---", "", "# Task"].join("\n"),
    );

    expect(readProposalLaunchMetadata("agent-claude", harnessDir, "task-102", projectDir)).toBeNull();
  });

  test("throws when proposal metadata points at a missing file", () => {
    const harnessDir = join(TMP, "harness");
    const projectDir = join(TMP, "project");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(harnessDir, "tasks", "task-103.md"),
      [
        "---",
        "id: task-103",
        'proposal: "docs/missing-proposal.md"',
        "---",
        "",
        "# Task",
      ].join("\n"),
    );

    expect(() => readProposalLaunchMetadata("agent-codex", harnessDir, "task-103", projectDir)).toThrow(
      `agent-codex start blocked: proposal for task-103 not found at ${join(projectDir, "docs", "missing-proposal.md")}`,
    );
  });

  test("returns null for proposal: inline (deprecated sentinel, no file required)", () => {
    const harnessDir = join(TMP, "harness");
    const projectDir = join(TMP, "project");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(harnessDir, "tasks", "task-104.md"),
      ["---", "id: task-104", "proposal: inline", "---", "", "Inline proposal body."].join("\n"),
    );
    // Must NOT throw; must return null so caller derives feature from task title.
    expect(readProposalLaunchMetadata("agent-claude", harnessDir, "task-104", projectDir)).toBeNull();
  });

  test("throws when proposal path is absolute", () => {
    const harnessDir = join(TMP, "harness");
    const projectDir = join(TMP, "project");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(harnessDir, "tasks", "task-abs.md"),
      ["---", "id: task-abs", "proposal: /tmp/evil.md", "---", ""].join("\n"),
    );

    expect(() => readProposalLaunchMetadata("agent-claude", harnessDir, "task-abs", projectDir)).toThrow(
      "proposal path must be repo-relative, got absolute",
    );
  });

  test("resolves proposal under docs/proposals/ path", () => {
    const harnessDir = join(TMP, "harness");
    const projectDir = join(TMP, "project");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    mkdirSync(join(projectDir, "docs", "proposals"), { recursive: true });
    writeFileSync(
      join(harnessDir, "tasks", "task-105.md"),
      ["---", "id: task-105", "proposal: docs/proposals/add-filter.md", "---", ""].join("\n"),
    );
    writeFileSync(join(projectDir, "docs", "proposals", "add-filter.md"), "# Proposal\n");
    const meta = readProposalLaunchMetadata("agent-claude", harnessDir, "task-105", projectDir);
    expect(meta?.launchFeature).toBe("add-filter");
    expect(meta?.proposalFile).toBe(join(projectDir, "docs", "proposals", "add-filter.md"));
  });
});

describe("resolveTaskContentForSetup (gh-ludics-609 (b))", () => {
  test("AC1: throws naming the missing task file when tasks/<id>.md is absent", () => {
    const harnessDir = join(TMP, "harness");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    // No task file written.
    const expectedPath = join(harnessDir, "tasks", "task-missing.md");
    expect(() => resolveTaskContentForSetup(harnessDir, "task-missing")).toThrow(
      `slot setup blocked: assigned task file not found at ${expectedPath}`,
    );
  });

  test("present file with no fingerprint returns the parsed proposal path (AC2 fallback)", () => {
    const harnessDir = join(TMP, "harness");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    writeFileSync(
      join(harnessDir, "tasks", "task-present.md"),
      ["---", "id: task-present", "proposal: docs/proposals/foo.md", "---", "", "# Task"].join("\n"),
    );
    const out = resolveTaskContentForSetup(harnessDir, "task-present");
    expect(out.proposalPath).toBe("docs/proposals/foo.md");
    expect(out.taskContent).toContain("# Task");
  });

  test("AC2: throws on intro-commit fingerprint mismatch (present-but-stale)", () => {
    const harnessDir = join(TMP, "harness-git");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    const commit = gitRepo(harnessDir);
    writeFileSync(
      join(harnessDir, "tasks", "task-fp.md"),
      ["---", "id: task-fp", "proposal: docs/p.md", "---", ""].join("\n"),
    );
    const localSha = commit("add task");
    // A non-matching expected fingerprint (controller has a newer commit) → refuse.
    expect(() => resolveTaskContentForSetup(harnessDir, "task-fp", "0".repeat(40))).toThrow(
      /task file .* is stale — expected intro-commit 0{40}, local checkout has/,
    );
    // The matching fingerprint passes (no throw) and returns the proposal path.
    const out = resolveTaskContentForSetup(harnessDir, "task-fp", localSha);
    expect(out.proposalPath).toBe("docs/p.md");
  });
});

describe("taskFileIntroCommit (gh-ludics-609 (c))", () => {
  test("returns the latest commit touching tasks/<id>.md; '' when untracked", () => {
    const harnessDir = join(TMP, "harness-fp");
    mkdirSync(join(harnessDir, "tasks"), { recursive: true });
    const commit = gitRepo(harnessDir);
    writeFileSync(join(harnessDir, "tasks", "task-z.md"), "v1\n");
    const sha1 = commit("v1");
    expect(taskFileIntroCommit(harnessDir, "task-z")).toBe(sha1);
    // A later edit moves the fingerprint forward — freshness semantics.
    writeFileSync(join(harnessDir, "tasks", "task-z.md"), "v2\n");
    const sha2 = commit("v2");
    expect(sha2).not.toBe(sha1);
    expect(taskFileIntroCommit(harnessDir, "task-z")).toBe(sha2);
    // Unknown task / not git-tracked → "".
    expect(taskFileIntroCommit(harnessDir, "task-none")).toBe("");
  });
});

describe("assertRepoRelativeProposalPath", () => {
  test("accepts repo-relative path", () => {
    expect(() => assertRepoRelativeProposalPath("docs/proposals/foo.md")).not.toThrow();
  });

  test("accepts nested relative path that stays in-tree", () => {
    expect(() => assertRepoRelativeProposalPath("docs/../docs/proposals/foo.md")).not.toThrow();
  });

  test("rejects absolute path", () => {
    expect(() => assertRepoRelativeProposalPath("/tmp/evil.md")).toThrow(
      "proposal path must be repo-relative, got absolute",
    );
  });

  test("rejects home-relative path", () => {
    expect(() => assertRepoRelativeProposalPath("~/docs/foo.md")).toThrow(
      "proposal path must be repo-relative, got home-relative",
    );
  });

  test("rejects parent traversal", () => {
    expect(() => assertRepoRelativeProposalPath("../../etc/passwd")).toThrow(
      "proposal path escapes project tree",
    );
  });

  test("rejects single dotdot", () => {
    expect(() => assertRepoRelativeProposalPath("../foo.md")).toThrow(
      "proposal path escapes project tree",
    );
  });

  test("rejects traversal that normalizes out of tree", () => {
    expect(() => assertRepoRelativeProposalPath("docs/../../foo.md")).toThrow(
      "proposal path escapes project tree",
    );
  });
});
