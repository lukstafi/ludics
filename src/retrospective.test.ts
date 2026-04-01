import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractReviews } from "./retrospective.ts";
import type { RetrospectiveVerdict } from "./retrospective.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ludics-retro-test-"));
}

describe("extractReviews", () => {
  let tmp: string;

  afterEach(() => {
    try { rmSync(tmp, { recursive: true }); } catch { /* ignore */ }
  });

  test("mixed files sorted: plan-review before review, then by round", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(join(reviewsDir, "round-1-reviewer.md"), "**Verdict**: REQUEST_CHANGES\n\nFix the bug.\n");
    writeFileSync(join(reviewsDir, "plan-merge-0-reviewer.md"), "**Verdict**: APPROVE\n\nLooks good!\n");

    const reviews = extractReviews(tmp);
    expect(reviews).toHaveLength(2);

    // plan-merge-0 first (round 0 < round 1)
    expect(reviews[0]!.round).toBe(0);
    expect(reviews[0]!.type).toBe("plan-review");
    expect(reviews[0]!.reviewer).toBe("reviewer");
    expect(reviews[0]!.verdict).toBe("approve");
    expect(reviews[0]!.content).toContain("Looks good!");

    expect(reviews[1]!.round).toBe(1);
    expect(reviews[1]!.type).toBe("review");
    expect(reviews[1]!.verdict).toBe("request_changes");
    expect(reviews[1]!.content).toContain("Fix the bug.");
  });

  test("hyphenated reviewer name captured correctly", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(join(reviewsDir, "round-2-codex-reviews-claude.md"), "APPROVE\n");

    const reviews = extractReviews(tmp);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.reviewer).toBe("codex-reviews-claude");
  });

  test("unrecognized filename ignored", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(join(reviewsDir, "notes.md"), "some notes");
    writeFileSync(join(reviewsDir, "round-1-coder.md"), "APPROVE\n");

    const reviews = extractReviews(tmp);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.reviewer).toBe("coder");
  });

  test("empty/missing reviews directory returns empty array", () => {
    tmp = makeTmpDir();
    // No reviews/ subdirectory
    const reviews = extractReviews(tmp);
    expect(reviews).toEqual([]);
  });

  test("verdict-less content falls back to timeout", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    const body = "This review has no verdict keyword.\n";
    writeFileSync(join(reviewsDir, "round-1-reviewer.md"), body);

    const reviews = extractReviews(tmp);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.verdict).toBe("timeout");
    expect(reviews[0]!.content).toBe(body);
  });

  test("multiple reviewers same round sorted alphabetically", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(join(reviewsDir, "round-1-bob.md"), "APPROVE\n");
    writeFileSync(join(reviewsDir, "round-1-alice.md"), "APPROVE\n");

    const reviews = extractReviews(tmp);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.reviewer).toBe("alice");
    expect(reviews[1]!.reviewer).toBe("bob");
  });

  test("plan-review before review at same round number", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(join(reviewsDir, "round-1-reviewer.md"), "APPROVE\n");
    writeFileSync(join(reviewsDir, "plan-merge-1-reviewer.md"), "APPROVE\n");

    const reviews = extractReviews(tmp);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.type).toBe("plan-review");
    expect(reviews[1]!.type).toBe("review");
  });

  test("derived verdicts match reviews", () => {
    tmp = makeTmpDir();
    const reviewsDir = join(tmp, "reviews");
    mkdirSync(reviewsDir, { recursive: true });

    writeFileSync(join(reviewsDir, "plan-merge-0-reviewer.md"), "APPROVE\n");
    writeFileSync(join(reviewsDir, "round-1-codex-reviews-claude.md"), "REQUEST_CHANGES\n\nFix it.\n");
    writeFileSync(join(reviewsDir, "round-2-coder.md"), "APPROVE\n");

    const reviews = extractReviews(tmp);
    // Derive verdicts the same way the collector does
    const verdicts: RetrospectiveVerdict[] = reviews.map((r) => ({
      round: r.round,
      type: r.type,
      verdict: r.verdict,
      reviewer: r.reviewer,
    }));

    expect(verdicts).toHaveLength(reviews.length);
    for (let i = 0; i < reviews.length; i++) {
      expect(verdicts[i]!.round).toBe(reviews[i]!.round);
      expect(verdicts[i]!.type).toBe(reviews[i]!.type);
      expect(verdicts[i]!.verdict).toBe(reviews[i]!.verdict);
      expect(verdicts[i]!.reviewer).toBe(reviews[i]!.reviewer);
    }

    // Verify hyphenated name is in both
    expect(verdicts[1]!.reviewer).toBe("codex-reviews-claude");
  });
});
