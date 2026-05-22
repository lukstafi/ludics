import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { withSyntheticHarness } from "./test-utils.ts";

// Note: resolveQueueRequestCommand is async-imported per-test to avoid loading
// mag.ts side-effects until the synthetic harness is wired.

function readEvents(stateDir: string): Record<string, unknown>[] {
  const path = join(stateDir, "journal", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function findLastEvent(stateDir: string, type: string): Record<string, unknown> | null {
  const evs = readEvents(stateDir);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i]!.event_type === type) return evs[i]!;
  }
  return null;
}

function makeJournal(stateDir: string): void {
  mkdirSync(join(stateDir, "journal"), { recursive: true });
  mkdirSync(join(stateDir, "mag"), { recursive: true });
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function writeEvent(stateDir: string, ev: Record<string, unknown>): void {
  const ts = new Date((ev.epoch as number) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const line = JSON.stringify({ ts, source: "test", scope: "test", ...ev });
  writeFileSync(join(stateDir, "journal", "events.jsonl"), line + "\n", { flag: "a" });
}

// --- Briefing Tier-1 gate arm (Step 6) ---

describe("briefing Tier-1 arm — activity-window gate (gh-ludics-538 AC 3)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("idle + no activity + prior snapshot → skip + emits briefing_skipped + does NOT precompute", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Prior briefing snapshot from many days ago — proves we've been here before.
    writeFileSync(join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: 1_000_000_000 }));
    // Empty events.jsonl + no tasks/ → latestUserActionEpoch returns 0.
    writeFileSync(join(stateDir, "journal", "events.jsonl"), "");

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "briefing" }, true);
    expect(result).toBeNull();

    const last = findLastEvent(stateDir, "briefing_skipped");
    expect(last).not.toBeNull();
    expect((last!.meta as Record<string, unknown>).gateSkip).toBe(true);
    expect(String(last!.message)).toContain("no qualifying user activity");

    // Briefing precompute was NOT called — no briefing-context.md file.
    expect(existsSync(join(stateDir, "mag", "briefing-context.md"))).toBe(false);
  });

  test("first run (no snapshot) → run (no skip event emitted)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // No snapshot, empty events → signal=0 → first-run fail-open → RUN.
    // Precompute will partially run (and may write briefing-context.md);
    // we only assert the skip event was NOT emitted.
    writeFileSync(join(stateDir, "journal", "events.jsonl"), "");

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    try {
      await resolveQueueRequestCommand({ action: "briefing" }, true);
    } catch { /* precompute may fail in synthetic harness — that's OK */ }

    const last = findLastEvent(stateDir, "briefing_skipped");
    expect(last).toBeNull();
    // Snapshot was refreshed on the RUN arm.
    expect(existsSync(join(stateDir, "mag", "briefing-last.json"))).toBe(true);
  }, 20_000); // briefing RUN arm awaits briefingPrecomputeContext, which spawns
  // `ludics` subprocesses; the 5s default times out under full-suite load.

  test("fresh notify_incoming → run, briefing_skipped NOT emitted, snapshot refreshed", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Prior snapshot many seconds older than the fresh notify event.
    writeFileSync(join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: nowEpoch() - 7200 }));
    writeEvent(stateDir, { event_type: "notify_incoming", epoch: nowEpoch() - 60, message: "user said hi" });

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    try {
      await resolveQueueRequestCommand({ action: "briefing" }, true);
    } catch { /* precompute may fail in synthetic harness */ }

    const last = findLastEvent(stateDir, "briefing_skipped");
    expect(last).toBeNull();
  }, 20_000); // briefing RUN arm awaits briefingPrecomputeContext — see above.

  test("peek path (executeProgrammatic=false) bypasses gate (AC 11)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Setup a state that WOULD skip — idle + prior snapshot.
    writeFileSync(join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: 1_000_000_000 }));
    writeFileSync(join(stateDir, "journal", "events.jsonl"), "");

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "briefing" }, false);
    expect(result).toBe("/ludics-briefing");

    // No skip event — gate did not run.
    expect(findLastEvent(stateDir, "briefing_skipped")).toBeNull();
  });

  test("manual CLI `ludics mag briefing` bypasses the gate — tagged record runs the skill despite a would-skip snapshot (AC 11/15)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Would-skip world: idle (empty events → latestUserActionEpoch===0) with a
    // prior snapshot present → activity-window gate would skip a gated request.
    writeFileSync(join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: 1_000_000_000 }));
    writeFileSync(join(stateDir, "journal", "events.jsonl"), "");

    // CLI path: `ludics mag briefing` dispatches to magBriefing(true,300,{}) —
    // opts.auto is falsy → manual invocation.
    const { magBriefing, resolveQueueRequestCommand } = await import("./mag.ts");
    magBriefing(false);

    // The CLI handler tagged the enqueued briefing record with bypassGate.
    const qLines = readFileSync(join(stateDir, "mag", "queue.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const briefingRec = qLines.find((r) => r.action === "briefing");
    expect(briefingRec).toBeDefined();
    expect(briefingRec!.bypassGate).toBe(true);

    // Dispatch that exact record: the gate is bypassed, so NO briefing_skipped
    // event is emitted despite the would-skip snapshot. (Precompute may throw
    // in the synthetic harness — the skip decision is already made before it,
    // and the negative-control test below proves this same world DOES skip a
    // non-bypass record, so "no event" here can only mean the gate was skipped.)
    try { await resolveQueueRequestCommand(briefingRec!, true); }
    catch { /* precompute may fail in synthetic harness */ }
    expect(findLastEvent(stateDir, "briefing_skipped")).toBeNull();
  }, 20_000); // briefing RUN arm awaits briefingPrecomputeContext — see above.

  test("auto trigger briefing does NOT bypass the gate — auto record stays gated and skips (AC 11 negative control)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    writeFileSync(join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: 1_000_000_000 }));
    writeFileSync(join(stateDir, "journal", "events.jsonl"), "");

    // Auto path: magBriefing(...,{ auto: true }) — the launchd-trigger shape.
    const { magBriefing, resolveQueueRequestCommand } = await import("./mag.ts");
    magBriefing(false, 300, { auto: true });

    const qLines = readFileSync(join(stateDir, "mag", "queue.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const briefingRec = qLines.find((r) => r.action === "briefing");
    expect(briefingRec).toBeDefined();
    // Auto record carries NO bypassGate → still subject to the gate.
    expect("bypassGate" in briefingRec!).toBe(false);

    const result = await resolveQueueRequestCommand(briefingRec!, true);
    expect(result).toBeNull();
    expect(findLastEvent(stateDir, "briefing_skipped")).not.toBeNull();
  });

  test("manual CLI `ludics mag health-check` bypasses the gate — enqueued record carries bypassGate:true (AC 11)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Would-skip world: delta below HEALTH_GATE_THRESHOLD (300). A gated record
    // dispatched here would skip; the bypass flag overrides that.
    const lines = Array.from({ length: 1010 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);
    writeFileSync(join(stateDir, "mag", "health-last.json"),
      JSON.stringify({ timestamp: "2026-04-24T00:00:00Z", eventsJsonlLines: 1000, findings: [] }));

    // CLI path: `ludics mag health-check` (no --auto) — manual invocation.
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    await runMag(["health-check"]);

    // The CLI handler tagged the enqueued health-check record with bypassGate.
    const qLines = readFileSync(join(stateDir, "mag", "queue.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const hcRec = qLines.find((r) => r.action === "health-check");
    expect(hcRec).toBeDefined();
    expect(hcRec!.bypassGate).toBe(true);

    // Dispatch that exact record: the gate is bypassed despite the would-skip
    // delta, so the skill command is returned and no skip event is emitted.
    const result = await resolveQueueRequestCommand(hcRec!, true);
    expect(result).toBe("/ludics-health-check");
    expect(findLastEvent(stateDir, "health_check_skipped")).toBeNull();
  });

  test("auto trigger `ludics mag health-check --auto` does NOT bypass the gate — record stays gated and skips (AC 11 negative control)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Same would-skip world as the bypass test above.
    const lines = Array.from({ length: 1010 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);
    writeFileSync(join(stateDir, "mag", "health-last.json"),
      JSON.stringify({ timestamp: "2026-04-24T00:00:00Z", eventsJsonlLines: 1000, findings: [] }));

    // Auto path: the launchd-trigger shape — `mag health-check --auto`.
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    await runMag(["health-check", "--auto"]);

    const qLines = readFileSync(join(stateDir, "mag", "queue.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const hcRec = qLines.find((r) => r.action === "health-check");
    expect(hcRec).toBeDefined();
    // Auto record carries bypassGate:false → still subject to the gate.
    expect(hcRec!.bypassGate).toBeFalsy();

    const result = await resolveQueueRequestCommand(hcRec!, true);
    expect(result).toBeNull();
    expect(findLastEvent(stateDir, "health_check_skipped")).not.toBeNull();
  });

  test("Mag-auto briefing queue_request does NOT advance the signal (denylist active)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    writeFileSync(join(stateDir, "mag", "briefing-last.json"),
      JSON.stringify({ timestamp: "2026-04-01T00:00:00Z", signal: 1_000_000_000 }));
    // Only Mag-auto activity in the events log — would NOT count as user-action.
    writeEvent(stateDir, { event_type: "queue_request", epoch: nowEpoch() - 60, action: "briefing", message: "req-x" });
    writeEvent(stateDir, { event_type: "queue_request", epoch: nowEpoch() - 30, action: "message", messageContent: "/compact", message: "req-y" });

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "briefing" }, true);
    expect(result).toBeNull();
    const last = findLastEvent(stateDir, "briefing_skipped");
    expect(last).not.toBeNull();
  });
});

