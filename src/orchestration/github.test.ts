import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { DEFAULT_CODEX_REVIEW_PROMPT, hasCodexSubmittedReview, postCodexReviewComment, prUrlBelongsToRepo, repoSlugFromPrUrl } from "./github.ts";

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

// ---------------------------------------------------------------------------
// prUrlBelongsToRepo / repoSlugFromPrUrl — base-repo assertion helpers
// (gh-ludics-529: prevent coder PRs from targeting the upstream fork-parent)
// ---------------------------------------------------------------------------

describe("repoSlugFromPrUrl", () => {
  test("extracts owner/repo from a canonical PR URL", () => {
    expect(repoSlugFromPrUrl("https://github.com/org/repo/pull/42")).toBe("org/repo");
  });

  test("returns null for malformed input", () => {
    expect(repoSlugFromPrUrl("")).toBeNull();
    expect(repoSlugFromPrUrl("not a url")).toBeNull();
    expect(repoSlugFromPrUrl("https://example.com/foo/bar/pull/1")).toBeNull();
    expect(repoSlugFromPrUrl("https://github.com/org/repo/issues/1")).toBeNull();
  });
});

describe("prUrlBelongsToRepo", () => {
  test("returns true for an exact slug match", () => {
    expect(prUrlBelongsToRepo("https://github.com/org/repo/pull/1", "org/repo")).toBe(true);
  });

  test("returns true for a case-insensitive match", () => {
    expect(prUrlBelongsToRepo(
      "https://github.com/Lukstafi/Ocannl-Staging/pull/5",
      "lukstafi/ocannl-staging",
    )).toBe(true);
  });

  test("returns true when expected repo has trailing whitespace", () => {
    expect(prUrlBelongsToRepo(
      "https://github.com/org/repo/pull/1",
      "  org/repo  ",
    )).toBe(true);
  });

  test("returns true when URL slug carries a trailing .git", () => {
    expect(prUrlBelongsToRepo(
      "https://github.com/org/repo.git/pull/1",
      "org/repo",
    )).toBe(true);
  });

  test("returns true when expected repo carries a trailing .git", () => {
    expect(prUrlBelongsToRepo(
      "https://github.com/org/repo/pull/1",
      "org/repo.git",
    )).toBe(true);
  });

  test("returns true for a combined case + .GIT suffix mismatch (the OCANNL incident shape)", () => {
    // Mirrors the incident: PR URL targets a fork-parent rendering with weird casing.
    expect(prUrlBelongsToRepo(
      "https://github.com/Lukstafi/Ocannl-Staging.GIT/pull/5",
      "lukstafi/ocannl-staging",
    )).toBe(true);
  });

  test("returns false for a slug mismatch (the wrong-base-repo case)", () => {
    // The OCANNL incident: PR landed on the upstream fork-parent instead of the working repo.
    expect(prUrlBelongsToRepo(
      "https://github.com/ahrefs/ocannl/pull/457",
      "lukstafi/ocannl-staging",
    )).toBe(false);
  });

  test("returns false for a malformed PR URL", () => {
    expect(prUrlBelongsToRepo("not a url", "org/repo")).toBe(false);
    expect(prUrlBelongsToRepo("", "org/repo")).toBe(false);
    expect(prUrlBelongsToRepo("https://example.com/foo/bar/pull/1", "org/repo")).toBe(false);
  });

  test("returns false when expected repo is missing or blank", () => {
    // The helper itself rejects missing/blank repo — defence in depth.
    // Call sites still gate on `if (projectRepo) ...` so AC5 skip is also
    // enforced at the call boundary; this is the redundant guard.
    expect(prUrlBelongsToRepo("https://github.com/org/repo/pull/1", undefined)).toBe(false);
    expect(prUrlBelongsToRepo("https://github.com/org/repo/pull/1", null)).toBe(false);
    expect(prUrlBelongsToRepo("https://github.com/org/repo/pull/1", "")).toBe(false);
    expect(prUrlBelongsToRepo("https://github.com/org/repo/pull/1", "   ")).toBe(false);
  });
});
