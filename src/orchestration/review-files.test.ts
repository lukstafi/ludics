import { describe, expect, test } from "bun:test";
import { reviewFilename, reviewFilePath, parseReviewFilename } from "./review-files.ts";

describe("reviewFilename", () => {
  test("builds normal review filename", () => {
    expect(reviewFilename("review", 3, "coder")).toBe("round-3-coder.md");
  });

  test("builds plan-review filename", () => {
    expect(reviewFilename("plan-review", 1, "reviewer")).toBe("plan-merge-1-reviewer.md");
  });

  test("handles hyphenated agent names", () => {
    expect(reviewFilename("review", 2, "codex-reviews-claude")).toBe("round-2-codex-reviews-claude.md");
  });

  test("throws on invalid agent names", () => {
    expect(() => reviewFilename("review", 1, "alice.dev")).toThrow("invalid agent name");
    expect(() => reviewFilename("review", 1, "has space")).toThrow("invalid agent name");
    expect(() => reviewFilename("plan-review", 0, "a/b")).toThrow("invalid agent name");
  });
});

describe("reviewFilePath", () => {
  test("joins peerSyncDir with reviews/ and filename", () => {
    const result = reviewFilePath("/tmp/peer-sync", "review", 1, "coder");
    expect(result).toBe("/tmp/peer-sync/reviews/round-1-coder.md");
  });

  test("builds plan-review path", () => {
    const result = reviewFilePath("/tmp/peer-sync", "plan-review", 0, "reviewer");
    expect(result).toBe("/tmp/peer-sync/reviews/plan-merge-0-reviewer.md");
  });
});

describe("parseReviewFilename", () => {
  test("parses normal review filename", () => {
    expect(parseReviewFilename("round-3-coder.md")).toEqual({
      type: "review",
      round: 3,
      agentName: "coder",
    });
  });

  test("parses plan-review filename", () => {
    expect(parseReviewFilename("plan-merge-1-reviewer.md")).toEqual({
      type: "plan-review",
      round: 1,
      agentName: "reviewer",
    });
  });

  test("parses hyphenated agent names", () => {
    expect(parseReviewFilename("round-2-codex-reviews-claude.md")).toEqual({
      type: "review",
      round: 2,
      agentName: "codex-reviews-claude",
    });
    expect(parseReviewFilename("plan-merge-0-my-agent.md")).toEqual({
      type: "plan-review",
      round: 0,
      agentName: "my-agent",
    });
  });

  test("returns null for non-matching strings", () => {
    expect(parseReviewFilename("random-file.md")).toBeNull();
    expect(parseReviewFilename("round-abc-coder.md")).toBeNull();
    expect(parseReviewFilename("plans/round-1-coder.md")).toBeNull();
    expect(parseReviewFilename("")).toBeNull();
  });

  test("parses merged plan filenames (they live in plans/ so won't appear in reviews/)", () => {
    // round-1-merged-0.md technically matches the review pattern with agentName "merged-0".
    // This is acceptable because merged plan files live in plans/, not reviews/.
    const result = parseReviewFilename("round-1-merged-0.md");
    expect(result).not.toBeNull();
    expect(result!.agentName).toBe("merged-0");
  });

  test("rejects agent names with dots or spaces", () => {
    expect(parseReviewFilename("round-1-bad.agent.md")).toBeNull();
    expect(parseReviewFilename("round-1-bad agent.md")).toBeNull();
  });
});
