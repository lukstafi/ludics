import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { withSyntheticHarness } from "./test-utils.ts";

// Regression test for task-a00fc0d9 / docs/proposals/auto-compact-after-checkpoints.md:
// every queued health-check / briefing request must be followed by a
// { action: "message", content: "/compact" } request.

const getTmpDir = withSyntheticHarness(beforeEach, afterEach);

beforeEach(() => {
  // Synthetic config has no `cluster:` block → clusterEnabled() is false →
  // clusterIsController() returns true (standalone). That harness condition
  // is what lets these branches reach the queueRequest calls; if it stops
  // holding, both tests fail because the queue stays empty.
  mkdirSync(join(getTmpDir(), "mag"), { recursive: true });
});

function readQueue(): Record<string, unknown>[] {
  const qf = join(getTmpDir(), "mag", "queue.jsonl");
  const content = readFileSync(qf, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("magBriefing auto-compact follow-up", () => {
  test("enqueues /compact as the final item, with feedback-digest between briefing and /compact", async () => {
    // Harness condition: clean state — no pre-existing pending feedback-digest
    // in queue.jsonl, no cooldown state file. The synthetic harness creates a
    // fresh tmp dir each test, so both gates open and tryQueueFeedbackDigest
    // actually enqueues. If that condition stops holding, items[1] would not be
    // "feedback-digest" and the middle-slot assertion would fail loudly.
    const { magBriefing } = await import("./mag.ts");
    magBriefing(false);

    const items = readQueue();
    // briefing → feedback-digest → /compact. /compact must always land last
    // (the AC's invariant); feedback-digest in the middle is the ungated path.
    expect(items).toHaveLength(3);
    expect(items[0]!.action).toBe("briefing");
    expect(items[1]!.action).toBe("feedback-digest");
    expect(items[items.length - 1]!.action).toBe("message");
    expect(items[items.length - 1]!.content).toBe("/compact");
  });

  test("when feedback-digest is gated, queue is briefing → /compact (length 2)", async () => {
    // Harness condition: pre-seed queue.jsonl with a pending feedback-digest
    // entry for "ludics" so queueHasPendingFeedbackDigest() returns true and
    // tryQueueFeedbackDigest short-circuits with { queued: false }. Without
    // this seed, digest would fire and the length-2 assertion would fail.
    const qf = join(getTmpDir(), "mag", "queue.jsonl");
    writeFileSync(
      qf,
      JSON.stringify({ id: "seed", action: "feedback-digest", repo: "ludics" }) + "\n",
    );

    const { magBriefing } = await import("./mag.ts");
    magBriefing(false);

    const items = readQueue();
    // Drop the pre-seeded sentinel; only assert on what magBriefing wrote.
    const written = items.slice(1);
    expect(written).toHaveLength(2);
    expect(written[0]!.action).toBe("briefing");
    expect(written[1]!.action).toBe("message");
    expect(written[1]!.content).toBe("/compact");
    // /compact must be last regardless of digest gating.
    expect(items[items.length - 1]!.action).toBe("message");
    expect(items[items.length - 1]!.content).toBe("/compact");
  });

  test("/compact still enqueues when feedback-digest enqueue throws", async () => {
    // Harness condition: spy on queue.queueRequest to throw on the
    // feedback-digest action only (simulating a queue-lock timeout or
    // state-file write failure inside tryQueueFeedbackDigest). Without the
    // try/catch around the digest call, the throw would propagate out of
    // magBriefing before /compact is enqueued, leaving the queue with only
    // the briefing entry. Mutation: removing the try/catch makes this test
    // fail because /compact never lands and `errSpy` never sees the warning.
    const queueMod = await import("./queue.ts");
    const origQueueRequest = queueMod.queueRequest;
    let calls = 0;
    const requestSpy = spyOn(queueMod, "queueRequest").mockImplementation(
      ((req: Parameters<typeof origQueueRequest>[0]) => {
        calls++;
        if (req.action === "feedback-digest") {
          throw new Error("simulated queue-lock timeout");
        }
        return origQueueRequest(req);
      }) as typeof origQueueRequest,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const { magBriefing } = await import("./mag.ts");
      magBriefing(false);

      const items = readQueue();
      // briefing was queued (call 1), feedback-digest threw (call 2),
      // /compact still queued (call 3). On disk: briefing + /compact only.
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(items).toHaveLength(2);
      expect(items[0]!.action).toBe("briefing");
      expect(items[1]!.action).toBe("message");
      expect(items[1]!.content).toBe("/compact");
      const errLines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
      expect(errLines.some((l) => l.includes("feedback-digest enqueue failed"))).toBe(true);
    } finally {
      requestSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("runMag health-check auto-compact follow-up", () => {
  test("CLI enqueues only health-check; /compact is appended later by the gate-check path on a non-skipped delivery", async () => {
    const { runMag } = await import("./mag.ts");
    await runMag(["health-check"]);

    // /compact is no longer enqueued at CLI time — it's coupled to the gate
    // and appended by resolveQueueRequestCommand only when the gate does not
    // skip the delivery. This avoids spurious /compact on idle ticks.
    const items = readQueue();
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe("health-check");
  });

  test("non-skipped delivery appends /compact to the queue", async () => {
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    await runMag(["health-check"]);

    // Resolve with executeProgrammatic: true so the gate-check branch runs.
    // With no prior snapshot the gate fails open (first-run reason), so the
    // health-check resolves to its skill command and the auto-compact
    // follow-up is appended.
    const command = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(command).toBe("/ludics-health-check");

    const items = readQueue();
    expect(items).toHaveLength(2);
    expect(items[0]!.action).toBe("health-check");
    expect(items[1]!.action).toBe("message");
    expect(items[1]!.content).toBe("/compact");
  });

  test("gate-skipped delivery does not append /compact", async () => {
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");

    // Seed a prior snapshot so the gate has an anchor to compare against.
    // With currentLines == priorLines (delta 0), the gate skips.
    const eventsFile = join(getTmpDir(), "journal", "events.jsonl");
    mkdirSync(join(getTmpDir(), "journal"), { recursive: true });
    writeFileSync(eventsFile, '{"event_type":"placeholder"}\n');
    const snapPath = join(getTmpDir(), "mag", "health-last.json");
    writeFileSync(snapPath, JSON.stringify({ eventsJsonlLines: 1 }));

    await runMag(["health-check"]);
    const before = readQueue();
    expect(before).toHaveLength(1);

    const command = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(command).toBeNull();

    const after = readQueue();
    expect(after).toHaveLength(1);
    expect(after[0]!.action).toBe("health-check");
  });
});

describe("auto-compact does not fire for unrelated actions", () => {
  test("suggest enqueue does not append /compact", async () => {
    const { runMag } = await import("./mag.ts");
    await runMag(["suggest"]);

    const items = readQueue();
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe("suggest");
  });

  test("elaborate enqueue does not append /compact", async () => {
    const { runMag } = await import("./mag.ts");
    await runMag(["elaborate", "task-test"]);

    const items = readQueue();
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe("elaborate");
  });

  test("verify-container-completion <id> enqueues a single matching request", async () => {
    // Harness condition: the CLI sub-command exists and the dispatcher routes
    // to queueRequest with the right action+task. If the case were missing
    // (the round-1 reviewer's first remediation point), runMag would throw
    // and the queue would stay empty — both assertions would fail.
    const { runMag } = await import("./mag.ts");
    await runMag(["verify-container-completion", "task-parent"]);

    const items = readQueue();
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe("verify-container-completion");
    expect(items[0]!.task).toBe("task-parent");
  });

  test("verify-container-completion without an id throws", async () => {
    const { runMag } = await import("./mag.ts");
    await expect(runMag(["verify-container-completion"])).rejects.toThrow("task id required");
  });
});