// --- adopt-sessions Tier-1 arm (Step 7) ---

describe("adopt-sessions Tier-1 arm — fingerprint gate (gh-ludics-538 AC 9)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  function writeSessionsJson(stateDir: string, unclassified: Record<string, unknown>[]): void {
    writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({ unclassified }));
  }

  test("fingerprint unchanged → skip + emits adopt_sessions_skipped + no precompute", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    writeSessionsJson(stateDir, [{ cwd: "/a", agents: ["claude"], ids: ["s1"] }]);

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    // First call: gate runs (first-run fail-open) → snapshot written.
    try { await resolveQueueRequestCommand({ action: "adopt-sessions" }, true); } catch { /* ok */ }
    // Second call with identical sessions → fingerprint unchanged → skip.
    const result = await resolveQueueRequestCommand({ action: "adopt-sessions" }, true);
    expect(result).toBeNull();

    const last = findLastEvent(stateDir, "adopt_sessions_skipped");
    expect(last).not.toBeNull();
    expect((last!.meta as Record<string, unknown>).gateSkip).toBe(true);
    // AC 3/12: signal pair on the skip event mirrors the health_check shape.
    // For fingerprint gates, current === prior on the skip arm (that's why it
    // skipped); both must be strings, not null.
    expect(typeof last!.current).toBe("string");
    expect(typeof last!.prior).toBe("string");
    expect(last!.current).toBe(last!.prior);
  });

  test("fingerprint changed → run + snapshot refreshed", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    writeSessionsJson(stateDir, [{ cwd: "/a", agents: ["claude"], ids: ["s1"] }]);
    const { resolveQueueRequestCommand } = await import("./mag.ts");
    try { await resolveQueueRequestCommand({ action: "adopt-sessions" }, true); } catch { /* ok */ }

    // Change sessions content → new fingerprint.
    writeSessionsJson(stateDir, [{ cwd: "/b", agents: ["claude"], ids: ["s2"] }]);
    const result = await resolveQueueRequestCommand({ action: "adopt-sessions" }, true);
    // Run-arm yields the skill command from the registry.
    expect(typeof result).toBe("string");

    expect(findLastEvent(stateDir, "adopt_sessions_skipped")).toBeNull();
  });

  test("peek path bypasses gate", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    writeSessionsJson(stateDir, [{ cwd: "/a", agents: ["claude"], ids: ["s1"] }]);
    // Pre-seed snapshot so the gate would otherwise SKIP.
    // (Compute the fingerprint by running once first.)
    const { resolveQueueRequestCommand } = await import("./mag.ts");
    try { await resolveQueueRequestCommand({ action: "adopt-sessions" }, true); } catch { /* ok */ }

    const result = await resolveQueueRequestCommand({ action: "adopt-sessions" }, false);
    expect(typeof result).toBe("string");
    expect(result).toContain("adopt-sessions");
  });
});

