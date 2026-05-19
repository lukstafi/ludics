import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveQueueRequestCommand } from "./mag.ts";
import { withSyntheticHarness } from "./test-utils.ts";

describe("resolveQueueRequestCommand — health-check activity gate", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach);

  beforeEach(() => {
    mkdirSync(join(getStateDir(), "journal"), { recursive: true });
    mkdirSync(join(getStateDir(), "mag"), { recursive: true });
  });

  test("returns null and emits health_check_skipped when delta < threshold", async () => {
    const stateDir = getStateDir();
    const lines = Array.from({ length: 1030 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);
    writeFileSync(
      join(stateDir, "mag", "health-last.json"),
      JSON.stringify({ timestamp: "2026-04-24T00:00:00Z", eventsJsonlLines: 1000, findings: [] }),
    );

    const result = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(result).toBeNull();

    const evPath = join(stateDir, "journal", "events.jsonl");
    expect(existsSync(evPath)).toBe(true);
    const evBody = readFileSync(evPath, "utf8").trim().split("\n");
    const last = JSON.parse(evBody[evBody.length - 1]!);
    expect(last.event_type).toBe("health_check_skipped");
    expect(last.source).toBe("keepalive");
    expect(last.scope).toBe("mag");
    expect(last.currentLines).toBe(1030);
    expect(last.priorLines).toBe(1000);
    expect(last.delta).toBe(30);
    // gh-ludics-538: unified gate-skip marker.
    expect(last.meta?.gateSkip).toBe(true);
  });

  test("peek path (executeProgrammatic=false) returns skill command regardless of gate", async () => {
    const stateDir = getStateDir();
    const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);
    writeFileSync(
      join(stateDir, "mag", "health-last.json"),
      JSON.stringify({ timestamp: "x", eventsJsonlLines: 9 }),
    );

    const result = await resolveQueueRequestCommand({ action: "health-check" }, false);
    expect(result).toBe("/ludics-health-check");
  });

  test("first run (no health-last.json) returns skill command", async () => {
    const stateDir = getStateDir();
    const lines = Array.from({ length: 5 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);

    const result = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(result).toBe("/ludics-health-check");
  });

  test("delta over threshold returns skill command", async () => {
    const stateDir = getStateDir();
    // Threshold bumped 50 → 300 (gh-ludics-538). Use delta=400 to stay
    // unambiguously over the new threshold while continuing to assert
    // "delta exceeds gate" semantics.
    const lines = Array.from({ length: 1400 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);
    writeFileSync(
      join(stateDir, "mag", "health-last.json"),
      JSON.stringify({ timestamp: "x", eventsJsonlLines: 1000 }),
    );

    const result = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(result).toBe("/ludics-health-check");
  });
});
