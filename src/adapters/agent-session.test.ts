import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveAgentSessionProjectDir } from "./agent-session.ts";
import type { AdapterContext } from "./types.ts";

const TMP = join(import.meta.dir, ".test-tmp-agent-session");

function makeContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    slot: 1,
    mode: "agent-codex",
    session: "",
    path: "",
    taskId: "task-001",
    adapterArgs: "",
    process: "task-001",
    harnessDir: TMP,
    stateRepoDir: TMP,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("resolveAgentSessionProjectDir", () => {
  test("prefers slot path and normalizes worktrees to the main repo", () => {
    const mainRepo = join(TMP, "repo");
    const worktree = join(TMP, "repo-feature");
    mkdirSync(join(mainRepo, ".git"), { recursive: true });
    mkdirSync(join(mainRepo, ".agent-sessions"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "repo-feature")}`);

    const projectDir = resolveAgentSessionProjectDir(makeContext({
      path: worktree,
      session: "",
    }));

    expect(projectDir).toBe(mainRepo);
  });
});
