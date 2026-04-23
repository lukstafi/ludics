import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

function restoreHarnessDir(saved: string | undefined): void {
  if (saved === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = saved;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ludics-queue-test-"));
  mkdirSync(join(tmpDir, "mag"), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  restoreHarnessDir(ORIGINAL_HARNESS_DIR);
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
    queueRequest({ action: "feedback-digest", repo: "ludics" });
    expect(queueHasPendingFeedbackDigest("ludics")).toBe(true);
    expect(queueHasPendingFeedbackDigest("other-repo")).toBe(false);
  });

  test("does not match other actions", async () => {
    const { queueRequest, queueHasPendingFeedbackDigest } = await loadQueue();
    queueRequest({ action: "briefing" });
    expect(queueHasPendingFeedbackDigest("ludics")).toBe(false);
  });
});

describe("queueHasPendingAction", () => {
  test("returns false on empty queue", async () => {
    const { queueHasPendingAction } = await loadQueue();
    expect(queueHasPendingAction("adopt-sessions")).toBe(false);
  });

  test("matches queued action", async () => {
    const { queueRequest, queueHasPendingAction } = await loadQueue();
    queueRequest({ action: "adopt-sessions" });
    expect(queueHasPendingAction("adopt-sessions")).toBe(true);
  });

  test("does not match different action", async () => {
    const { queueRequest, queueHasPendingAction } = await loadQueue();
    queueRequest({ action: "briefing" });
    expect(queueHasPendingAction("adopt-sessions")).toBe(false);
  });

  test("returns false after action is popped", async () => {
    const { queueRequest, queuePopOne, queueHasPendingAction } = await loadQueue();
    queueRequest({ action: "adopt-sessions" });
    queuePopOne();
    expect(queueHasPendingAction("adopt-sessions")).toBe(false);
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

describe("writeResult", () => {
  test("round-trips output containing quotes, backslashes, and newlines", async () => {
    const { writeResult } = await loadQueue();
    const resultsDir = join(tmpDir, "mag", "results");

    // Create an output file with tricky content
    const outputContent = 'line1\nline2\twith\ttabs\n"quoted" and \\backslashes\\ and emoji 🎉';
    const outputFile = join(tmpDir, "output.txt");
    writeFileSync(outputFile, outputContent);

    writeResult("req-test-1", "ok", outputFile);

    const resultJson = readFileSync(join(resultsDir, "req-test-1.json"), "utf-8");
    const parsed = JSON.parse(resultJson);
    expect(parsed.id).toBe("req-test-1");
    expect(parsed.status).toBe("ok");
    expect(parsed.output).toBe(outputContent);
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("omits output field when no outputFile is provided", async () => {
    const { writeResult } = await loadQueue();
    const resultsDir = join(tmpDir, "mag", "results");

    writeResult("req-test-2", "error");

    const resultJson = readFileSync(join(resultsDir, "req-test-2.json"), "utf-8");
    const parsed = JSON.parse(resultJson);
    expect(parsed.id).toBe("req-test-2");
    expect(parsed.status).toBe("error");
    expect(parsed.output).toBeUndefined();
  });
});

describe("queueList", () => {
  test("returns parsed pending items", async () => {
    const { queueRequest, queueList } = await loadQueue();
    queueRequest({ action: "briefing" });
    queueRequest({ action: "elaborate", task: "task-abc" });
    const items = queueList();
    expect(items).toHaveLength(2);
    expect(items[0]!.action).toBe("briefing");
    expect(items[0]!.id).toBeDefined();
    expect(items[0]!.timestamp).toBeDefined();
    expect(items[1]!.action).toBe("elaborate");
    expect(items[1]!.task).toBe("task-abc");
  });

  test("returns empty array for missing file", async () => {
    const { queueList } = await loadQueue();
    const items = queueList();
    expect(items).toEqual([]);
  });

  test("tolerates malformed lines", async () => {
    writeFileSync(join(tmpDir, "mag", "queue.jsonl"), "not json\n");
    const { queueList } = await loadQueue();
    const items = queueList();
    expect(items).toHaveLength(1);
    expect(items[0]!.raw).toBe("not json");
  });
});

describe("recentResults", () => {
  test("returns empty array when results dir does not exist", async () => {
    const { recentResults } = await loadQueue();
    expect(recentResults()).toEqual([]);
  });

  test("returns parsed results sorted by mtime descending", async () => {
    const resultsDir = join(tmpDir, "mag", "results");
    mkdirSync(resultsDir, { recursive: true });

    // Write three result files with controlled mtimes
    const now = new Date();
    writeFileSync(join(resultsDir, "req-old.json"), JSON.stringify({ id: "old", status: "ok", timestamp: "2026-01-01T00:00:00Z" }));
    utimesSync(join(resultsDir, "req-old.json"), now, new Date(now.getTime() - 3000));

    writeFileSync(join(resultsDir, "req-mid.json"), JSON.stringify({ id: "mid", status: "ok", timestamp: "2026-01-02T00:00:00Z" }));
    utimesSync(join(resultsDir, "req-mid.json"), now, new Date(now.getTime() - 1000));

    writeFileSync(join(resultsDir, "req-new.json"), JSON.stringify({ id: "new", status: "ok", timestamp: "2026-01-03T00:00:00Z" }));
    utimesSync(join(resultsDir, "req-new.json"), now, new Date(now.getTime()));

    const { recentResults } = await loadQueue();
    const results = recentResults();
    expect(results).toHaveLength(3);
    expect(results[0]!.data.id).toBe("new");
    expect(results[1]!.data.id).toBe("mid");
    expect(results[2]!.data.id).toBe("old");
  });

  test("respects limit parameter", async () => {
    const resultsDir = join(tmpDir, "mag", "results");
    mkdirSync(resultsDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      writeFileSync(join(resultsDir, `req-${i}.json`), JSON.stringify({ id: `r${i}`, status: "ok" }));
    }

    const { recentResults } = await loadQueue();
    expect(recentResults(2)).toHaveLength(2);
  });

  test("handles malformed JSON gracefully", async () => {
    const resultsDir = join(tmpDir, "mag", "results");
    mkdirSync(resultsDir, { recursive: true });

    writeFileSync(join(resultsDir, "req-bad.json"), "not valid json{{{");

    const { recentResults } = await loadQueue();
    const results = recentResults();
    expect(results).toHaveLength(1);
    expect(results[0]!.data.error).toBe("parse error");
  });

  test("ignores non-json files", async () => {
    const resultsDir = join(tmpDir, "mag", "results");
    mkdirSync(resultsDir, { recursive: true });

    writeFileSync(join(resultsDir, "req-1.json"), JSON.stringify({ id: "r1", status: "ok" }));
    writeFileSync(join(resultsDir, "readme.txt"), "not a result");

    const { recentResults } = await loadQueue();
    expect(recentResults()).toHaveLength(1);
  });

  test("survives statSync race when file is deleted between readdir and stat", async () => {
    const resultsDir = join(tmpDir, "mag", "results");
    mkdirSync(resultsDir, { recursive: true });

    writeFileSync(join(resultsDir, "req-keep.json"), JSON.stringify({ id: "keep", status: "ok" }));
    // Dangling symlink: readdirSync lists it, but statSync throws ENOENT
    symlinkSync("/nonexistent-target", join(resultsDir, "req-gone.json"));

    const { recentResults } = await loadQueue();
    const results = recentResults();
    expect(results).toHaveLength(1);
    expect(results[0]!.data.id).toBe("keep");
  });

  test("returns error entry for non-object JSON (null, number, array)", async () => {
    const resultsDir = join(tmpDir, "mag", "results");
    mkdirSync(resultsDir, { recursive: true });

    writeFileSync(join(resultsDir, "req-null.json"), "null");
    writeFileSync(join(resultsDir, "req-num.json"), "42");
    writeFileSync(join(resultsDir, "req-arr.json"), "[1,2]");

    const { recentResults } = await loadQueue();
    const results = recentResults();
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.data.error).toBe("non-object result");
    }
    const byFile = Object.fromEntries(results.map(r => [r.file.split("/").pop(), r.data]));
    expect(byFile["req-null.json"]!.raw).toBe("object");  // typeof null === "object"
    expect(byFile["req-num.json"]!.raw).toBe("number");
    expect(byFile["req-arr.json"]!.raw).toBe("object");    // typeof [] === "object"
  });

  test("round-trip: writeResult then recentResults preserves key fields", async () => {
    const { writeResult, recentResults } = await loadQueue();

    writeResult("req-rt-1", "ok", undefined, { action: "briefing" });
    writeResult("req-rt-2", "error", undefined, { action: "elaborate", task: "task-abc" });

    const results = recentResults();
    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map(r => r.data.id);
    expect(ids).toContain("req-rt-1");
    expect(ids).toContain("req-rt-2");

    const r1 = results.find(r => r.data.id === "req-rt-1")!;
    expect(r1.data.status).toBe("ok");
    expect(r1.data.action).toBe("briefing");
    expect(r1.data.timestamp).toBeDefined();

    const r2 = results.find(r => r.data.id === "req-rt-2")!;
    expect(r2.data.status).toBe("error");
    expect(r2.data.task).toBe("task-abc");
  });
});

describe("queueRequest includes extra fields", () => {
  test("feedback-digest with repo field is parseable", async () => {
    const { queueRequest } = await loadQueue();
    queueRequest({ action: "feedback-digest", repo: "ludics" });
    const content = readFileSync(join(tmpDir, "mag", "queue.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.action).toBe("feedback-digest");
    expect(parsed.repo).toBe("ludics");
  });
});

describe("harness teardown restoration", () => {
  test("restoreHarnessDir restores a captured sentinel value", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    try {
      process.env.LUDICS_HARNESS_DIR = "/tmp/mutated-value";
      restoreHarnessDir("/sentinel-pre-queue");
      expect(process.env.LUDICS_HARNESS_DIR).toBe("/sentinel-pre-queue");
    } finally {
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });

  test("restoreHarnessDir(undefined) deletes rather than setting literal 'undefined'", () => {
    const pre = process.env.LUDICS_HARNESS_DIR;
    try {
      process.env.LUDICS_HARNESS_DIR = "/tmp/mutated-value";
      restoreHarnessDir(undefined);
      expect(process.env.LUDICS_HARNESS_DIR).toBeUndefined();
      expect(process.env.LUDICS_HARNESS_DIR).not.toBe("undefined");
    } finally {
      if (pre === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = pre;
    }
  });
});
