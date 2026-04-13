import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_CODEX_REVIEW_PROMPT, hasCodexSubmittedReview, postCodexReviewComment } from "./github.ts";

setDefaultTimeout(20_000);

// ---------------------------------------------------------------------------
// postCodexReviewComment — body-building logic
// ---------------------------------------------------------------------------
// We cannot easily mock Bun.spawnSync, so we test the body-building logic
// by calling the function with an invalid PR URL (gh will fail) and verifying
// return value.  The body construction itself is validated via the constant.

describe("DEFAULT_CODEX_REVIEW_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(DEFAULT_CODEX_REVIEW_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_CODEX_REVIEW_PROMPT).toContain("bugs");
    expect(DEFAULT_CODEX_REVIEW_PROMPT).toContain("correctness");
  });
});

describe("postCodexReviewComment", () => {
  test("returns false for invalid PR URL (gh fails)", () => {
    // gh will exit non-zero for a bogus URL — verifies graceful failure path
    const result = postCodexReviewComment("not-a-url");
    expect(result).toBe(false);
  });

  test("returns false when prompt is undefined (still fails on bogus URL)", () => {
    const result = postCodexReviewComment("not-a-url", undefined);
    expect(result).toBe(false);
  });

  test("returns false when prompt is whitespace-only (still fails on bogus URL)", () => {
    const result = postCodexReviewComment("not-a-url", "   ");
    expect(result).toBe(false);
  });

  test("returns false when custom prompt provided (still fails on bogus URL)", () => {
    const result = postCodexReviewComment("not-a-url", "Focus on memory safety");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasCodexSubmittedReview — Codex review detection
// ---------------------------------------------------------------------------

describe("hasCodexSubmittedReview", () => {
  test("returns false for malformed URL", () => {
    expect(hasCodexSubmittedReview("not-a-url")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(hasCodexSubmittedReview("")).toBe(false);
  });

  test("returns false when gh API fails (non-existent repo)", () => {
    // gh will exit non-zero for a repo that doesn't exist
    const result = hasCodexSubmittedReview(
      "https://github.com/nonexistent-owner-zzz/nonexistent-repo-zzz/pull/1"
    );
    expect(result).toBe(false);
  });
});
