import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractReviews, writeRetrospective } from "./retrospective.ts";
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

import { existsSync, readFileSync } from "fs";
import type { RetrospectiveData } from "./retrospective.ts";

describe("writeRetrospective - review-only auto-queue path", () => {
  let harness: string;
  let ORIGINAL_HARNESS: string | undefined;

  afterEach(() => {
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    ORIGINAL_HARNESS = undefined;
    try { rmSync(harness, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function setupHarness(): void {
    ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
    harness = mkdtempSync(join(tmpdir(), "retro-autoqueue-"));
    process.env.LUDICS_HARNESS_DIR = harness;
  }

  function makeReviewOnlyData(): RetrospectiveData {
    return {
      taskId: "task-review-only-queue",
      title: "Review-only auto-queue test",
      status: "done",
      completedAt: "2026-06-17T00:00:00Z",
      startedAt: null,
      slot: null,
      mode: null,
      proposalPath: null,
      prUrl: null,
      githubUrl: null,
      phases: [],
      rounds: 1,
      mergeRound: 0,
      planMergeRound: 0,
      agents: [],
      verdicts: [],
      reviews: [
        { round: 1, type: "review", reviewer: "reviewer", verdict: "request_changes", content: "Fix the issue." },
      ],
      threads: [],
      turns: [],
      missingThreads: [],
      suggestRefactorSummary: null,
      workflowFeedback: {},
      workflowFeedbackSummary: null,
      collectedAt: "2026-06-17T00:00:00Z",
    };
  }

  test("queues process-suggestions when only request_changes reviews exist (no suggestRefactorSummary, empty workflowFeedback)", () => {
    setupHarness();
    writeRetrospective(makeReviewOnlyData());
    const queuePath = join(harness, "mag", "queue.jsonl");
    expect(existsSync(queuePath)).toBe(true);
    const records = readFileSync(queuePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const hits = records.filter(r => r.action === "process-suggestions");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.task).toBe("task-review-only-queue");
  });

  test("negative control: process-suggestions not queued with no reviews, no suggestRefactorSummary, empty workflowFeedback", () => {
    setupHarness();
    writeRetrospective({ ...makeReviewOnlyData(), reviews: [] });
    const queuePath = join(harness, "mag", "queue.jsonl");
    const records = existsSync(queuePath)
      ? readFileSync(queuePath, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(l => JSON.parse(l) as Record<string, unknown>)
      : [];
    expect(records.filter(r => r.action === "process-suggestions")).toHaveLength(0);
  });
});

describe("writeRetrospective atomic write", () => {
  test("writes JSON file and leaves no .tmp sibling", async () => {
    const { writeRetrospective } = await import("./retrospective.ts");
    const harness = mkdtempSync(join(tmpdir(), "retro-harness-"));
    const ORIGINAL = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = harness;
    try {
      const data: RetrospectiveData = {
        taskId: "task-atomic-retro",
        title: "Atomic retro test",
        status: "done",
        completedAt: "2026-04-24T00:00:00Z",
        startedAt: "2026-04-23T00:00:00Z",
        slot: 1,
        mode: "pair",
        proposalPath: null,
        prUrl: null,
        githubUrl: null,
        phases: ["setup", "plan", "implement"],
        rounds: 1,
        mergeRound: 0,
        planMergeRound: 0,
        agents: ["coder", "reviewer"],
        verdicts: [],
        reviews: [],
        threads: [],
        turns: [],
        missingThreads: [],
        suggestRefactorSummary: null,
        workflowFeedback: {},
        workflowFeedbackSummary: null,
        collectedAt: "2026-04-24T00:00:00Z",
      };
      writeRetrospective(data);
      const file = join(harness, "retrospectives", `${data.taskId}.json`);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(file + ".tmp")).toBe(false);
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      expect(parsed.taskId).toBe("task-atomic-retro");
      expect(parsed.phases).toEqual(["setup", "plan", "implement"]);
      // Byte-exactness: pretty-printed with one trailing newline (writeJsonFile shape)
      expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(data, null, 2) + "\n");
    } finally {
      if (ORIGINAL === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = ORIGINAL;
      rmSync(harness, { recursive: true, force: true });
    }
  });
});
