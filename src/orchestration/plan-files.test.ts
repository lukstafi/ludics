import { describe, expect, test } from "bun:test";
import { planFilename, planFilePath, parsePlanFilename } from "./plan-files.ts";

describe("planFilename", () => {
  test("builds individual plan filename", () => {
    expect(planFilename("plan", 3, "coder")).toBe("round-3-coder.md");
  });

  test("builds merged plan filename", () => {
    expect(planFilename("merged", 1, 0)).toBe("round-1-merged-0.md");
    expect(planFilename("merged", 2, 3)).toBe("round-2-merged-3.md");
  });

  test("handles hyphenated agent names", () => {
    expect(planFilename("plan", 2, "codex-reviews-claude")).toBe("round-2-codex-reviews-claude.md");
  });

  test("throws on invalid agent names", () => {
    expect(() => planFilename("plan", 1, "alice.dev")).toThrow("invalid agent name");
    expect(() => planFilename("plan", 1, "has space")).toThrow("invalid agent name");
    expect(() => planFilename("plan", 0, "a/b")).toThrow("invalid agent name");
  });
});

describe("planFilePath", () => {
  test("joins peerSyncDir with plans/ and individual filename", () => {
    const result = planFilePath("/tmp/peer-sync", "plan", 1, "coder");
    expect(result).toBe("/tmp/peer-sync/plans/round-1-coder.md");
  });

  test("builds merged plan path", () => {
    const result = planFilePath("/tmp/peer-sync", "merged", 2, 0);
    expect(result).toBe("/tmp/peer-sync/plans/round-2-merged-0.md");
  });
});

describe("parsePlanFilename", () => {
  test("parses individual plan filename", () => {
    expect(parsePlanFilename("round-3-coder.md")).toEqual({
      type: "plan",
      round: 3,
      agentName: "coder",
    });
  });

  test("parses merged plan filename", () => {
    expect(parsePlanFilename("round-1-merged-0.md")).toEqual({
      type: "merged",
      round: 1,
      mergeRound: 0,
    });
  });

  test("parses hyphenated agent names", () => {
    expect(parsePlanFilename("round-2-codex-reviews-claude.md")).toEqual({
      type: "plan",
      round: 2,
      agentName: "codex-reviews-claude",
    });
  });

  test("returns null for non-matching strings", () => {
    expect(parsePlanFilename("random-file.md")).toBeNull();
    expect(parsePlanFilename("round-abc-coder.md")).toBeNull();
    expect(parsePlanFilename("plans/round-1-coder.md")).toBeNull();
    expect(parsePlanFilename("")).toBeNull();
  });

  test("rejects agent names with dots or spaces", () => {
    expect(parsePlanFilename("round-1-bad.agent.md")).toBeNull();
    expect(parsePlanFilename("round-1-bad agent.md")).toBeNull();
  });

  test("merged pattern takes precedence over plan pattern", () => {
    // "merged-0" could match as an agent name in the plan regex,
    // but the merged regex should match first
    const result = parsePlanFilename("round-1-merged-0.md");
    expect(result).toEqual({ type: "merged", round: 1, mergeRound: 0 });
  });
});
