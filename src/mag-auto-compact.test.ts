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
  // gh-ludics-538: tryQueueFeedbackDigest now skips when feedback/ is empty.
  // Seed a single file so the feedback-digest follow-up actually enqueues in
  // the tests that exercise the briefing trio (briefing → feedback-digest →
  // /compact). Tests asserting the gated-feedback-digest path can clear or
  // ignore this seed; see the per-test setup.
  mkdirSync(join(getTmpDir(), "feedback"), { recursive: true });
  writeFileSync(join(getTmpDir(), "feedback", "seed.md"), "x");
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
  test("magBriefing enqueues briefing + feedback-digest only; /compact is appended later by the gate-check path", async () => {
    // Coupling change (fix-briefing-compact-gate): /compact is no longer
    // enqueued at magBriefing time. It's gated on the dispatch-time
    // activity gate to avoid paying a cache-miss cost on idle ticks that
    // skip the briefing. The CLI-time queue is therefore the briefing
    // and (when ungated) the feedback-digest follow-up only.
    const { magBriefing } = await import("./mag.ts");
    magBriefing(false);

    const items = readQueue();
    expect(items).toHaveLength(2);
    expect(items[0]!.action).toBe("briefing");
    expect(items[1]!.action).toBe("feedback-digest");
  });

  test("when feedback-digest is gated, magBriefing enqueues briefing only", async () => {
    // Harness condition: pre-seed queue.jsonl with a pending feedback-digest
    // entry for "ludics" so queueHasPendingFeedbackDigest() returns true and
    // tryQueueFeedbackDigest short-circuits with { queued: false }.
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
    expect(written).toHaveLength(1);
    expect(written[0]!.action).toBe("briefing");
  });

  test("magBriefing tolerates a feedback-digest enqueue throw and still reaches markBriefingQueued", async () => {
    // Regression guard for the try/catch around tryQueueFeedbackDigest: a
    // queue-lock timeout or state-file write error from the digest enqueue
    // must not propagate out of magBriefing before the cooldown sentinel is
    // refreshed. /compact is no longer involved in this coupling — it's
    // appended at dispatch time by resolveQueueRequestCommand once the gate
    // passes.
    const queueMod = await import("./queue.ts");
    const origQueueRequest = queueMod.queueRequest;
    const requestSpy = spyOn(queueMod, "queueRequest").mockImplementation(
      ((req: Parameters<typeof origQueueRequest>[0]) => {
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
      // briefing was queued (call 1), feedback-digest threw (call 2). On
      // disk: briefing only — /compact is deferred to the dispatch path.
      expect(items).toHaveLength(1);
      expect(items[0]!.action).toBe("briefing");
      const errLines = errSpy.mock.calls.map((c) => String(c[0] ?? ""));
      expect(errLines.some((l) => l.includes("feedback-digest enqueue failed"))).toBe(true);
      // Cooldown sentinel must have been refreshed — proof that magBriefing
      // ran to completion past the digest throw.
      const sentinel = join(getTmpDir(), "mag", "briefing-last-queued.epoch");
      const { existsSync } = await import("fs");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      requestSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("non-skipped briefing delivery appends /compact at the queue tail (after pending feedback-digest)", async () => {
    // Production flow: magBriefing enqueues briefing + feedback-digest,
    // then the queue-pop layer dispatches the briefing. The gate's RUN
    // arm appends /compact to the queue tail (not head — feedback-digest
    // must run BEFORE /compact so the digest can consume the briefing's
    // in-flight context per task-304a02a6). With no prior briefing
    // snapshot the gate fails open (first-run), so /compact is appended.
    const { magBriefing, resolveQueueRequestCommand } = await import("./mag.ts");
    const { queuePopExpected } = await import("./queue.ts");
    magBriefing(false);

    const popped = queuePopExpected();
    if (popped.status !== "popped") throw new Error(`expected popped, got ${popped.status}`);
    expect((popped.request as { action: string }).action).toBe("briefing");

    try {
      await resolveQueueRequestCommand(popped.request!, true);
    } catch {
      // briefingPrecomputeContext may throw in the synthetic harness — the
      // /compact enqueue happens before it, so the queue contract still
      // holds for our assertions below. The race-tail of the precompute
      // failure landing /compact correctly is exercised by mag-periodic-gate.
    }

    const items = readQueue();
    // After dispatch: feedback-digest first (still pending from enqueue
    // time), /compact appended at the tail. /compact must come AFTER
    // feedback-digest, not before.
    expect(items).toHaveLength(2);
    expect(items[0]!.action).toBe("feedback-digest");
    expect(items[1]!.action).toBe("message");
    expect(items[1]!.content).toBe("/compact");
  });

  test("repeated dispatch of the same briefing request does not double-queue /compact (Codex PR #552 review)", async () => {
    // Models deliverPoppedSkill's send-failure rollback loop: when the Mag
    // pane is unreachable, the popped briefing is reinserted at the queue
    // head and the next keepalive tick pops the same request id again. The
    // /compact follow-up must dedup on the second resolve, otherwise each
    // failed delivery attempt leaves an extra /compact tagged with the same
    // triggeredBy on the tail.
    const { magBriefing, resolveQueueRequestCommand } = await import("./mag.ts");
    const { queuePopExpected, queueReinsertHead } = await import("./queue.ts");
    magBriefing(false);

    // First pop + resolve — /compact gets appended.
    const popped1 = queuePopExpected();
    if (popped1.status !== "popped") throw new Error(`expected popped, got ${popped1.status}`);
    try {
      await resolveQueueRequestCommand(popped1.request!, true);
    } catch { /* precompute may throw in synthetic harness */ }

    // Simulate send-failure rollback: put the briefing back at the head with
    // the verbatim line (same id). deliverPoppedSkill does exactly this via
    // queueReinsertHead(popped.line).
    queueReinsertHead(popped1.line);

    // Second pop + resolve — must NOT add a second /compact for this trigger.
    const popped2 = queuePopExpected();
    if (popped2.status !== "popped") throw new Error(`expected popped, got ${popped2.status}`);
    expect((popped2.request as { id: string }).id).toBe((popped1.request as { id: string }).id);
    try {
      await resolveQueueRequestCommand(popped2.request!, true);
    } catch { /* precompute may throw in synthetic harness */ }

    const items = readQueue();
    const compactItems = items.filter(
      (r) => r.action === "message" && r.content === "/compact",
    );
    // Exactly one /compact across both dispatch attempts.
    expect(compactItems).toHaveLength(1);
    expect(compactItems[0]!.triggeredBy).toBe((popped1.request as { id: string }).id);
  });

  test("gate-skipped briefing delivery does not append /compact", async () => {
    // Idle world with a prior briefing snapshot → activity-window gate
    // skips the dispatched briefing record. The /compact enqueue lives
    // after the skip-return in resolveQueueRequestCommand, so it must
    // not fire. This is the bug the fix-briefing-compact-gate change
    // targets.
    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const stateDir = getTmpDir();
    mkdirSync(join(stateDir, "journal"), { recursive: true });
    // Prior snapshot present + empty events.jsonl + no recent activity →
    // latestUserActionEpoch returns 0 → gate skips.
    writeFileSync(
      join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: 1_000_000_000 }),
    );
    writeFileSync(join(stateDir, "journal", "events.jsonl"), "");

    const result = await resolveQueueRequestCommand({ action: "briefing" }, true);
    expect(result).toBeNull();

    // Nothing was enqueued by the skipped briefing dispatch — queue.jsonl
    // either doesn't exist (nothing ever called queueRequest) or is empty.
    const qf = join(stateDir, "mag", "queue.jsonl");
    const { existsSync } = await import("fs");
    if (existsSync(qf)) {
      expect(readQueue()).toHaveLength(0);
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

  test("non-skipped delivery enqueues /compact at the queue head", async () => {
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    const { queuePopExpected } = await import("./queue.ts");
    await runMag(["health-check"]);

    // Model the production flow: pop health-check first, then resolve.
    // With no prior snapshot the gate fails open (first-run reason), so the
    // health-check resolves to its skill command and the auto-compact
    // follow-up is enqueued.
    const popped = queuePopExpected();
    if (popped.status !== "popped") throw new Error(`expected popped, got ${popped.status}`);
    const command = await resolveQueueRequestCommand(popped.request!, true);
    expect(command).toBe("/ludics-health-check");

    const items = readQueue();
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe("message");
    expect(items[0]!.content).toBe("/compact");
  });

  test("intervening enqueues don't slip in front of /compact (Codex P2 regression)", async () => {
    // Models the race: another request lands on the queue tail between
    // `mag health-check` enqueue and the moment health-check is popped for
    // dispatch. The /compact follow-up must still run *immediately after*
    // the triggering health-check, not after the intervening tail item —
    // otherwise the "trim context before next heavy action" guarantee from
    // task-a00fc0d9 breaks.
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    const { queuePopExpected } = await import("./queue.ts");

    await runMag(["health-check"]);            // queue: [health-check]
    await runMag(["elaborate", "task-x"]);     // queue: [health-check, elaborate]

    // Pop the head (health-check) as production does, then resolve.
    const popped = queuePopExpected();
    if (popped.status !== "popped") throw new Error(`expected popped, got ${popped.status}`);
    expect((popped.request as { action: string }).action).toBe("health-check");

    const command = await resolveQueueRequestCommand(popped.request!, true);
    expect(command).toBe("/ludics-health-check");

    // /compact must be at queue head (the position the popped health-check
    // vacated), ahead of the intervening elaborate.
    const items = readQueue();
    expect(items).toHaveLength(2);
    expect(items[0]!.action).toBe("message");
    expect(items[0]!.content).toBe("/compact");
    expect(items[1]!.action).toBe("elaborate");
  });

  test("repeated dispatch of the same health-check request does not double-queue /compact (Codex PR #552 review)", async () => {
    // Symmetric to the briefing case: deliverPoppedSkill's send-failure
    // rollback reinserts the popped health-check at the queue head with the
    // verbatim line; the next dispatch resolves the same request id again.
    // The /compact follow-up must dedup on the second resolve.
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    const { queuePopExpected, queueReinsertHead } = await import("./queue.ts");
    await runMag(["health-check"]);

    const popped1 = queuePopExpected();
    if (popped1.status !== "popped") throw new Error(`expected popped, got ${popped1.status}`);
    await resolveQueueRequestCommand(popped1.request!, true);

    // Simulate the rollback that deliverPoppedSkill performs on send failure.
    queueReinsertHead(popped1.line);

    const popped2 = queuePopExpected();
    if (popped2.status !== "popped") throw new Error(`expected popped, got ${popped2.status}`);
    expect((popped2.request as { id: string }).id).toBe((popped1.request as { id: string }).id);
    await resolveQueueRequestCommand(popped2.request!, true);

    const items = readQueue();
    const compactItems = items.filter(
      (r) => r.action === "message" && r.content === "/compact",
    );
    expect(compactItems).toHaveLength(1);
    expect(compactItems[0]!.triggeredBy).toBe((popped1.request as { id: string }).id);
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
