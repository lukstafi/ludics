import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveQueueRequestCommand } from "./mag.ts";

describe("resolveQueueRequestCommand — health-check activity gate", () => {
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_CLUSTER_NAME = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mag-health-gate-"));
    mkdirSync(join(stateDir, "journal"), { recursive: true });
    mkdirSync(join(stateDir, "mag"), { recursive: true });
    // Minimal config with no projects so runAllTestHealth() is a no-op
    // when the gate does not skip.
    configPath = join(stateDir, "config.yaml");
    writeFileSync(configPath, "state_repo: test/state\nstate_path: harness\nprojects: []\n");
    process.env.LUDICS_HARNESS_DIR = stateDir;
    process.env.LUDICS_CONFIG = configPath;
    delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
  });

  afterEach(() => {
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_CLUSTER_NAME === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
    else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_CLUSTER_NAME;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("returns null and emits health_check_skipped when delta < 50", async () => {
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
  });

  test("peek path (executeProgrammatic=false) returns skill command regardless of gate", async () => {
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
    const lines = Array.from({ length: 5 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);

    const result = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(result).toBe("/ludics-health-check");
  });

  test("delta over threshold returns skill command", async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    writeFileSync(join(stateDir, "journal", "events.jsonl"), lines);
    writeFileSync(
      join(stateDir, "mag", "health-last.json"),
      JSON.stringify({ timestamp: "x", eventsJsonlLines: 1000 }),
    );

    const result = await resolveQueueRequestCommand({ action: "health-check" }, true);
    expect(result).toBe("/ludics-health-check");
  });
});
