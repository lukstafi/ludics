import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ludics-queue-test-"));
  mkdirSync(join(tmpDir, "mag"), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LUDICS_HARNESS_DIR;
});

// Re-import after env is set — queue.ts reads harnessDir() at call time
async function loadQueue() {
  return await import("./queue.ts");
}

describe("queueHasPendingFeedbackDigest", () => {
  test("returns false on empty queue", async () => {
    const { queueHasPendingFeedbackDigest } = await loadQueue();
    expect(queueHasPendingFeedbackDigest("ludics")).toBe(false);
  });

  test("matches feedback-digest with repo field", async () => {
    const { queueRequest, queueHasPendingFeedbackDigest } = await loadQueue();
    queueRequest("feedback-digest", `"repo":"ludics"`);
    expect(queueHasPendingFeedbackDigest("ludics")).toBe(true);
    expect(queueHasPendingFeedbackDigest("other-repo")).toBe(false);
  });

  test("does not match feedback-digest without repo field", async () => {
    const { queueRequest, queueHasPendingFeedbackDigest } = await loadQueue();
    queueRequest("feedback-digest");
    // Without repo field, repo check should not match
    expect(queueHasPendingFeedbackDigest("ludics")).toBe(false);
  });

  test("does not match other actions", async () => {
    const { queueRequest, queueHasPendingFeedbackDigest } = await loadQueue();
    queueRequest("briefing");
    expect(queueHasPendingFeedbackDigest("ludics")).toBe(false);
  });
});

describe("queueRequest includes extra fields", () => {
  test("feedback-digest with repo field is parseable", async () => {
    const { queueRequest } = await loadQueue();
    queueRequest("feedback-digest", `"repo":"ludics"`);
    const content = readFileSync(join(tmpDir, "mag", "queue.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.action).toBe("feedback-digest");
    expect(parsed.repo).toBe("ludics");
  });
});
