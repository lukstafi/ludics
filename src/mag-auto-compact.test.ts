import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Regression test for task-a00fc0d9 / docs/proposals/auto-compact-after-checkpoints.md:
// every queued health-check / briefing request must be followed by a
// { action: "message", content: "/compact" } request.

let tmpDir: string;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_CLUSTER_NAME = process.env.LUDICS_CLUSTER_MACHINE_NAME;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ludics-auto-compact-"));
  mkdirSync(join(tmpDir, "mag"), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = tmpDir;
  // No config file → loadConfigSync throws → clusterEnabled() is false →
  // clusterIsController() returns true (standalone). That harness condition
  // is what lets these branches reach the queueRequest calls; if it stops
  // holding, both tests fail because the queue stays empty.
  delete process.env.LUDICS_CONFIG;
  delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_CLUSTER_NAME === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
  else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_CLUSTER_NAME;
});

function readQueue(): Record<string, unknown>[] {
  const qf = join(tmpDir, "mag", "queue.jsonl");
  const content = readFileSync(qf, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("magBriefing auto-compact follow-up", () => {
  test("enqueues /compact directly behind the briefing entry", async () => {
    const { magBriefing } = await import("./mag.ts");
    magBriefing(false);

    const items = readQueue();
    // Must be at least: briefing, /compact (feedback-digest may follow).
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]!.action).toBe("briefing");
    expect(items[1]!.action).toBe("message");
    expect(items[1]!.content).toBe("/compact");
  });
});

describe("runMag health-check auto-compact follow-up", () => {
  test("enqueues /compact directly behind the health-check entry", async () => {
    const { runMag } = await import("./mag.ts");
    await runMag(["health-check"]);

    const items = readQueue();
    expect(items).toHaveLength(2);
    expect(items[0]!.action).toBe("health-check");
    expect(items[1]!.action).toBe("message");
    expect(items[1]!.content).toBe("/compact");
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
});
