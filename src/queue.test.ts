import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
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

describe("queuePopOne", () => {
  test("returns null for missing queue file", async () => {
    const { queuePopOne } = await loadQueue();
    expect(queuePopOne()).toBeNull();
  });

  test("returns null for empty queue file", async () => {
    writeFileSync(join(tmpDir, "mag", "queue.jsonl"), "");
    const { queuePopOne } = await loadQueue();
    expect(queuePopOne()).toBeNull();
  });

  test("returns first line and leaves tail with newline termination", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    const { queuePopOne } = await loadQueue();
    expect(queuePopOne()).toBe('{"id":"a"}');
    expect(readFileSync(qf, "utf-8")).toBe('{"id":"b"}\n{"id":"c"}\n');
  });

  test("single-item queue leaves empty file content", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n');
    const { queuePopOne } = await loadQueue();
    expect(queuePopOne()).toBe('{"id":"a"}');
    expect(readFileSync(qf, "utf-8")).toBe("");
  });

  test("returns raw line even if malformed JSON", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, "not-json-but-not-blank\n");
    const { queuePopOne } = await loadQueue();
    expect(queuePopOne()).toBe("not-json-but-not-blank");
  });

  test("skips blank lines from corruption", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n\n{"id":"b"}\n');
    const { queuePopOne } = await loadQueue();
    expect(queuePopOne()).toBe('{"id":"a"}');
    expect(readFileSync(qf, "utf-8")).toBe('{"id":"b"}\n');
  });
});

describe("queuePopAll", () => {
  test("returns [] for missing queue file", async () => {
    const { queuePopAll } = await loadQueue();
    expect(queuePopAll()).toEqual([]);
  });

  test("returns [] for empty queue file", async () => {
    writeFileSync(join(tmpDir, "mag", "queue.jsonl"), "");
    const { queuePopAll } = await loadQueue();
    expect(queuePopAll()).toEqual([]);
  });

  test("returns all lines in FIFO order and empties the file", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n{"id":"b"}\n');
    const { queuePopAll } = await loadQueue();
    expect(queuePopAll()).toEqual(['{"id":"a"}', '{"id":"b"}']);
    expect(readFileSync(qf, "utf-8")).toBe("");
  });

  test("single-item queue returns [item] and empties file", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n');
    const { queuePopAll } = await loadQueue();
    expect(queuePopAll()).toEqual(['{"id":"a"}']);
    expect(readFileSync(qf, "utf-8")).toBe("");
  });

  test("skips blank lines from corruption", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n\n{"id":"b"}\n');
    const { queuePopAll } = await loadQueue();
    expect(queuePopAll()).toEqual(['{"id":"a"}', '{"id":"b"}']);
    expect(readFileSync(qf, "utf-8")).toBe("");
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
