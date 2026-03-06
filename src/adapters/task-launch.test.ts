import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readProposalLaunchMetadata } from "./task-launch.ts";

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
});