// --- verify-completion Tier-1 arm (Step 8) ---

describe("verify-completion Tier-1 arm — epoch-unchanged gate (gh-ludics-538 AC 10)", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("task unchanged since prior check → skip + emits verify_completion_skipped", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Seed a prior snapshot with a known epoch.
    mkdirSync(join(stateDir, "mag", "verify-completion-last"), { recursive: true });
    const knownEpoch = nowEpoch();
    writeFileSync(join(stateDir, "mag", "verify-completion-last", "task-foo.json"),
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", signal: knownEpoch }));
    // Source data: one slot_resume event at the same epoch (no advance).
    writeEvent(stateDir, { event_type: "slot_resume", epoch: knownEpoch, task: "task-foo" });

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "verify-completion", task: "task-foo" }, true);
    expect(result).toBeNull();

    const last = findLastEvent(stateDir, "verify_completion_skipped");
    expect(last).not.toBeNull();
    expect(last!.task).toBe("task-foo");
    expect((last!.meta as Record<string, unknown>).gateSkip).toBe(true);
    // AC 3/12: signal pair on the skip event. epoch-unchanged carries number
    // epochs for current and prior. Both must be numbers, not null.
    expect(typeof last!.current).toBe("number");
    expect(typeof last!.prior).toBe("number");
    expect(last!.prior).toBe(knownEpoch);
  });

  test("task with newer event → run + snapshot refreshed", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    mkdirSync(join(stateDir, "mag", "verify-completion-last"), { recursive: true });
    const priorEpoch = nowEpoch() - 1000;
    writeFileSync(join(stateDir, "mag", "verify-completion-last", "task-bar.json"),
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", signal: priorEpoch }));
    // Newer slot_resume event for the task.
    writeEvent(stateDir, { event_type: "slot_resume", epoch: nowEpoch(), task: "task-bar" });

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "verify-completion", task: "task-bar" }, true);
    // Run-arm yields the verify-completion skill command.
    expect(typeof result).toBe("string");

    expect(findLastEvent(stateDir, "verify_completion_skipped")).toBeNull();
    // Snapshot was refreshed (mtime > priorEpoch * 1000).
    const sStat = statSync(join(stateDir, "mag", "verify-completion-last", "task-bar.json"));
    expect(sStat.mtimeMs / 1000).toBeGreaterThan(priorEpoch);
  });

  test("activity on task A does NOT affect task B's snapshot (cross-task isolation)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    mkdirSync(join(stateDir, "mag", "verify-completion-last"), { recursive: true });
    const priorEpoch = nowEpoch();
    // Both tasks share the same prior snapshot epoch.
    writeFileSync(join(stateDir, "mag", "verify-completion-last", "task-A.json"),
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", signal: priorEpoch }));
    writeFileSync(join(stateDir, "mag", "verify-completion-last", "task-B.json"),
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", signal: priorEpoch }));
    // A fresh event for task A only.
    writeEvent(stateDir, { event_type: "slot_resume", epoch: nowEpoch() + 100, task: "task-A" });

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    // Task A → run.
    const a = await resolveQueueRequestCommand({ action: "verify-completion", task: "task-A" }, true);
    expect(typeof a).toBe("string");
    // Task B → skip (its own snapshot, no event for it).
    const b = await resolveQueueRequestCommand({ action: "verify-completion", task: "task-B" }, true);
    expect(b).toBeNull();

    const lastB = findLastEvent(stateDir, "verify_completion_skipped");
    expect(lastB).not.toBeNull();
    expect(lastB!.task).toBe("task-B");
  });

  test("first run (no snapshot) → run", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    writeEvent(stateDir, { event_type: "slot_resume", epoch: nowEpoch(), task: "task-new" });

    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "verify-completion", task: "task-new" }, true);
    expect(typeof result).toBe("string");
    expect(findLastEvent(stateDir, "verify_completion_skipped")).toBeNull();
    // Snapshot now exists.
    expect(existsSync(join(stateDir, "mag", "verify-completion-last", "task-new.json"))).toBe(true);
  });

  test("manual CLI `ludics mag verify-completion <task>` bypasses the gate — the AC-15 peer (AC 11/15)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Would-skip world: a prior per-task snapshot exists and there is no newer
    // activity for the task → computeTaskLastActivityEpoch returns 0 →
    // epoch-unchanged gate would skip a gated (non-bypass) request.
    mkdirSync(join(stateDir, "mag", "verify-completion-last"), { recursive: true });
    writeFileSync(join(stateDir, "mag", "verify-completion-last", "task-peer.json"),
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", signal: 1_700_000_000 }));

    // CLI path: `ludics mag verify-completion task-peer` dispatches through
    // runMag to the verify-completion subcommand handler.
    const { runMag, resolveQueueRequestCommand } = await import("./mag.ts");
    await runMag(["verify-completion", "task-peer"]);

    // The CLI handler tagged the enqueued record with bypassGate.
    const qLines = readFileSync(join(stateDir, "mag", "queue.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const vcRec = qLines.find((r) => r.action === "verify-completion");
    expect(vcRec).toBeDefined();
    expect(vcRec!.task).toBe("task-peer");
    expect(vcRec!.bypassGate).toBe(true);

    // Dispatch that exact record under the would-skip snapshot: the gate is
    // bypassed → the verify-completion skill command is returned and NO
    // verify_completion_skipped event is emitted.
    const result = await resolveQueueRequestCommand(vcRec!, true);
    expect(typeof result).toBe("string");
    expect(findLastEvent(stateDir, "verify_completion_skipped")).toBeNull();
  });

  test("auto-created verify-completion record (no bypassGate) stays gated and skips (AC 11 peer negative control)", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    // Same would-skip world as the bypass test above.
    mkdirSync(join(stateDir, "mag", "verify-completion-last"), { recursive: true });
    writeFileSync(join(stateDir, "mag", "verify-completion-last", "task-peer.json"),
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", signal: 1_700_000_000 }));

    // A record WITHOUT bypassGate — the shape an auto-enqueued verify-completion
    // request has. Same world, only the tag differs → clean mutation pair.
    const { resolveQueueRequestCommand } = await import("./mag.ts");
    const result = await resolveQueueRequestCommand({ action: "verify-completion", task: "task-peer" }, true);
    expect(result).toBeNull();
    const last = findLastEvent(stateDir, "verify_completion_skipped");
    expect(last).not.toBeNull();
    expect(last!.task).toBe("task-peer");
  });
});

