import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { withSyntheticHarness } from "./test-utils.ts";

// Regression test: when invoked with { auto: true }, magBriefing skips the
// briefing → feedback-digest → /compact sequence if the previous sequence
// was queued less than 90 minutes ago. Manual (auto: false / undefined)
// invocations always queue and reset the cooldown timestamp.

const COOLDOWN_SECONDS = 90 * 60;
const getTmpDir = withSyntheticHarness(beforeEach, afterEach);

beforeEach(() => {
  mkdirSync(join(getTmpDir(), "mag"), { recursive: true });
  // gh-ludics-538: seed feedback/ so the briefing → feedback-digest →
  // /compact trio still produces 3 queue entries. Without this seed, the
  // new empty-feedback gate causes the digest follow-up to no-op.
  mkdirSync(join(getTmpDir(), "feedback"), { recursive: true });
  writeFileSync(join(getTmpDir(), "feedback", "seed.md"), "x");
});

function readQueue(): Record<string, unknown>[] {
  const qf = join(getTmpDir(), "mag", "queue.jsonl");
  if (!existsSync(qf)) return [];
  return readFileSync(qf, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function epochFile(): string {
  return join(getTmpDir(), "mag", "briefing-last-queued.epoch");
}

describe("magBriefing auto-cooldown gate", () => {
  test("auto-trigger skips queueing when last sequence < 90min ago", async () => {
    // Pre-seed the cooldown file with a timestamp 30 minutes in the past
    // (well under the 5400s window), so the gate must fire.
    const recent = Math.floor(Date.now() / 1000) - 30 * 60;
    writeFileSync(epochFile(), String(recent));

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { magBriefing } = await import("./mag.ts");
      magBriefing(false, 300, { auto: true });

      // Nothing was queued — not the briefing, not the feedback-digest, not /compact.
      expect(readQueue()).toHaveLength(0);

      const skipMsg = errSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .find((l) => l.includes("auto briefing skipped"));
      expect(skipMsg).toBeDefined();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("auto-trigger queues when last sequence > 90min ago", async () => {
    // Stale sentinel: 2 hours back, well past the cooldown window.
    const stale = Math.floor(Date.now() / 1000) - (COOLDOWN_SECONDS + 600);
    writeFileSync(epochFile(), String(stale));

    const { magBriefing } = await import("./mag.ts");
    magBriefing(false, 300, { auto: true });

    const items = readQueue();
    // Full trio queued; mirrors the contract from mag-auto-compact.test.ts.
    expect(items).toHaveLength(3);
    expect(items[0]!.action).toBe("briefing");
    expect(items[items.length - 1]!.action).toBe("message");
    expect(items[items.length - 1]!.content).toBe("/compact");

    // Cooldown sentinel was advanced.
    const after = Number.parseInt(readFileSync(epochFile(), "utf-8").trim(), 10);
    expect(after).toBeGreaterThan(stale);
  });

  test("auto-trigger queues when no prior sentinel exists", async () => {
    // No epoch file → first-ever auto run must proceed.
    expect(existsSync(epochFile())).toBe(false);

    const { magBriefing } = await import("./mag.ts");
    magBriefing(false, 300, { auto: true });

    expect(readQueue()).toHaveLength(3);
    expect(existsSync(epochFile())).toBe(true);
  });

  test("manual run inside cooldown still queues and refreshes sentinel", async () => {
    // Same recent sentinel that blocks auto must NOT block a manual run.
    const recent = Math.floor(Date.now() / 1000) - 30 * 60;
    writeFileSync(epochFile(), String(recent));

    const { magBriefing } = await import("./mag.ts");
    magBriefing(false); // no opts → auto: undefined → not auto

    expect(readQueue()).toHaveLength(3);
    const after = Number.parseInt(readFileSync(epochFile(), "utf-8").trim(), 10);
    // Manual run also resets the timer so a follow-up auto trigger waits its full window.
    expect(after).toBeGreaterThan(recent);
  });
});
