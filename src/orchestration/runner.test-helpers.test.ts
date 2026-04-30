import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { setupOrchTestState } from "./runner.test-helpers.ts";
import { stateFilePath, type OrchestrationState } from "./state.ts";
import { readJsonFile } from "../json.ts";

describe("setupOrchTestState", () => {
  test("returns harness === join(tmpRoot, 'harness') and persists state at stateFilePath(slot, harness)", () => {
    const { harness, tmpRoot, state, cleanup } = setupOrchTestState({
      slot: 42,
      agents: [
        { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "feat", worktreePath: "/tmp/wt" },
      ],
      taskId: "helper-test",
      phase: "review",
    });
    try {
      // AC4: harness path structure (distinct from tmpRoot, predictable layout)
      expect(harness).toBe(join(tmpRoot, "harness"));
      // AC1: env is pointed at the new harness
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(harness);
      // AC1: state is persisted at the right path with the helper-supplied slot
      const persisted = readJsonFile<OrchestrationState>(stateFilePath(42, harness));
      expect(persisted).not.toBeNull();
      expect(persisted!.slot).toBe(42);
      expect(persisted!.taskId).toBe("helper-test");
      expect(persisted!.phase).toBe("review");
      expect(persisted!.agents.map((a) => a.name)).toEqual(["coder"]);
      // Returned state mirrors what was persisted
      expect(state.slot).toBe(42);
      expect(state.agents.map((a) => a.name)).toEqual(["coder"]);
    } finally {
      cleanup();
    }
  });

  test("AC2/AC3: cleanup restores LUDICS_HARNESS_DIR to a prior set value (per-call snapshot)", () => {
    const sentinel = "/tmp/sentinel-prior-harness";
    const before = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = sentinel;
    try {
      const { harness, tmpRoot, cleanup } = setupOrchTestState({
        slot: 1,
        agents: [
          { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/wt" },
        ],
      });
      // Inside: env is the new harness, not the sentinel
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(harness);
      cleanup();
      // After cleanup: env is restored to the captured sentinel
      expect(process.env.LUDICS_HARNESS_DIR).toBe(sentinel);
      // tmpRoot is gone
      expect(existsSync(tmpRoot)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = before;
    }
  });

  test("AC2/AC3: cleanup deletes LUDICS_HARNESS_DIR when prev was unset (per-call snapshot)", () => {
    const before = process.env.LUDICS_HARNESS_DIR;
    // Drop the env var to instantiate the "prev was unset" branch. Conditional
    // form keeps `lint-test-isolation` Rule 1 happy (the linter rejects
    // unconditional deletes anywhere in test files, including helper tests).
    if (process.env.LUDICS_HARNESS_DIR !== undefined) delete process.env.LUDICS_HARNESS_DIR;
    try {
      const { harness, tmpRoot, cleanup } = setupOrchTestState({
        slot: 2,
        agents: [
          { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/wt" },
        ],
      });
      // Inside: env points at the new harness
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(harness);
      cleanup();
      // After cleanup: env is unset again (delete branch fired)
      expect(process.env.LUDICS_HARNESS_DIR).toBeUndefined();
      // Helper-owned tmpRoot was removed
      expect(existsSync(tmpRoot)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = before;
    }
  });

  test("AC4: cleanup of one call does not affect another call's tmpRoot", () => {
    const before = process.env.LUDICS_HARNESS_DIR;
    try {
      const a = setupOrchTestState({
        slot: 3,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/a" }],
      });
      const b = setupOrchTestState({
        slot: 4,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/b" }],
      });
      expect(a.tmpRoot).not.toBe(b.tmpRoot);
      a.cleanup();
      expect(existsSync(a.tmpRoot)).toBe(false);
      // b's tmpRoot is still alive (and its state file still exists)
      expect(existsSync(b.tmpRoot)).toBe(true);
      expect(existsSync(stateFilePath(4, b.harness))).toBe(true);
      b.cleanup();
      expect(existsSync(b.tmpRoot)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = before;
    }
  });

  test("LIFO cleanup (b then a) keeps env pointing at a live harness throughout", () => {
    const sentinel = "/tmp/sentinel-lifo";
    const before = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = sentinel;
    try {
      const a = setupOrchTestState({
        slot: 21,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/a" }],
      });
      const b = setupOrchTestState({
        slot: 22,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/b" }],
      });
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(b.harness);
      b.cleanup();
      // After b cleanup, env must point at a's still-live harness, not at the
      // pre-sequence sentinel and not at a deleted path.
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(a.harness);
      expect(existsSync(a.tmpRoot)).toBe(true);
      a.cleanup();
      // After final cleanup, env restores to the pre-sequence sentinel.
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(sentinel);
    } finally {
      if (before === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = before;
    }
  });

  test("FIFO cleanup (a then b) does not redirect env to a deleted harness (codex P2)", () => {
    // Regression for codex review on PR #453: under FIFO cleanup the prior
    // unconditional restore set LUDICS_HARNESS_DIR back to a's harness path
    // (already deleted by a.cleanup()) when b cleaned up. The fix uses a
    // module-level stack so the *final* cleanup restores the pre-sequence
    // value rather than any sibling's prev.
    const sentinel = "/tmp/sentinel-fifo";
    const before = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = sentinel;
    try {
      const a = setupOrchTestState({
        slot: 31,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/a" }],
      });
      const b = setupOrchTestState({
        slot: 32,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/b" }],
      });
      // FIFO order: a first, b still active.
      a.cleanup();
      expect(existsSync(a.tmpRoot)).toBe(false);
      // env must still point at b's live harness (a was inactive, so its
      // cleanup must not stomp on the active sibling).
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(b.harness);
      // b is still readable.
      expect(existsSync(b.tmpRoot)).toBe(true);
      expect(existsSync(stateFilePath(32, b.harness))).toBe(true);

      b.cleanup();
      // Critical: env must NOT be set to a.harness (deleted). It must restore
      // to the pre-sequence sentinel.
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).toBe(sentinel);
      expect(process.env.LUDICS_HARNESS_DIR as string | undefined).not.toBe(a.harness);
    } finally {
      if (before === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = before;
    }
  });

  test("AC1/AC7: overrides cannot clobber helper-controlled slot", () => {
    expect(() =>
      setupOrchTestState({
        slot: 7,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/wt" }],
        // Cast through unknown so the runtime guard (not just the compile-time type) is exercised.
        overrides: { slot: 99 } as unknown as Parameters<typeof setupOrchTestState>[0]["overrides"],
      }),
    ).toThrow(/'overrides\.slot' is reserved/);
  });

  test("AC1/AC7: overrides cannot clobber helper-controlled agents", () => {
    expect(() =>
      setupOrchTestState({
        slot: 8,
        agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/wt" }],
        overrides: {
          agents: [{ name: "evil", provider: "claude-code", role: "coder", model: "opus-4", branch: "x", worktreePath: "/tmp/x" }],
        } as unknown as Parameters<typeof setupOrchTestState>[0]["overrides"],
      }),
    ).toThrow(/'overrides\.agents' is reserved/);
  });

  test("AC7: non-reserved overrides flow through (e.g. round, mergeRound)", () => {
    const { harness, cleanup } = setupOrchTestState({
      slot: 5,
      agents: [{ name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "main", worktreePath: "/tmp/wt" }],
      overrides: { round: 42, mergeRound: 7 },
    });
    try {
      const persisted = readJsonFile<OrchestrationState>(stateFilePath(5, harness));
      expect(persisted!.round).toBe(42);
      expect(persisted!.mergeRound).toBe(7);
      // helper-owned slot is still authoritative
      expect(persisted!.slot).toBe(5);
    } finally {
      cleanup();
    }
  });
});