// --- Feedback-digest empty-skip via briefing's auto-followup path -------

describe("feedback-digest gate emits feedback_digest_skipped on empty surface", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  test("manual CLI feedback-digest skips when feedback/ is empty + no cooldown mark", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    mkdirSync(join(stateDir, "feedback"), { recursive: true });
    // No files in feedback/.

    // Drive via the CLI dispatcher's "feedback-digest" entry through runMag.
    // The dispatcher is private; use runMag via the public CLI entry.
    const { runMag } = await import("./mag.ts");
    // runMag(["feedback-digest"]) calls tryQueueFeedbackDigest("ludics") internally.
    await runMag(["feedback-digest"]);

    const last = findLastEvent(stateDir, "feedback_digest_skipped");
    expect(last).not.toBeNull();
    expect((last!.meta as Record<string, unknown>).gateSkip).toBe(true);
    expect(String(last!.message)).toContain("no feedback files");
    // Cooldown file was NOT created (the skip MUST NOT refresh the cooldown).
    expect(existsSync(join(stateDir, "mag", "feedback-digest-last-queued.json"))).toBe(false);
  });

  test("non-empty feedback/ → queues + writes cooldown", async () => {
    const stateDir = getStateDir();
    makeJournal(stateDir);
    mkdirSync(join(stateDir, "feedback"), { recursive: true });
    writeFileSync(join(stateDir, "feedback", "f1.md"), "x");

    const { runMag } = await import("./mag.ts");
    await runMag(["feedback-digest"]);

    expect(findLastEvent(stateDir, "feedback_digest_skipped")).toBeNull();
    expect(existsSync(join(stateDir, "mag", "feedback-digest-last-queued.json"))).toBe(true);
  });
});
