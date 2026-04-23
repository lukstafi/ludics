import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, symlinkSync } from "fs";
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

  test("leaves no .tmp sibling after writing the result", async () => {
    const { writeResult } = await loadQueue();
    const resultsDir = join(tmpDir, "mag", "results");
    writeResult("req-test-tmp", "ok");
    expect(existsSync(join(resultsDir, "req-test-tmp.json"))).toBe(true);
    expect(existsSync(join(resultsDir, "req-test-tmp.json.tmp"))).toBe(false);
  });
});

describe("queuePopOne leaves no .tmp sibling after atomic write", () => {
  test("after popping, queue.jsonl has no .tmp neighbour", async () => {
    const { queuePopOne } = await loadQueue();
    const file = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(file, '{"id":"a"}\n{"id":"b"}\n');
    expect(queuePopOne()).toBe('{"id":"a"}');
    expect(existsSync(file + ".tmp")).toBe(false);
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

describe("withQueueLock", () => {
  test("releases lock directory after normal execution", async () => {
    const { withQueueLock } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");

    const result = withQueueLock(() => {
      expect(existsSync(lockDir)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("releases lock directory even when fn throws", async () => {
    const { withQueueLock } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");

    expect(() => withQueueLock(() => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lockDir)).toBe(false);
  });

  test("owner file records current process PID", async () => {
    const { withQueueLock } = await loadQueue();
    const ownerFile = join(tmpDir, "mag", "queue.jsonl.lock", "owner");
    withQueueLock(() => {
      const owner = readFileSync(ownerFile, "utf-8");
      const [pidStr] = owner.split("\n");
      expect(Number(pidStr)).toBe(process.pid);
    });
  });

  test("in-process: nested mkdirSync on held lock dir fails with EEXIST", async () => {
    const { withQueueLock } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");

    let sawEexist = false;
    withQueueLock(() => {
      expect(existsSync(lockDir)).toBe(true);
      try {
        mkdirSync(lockDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") sawEexist = true;
      }
    });
    expect(sawEexist).toBe(true);
  });

  test("serializes concurrent callers: child subprocess blocks until parent releases", async () => {
    const { withQueueLock } = await loadQueue();
    const queueModulePath = new URL("./queue.ts", import.meta.url).pathname;
    const eventsFile = join(tmpDir, "lock-events.log");
    writeFileSync(eventsFile, "");

    // Child script: records timestamp on start, then tries to acquire the same lock.
    // The child runs in a separate Bun process and shares LUDICS_HARNESS_DIR via env.
    const childFile = join(tmpDir, "child-lock.ts");
    writeFileSync(childFile, `import { appendFileSync } from "fs";
const eventsFile = process.argv[2];
appendFileSync(eventsFile, \`child-start \${Date.now()}\\n\`);
const { withQueueLock } = await import(${JSON.stringify(queueModulePath)});
withQueueLock(() => {
  appendFileSync(eventsFile, \`child-acquired \${Date.now()}\\n\`);
});
appendFileSync(eventsFile, \`child-done \${Date.now()}\\n\`);
`);

    const holdMs = 500;
    let lastHeldTs = 0;
    let childProc: ReturnType<typeof Bun.spawn> | null = null;

    withQueueLock(() => {
      // Launch the child while we hold the lock. It must block on EEXIST until we release.
      childProc = Bun.spawn({
        cmd: [process.execPath, "run", childFile, eventsFile],
        env: { ...process.env, LUDICS_HARNESS_DIR: tmpDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Hold long enough for the child to start, import, and attempt acquisition.
      // Retry interval in queue.ts is 100ms, so several retries will happen.
      Bun.sleepSync(holdMs);
      lastHeldTs = Date.now();  // still inside critical section
    });
    // At this point the parent's finally block has released the lock.

    await childProc!.exited;
    expect(childProc!.exitCode).toBe(0);

    const events = readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
    const firstTs = (tag: string): number | null => {
      const line = events.find(l => l.startsWith(tag + " "));
      return line ? Number(line.split(" ")[1]) : null;
    };
    const childStartTs = firstTs("child-start");
    const childAcquiredTs = firstTs("child-acquired");
    const childDoneTs = firstTs("child-done");

    // Child actually ran and completed normally.
    expect(childStartTs).not.toBeNull();
    expect(childAcquiredTs).not.toBeNull();
    expect(childDoneTs).not.toBeNull();

    // Child started its attempt while parent still held the lock — proves contention occurred.
    expect(childStartTs!).toBeLessThan(lastHeldTs);
    // Serialization invariant: child could not have entered the critical section
    // before the parent left it. `lastHeldTs` was captured while the parent still held.
    expect(childAcquiredTs!).toBeGreaterThanOrEqual(lastHeldTs);

    // Lock dir is clean at the end (both parent and child released).
    expect(existsSync(join(tmpDir, "mag", "queue.jsonl.lock"))).toBe(false);
  }, 15_000);

  test("breaks stale lock held by dead PID", async () => {
    const { withQueueLock } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");
    const ownerFile = join(lockDir, "owner");

    // Plant a stale lock with an unreachable PID and a recent timestamp.
    // PID 999999 is unlikely to exist; process.kill will throw ESRCH.
    mkdirSync(lockDir);
    writeFileSync(ownerFile, `999999\n${Date.now()}`);

    const result = withQueueLock(() => "done");
    expect(result).toBe("done");
    expect(existsSync(lockDir)).toBe(false);
  });

  test("breaks stale lock older than threshold even if PID still exists", async () => {
    const { withQueueLock } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");
    const ownerFile = join(lockDir, "owner");

    // Age the timestamp past the 30s threshold; use current PID so liveness alone won't break it.
    mkdirSync(lockDir);
    writeFileSync(ownerFile, `${process.pid}\n${Date.now() - 60_000}`);

    const result = withQueueLock(() => "done");
    expect(result).toBe("done");
    expect(existsSync(lockDir)).toBe(false);
  });

  test("breaks ownerless lock dir aged past stale threshold", async () => {
    const { withQueueLock } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");
    mkdirSync(lockDir);
    // No owner file (crash between mkdir and writeFileSync). Backdate the
    // directory mtime past the 30s threshold so breakStaleLock treats it
    // as orphaned rather than as a freshly contended lock.
    const aged = new Date(Date.now() - 60_000);
    utimesSync(lockDir, aged, aged);

    const result = withQueueLock(() => "done");
    expect(result).toBe("done");
    expect(existsSync(lockDir)).toBe(false);
  });

  test("does NOT break freshly-created ownerless lock (grace window preserves mutual exclusion)", async () => {
    // Simulates: process A mkdir'd the lock dir but was preempted before
    // writing the owner file. A contender must NOT break this lock; doing
    // so lets both A and the contender enter the critical section.
    const { withQueueLock } = await loadQueue();
    const queueModulePath = new URL("./queue.ts", import.meta.url).pathname;
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");
    const eventsFile = join(tmpDir, "grace-events.log");
    writeFileSync(eventsFile, "");

    // Plant a fresh ownerless lock (mtime = now).
    mkdirSync(lockDir);

    const childFile = join(tmpDir, "child-grace.ts");
    writeFileSync(childFile, `import { appendFileSync } from "fs";
const eventsFile = process.argv[2];
appendFileSync(eventsFile, \`child-start \${Date.now()}\\n\`);
const { withQueueLock } = await import(${JSON.stringify(queueModulePath)});
try {
  withQueueLock(() => {
    appendFileSync(eventsFile, \`child-acquired \${Date.now()}\\n\`);
  });
} catch (e) {
  appendFileSync(eventsFile, \`child-error \${(e instanceof Error ? e.message : String(e))}\\n\`);
}
`);

    const child = Bun.spawn({
      cmd: [process.execPath, "run", childFile, eventsFile],
      env: { ...process.env, LUDICS_HARNESS_DIR: tmpDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait 1.2s — well past several retry cycles (100ms each). A correct
    // implementation still hasn't broken our fresh ownerless lock.
    Bun.sleepSync(1200);
    const midEvents = readFileSync(eventsFile, "utf-8");
    expect(midEvents).toContain("child-start");
    expect(midEvents).not.toContain("child-acquired");
    expect(existsSync(lockDir)).toBe(true);  // still held

    // Now simulate the grace window elapsing: backdate the lock dir mtime.
    const aged = new Date(Date.now() - 60_000);
    utimesSync(lockDir, aged, aged);

    // Child should now break the stale lock and acquire within the remaining retry budget.
    await child.exited;
    expect(child.exitCode).toBe(0);
    const finalEvents = readFileSync(eventsFile, "utf-8");
    expect(finalEvents).toContain("child-acquired");
    expect(finalEvents).not.toContain("child-error");
    expect(existsSync(lockDir)).toBe(false);
  }, 15_000);
});

describe("queueRequest holds the queue lock", () => {
  test("concurrent mkdirSync on lock dir fails during append", async () => {
    // Can't easily interpose, but verify lock dir is cleaned up after queueRequest.
    const { queueRequest } = await loadQueue();
    const lockDir = join(tmpDir, "mag", "queue.jsonl.lock");
    queueRequest({ action: "briefing" });
    expect(existsSync(lockDir)).toBe(false);
    // And queue entry persisted.
    const content = readFileSync(join(tmpDir, "mag", "queue.jsonl"), "utf-8").trim();
    expect(content.length).toBeGreaterThan(0);
  });
});

describe("queuePopExpected", () => {
  test("returns empty for missing queue file", async () => {
    const { queuePopExpected } = await loadQueue();
    expect(queuePopExpected()).toEqual({ status: "empty" });
  });

  test("returns empty for blank queue file", async () => {
    writeFileSync(join(tmpDir, "mag", "queue.jsonl"), "");
    const { queuePopExpected } = await loadQueue();
    expect(queuePopExpected()).toEqual({ status: "empty" });
  });

  test("pops first line when no expectedLine is given", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n{"id":"b"}\n');
    const { queuePopExpected } = await loadQueue();
    const result = queuePopExpected();
    expect(result.status).toBe("popped");
    if (result.status === "popped") {
      expect(result.line).toBe('{"id":"a"}');
      expect(result.request).toEqual({ id: "a" });
    }
    expect(readFileSync(qf, "utf-8")).toBe('{"id":"b"}\n');
  });

  test("pops first line when expectedLine matches", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n{"id":"b"}\n');
    const { queuePopExpected } = await loadQueue();
    const result = queuePopExpected('{"id":"a"}');
    expect(result.status).toBe("popped");
    expect(readFileSync(qf, "utf-8")).toBe('{"id":"b"}\n');
  });

  test("returns mismatch and leaves file unchanged when expectedLine differs", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    const initial = '{"id":"a"}\n{"id":"b"}\n';
    writeFileSync(qf, initial);
    const { queuePopExpected } = await loadQueue();
    expect(queuePopExpected('{"id":"zzz"}')).toEqual({ status: "mismatch" });
    expect(readFileSync(qf, "utf-8")).toBe(initial);
  });

  test("returns popped with null request for malformed JSON line", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, "not-json\n");
    const { queuePopExpected } = await loadQueue();
    const result = queuePopExpected();
    expect(result.status).toBe("popped");
    if (result.status === "popped") {
      expect(result.line).toBe("not-json");
      expect(result.request).toBeNull();
    }
  });

  test("releases lock dir after each call", async () => {
    const qf = join(tmpDir, "mag", "queue.jsonl");
    writeFileSync(qf, '{"id":"a"}\n');
    const { queuePopExpected } = await loadQueue();
    queuePopExpected();
    expect(existsSync(qf + ".lock")).toBe(false);
  });
});

describe("queue mutation paths release the lock", () => {
  test("queueReinsertHead cleans up lock dir", async () => {
    const { queueReinsertHead } = await loadQueue();
    queueReinsertHead('{"id":"x"}');
    expect(existsSync(join(tmpDir, "mag", "queue.jsonl.lock"))).toBe(false);
  });

  test("queuePopOne cleans up lock dir", async () => {
    writeFileSync(join(tmpDir, "mag", "queue.jsonl"), '{"id":"a"}\n');
    const { queuePopOne } = await loadQueue();
    queuePopOne();
    expect(existsSync(join(tmpDir, "mag", "queue.jsonl.lock"))).toBe(false);
  });

  test("queuePopAll cleans up lock dir", async () => {
    writeFileSync(join(tmpDir, "mag", "queue.jsonl"), '{"id":"a"}\n{"id":"b"}\n');
    const { queuePopAll } = await loadQueue();
    queuePopAll();
    expect(existsSync(join(tmpDir, "mag", "queue.jsonl.lock"))).toBe(false);
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
