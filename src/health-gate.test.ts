import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { shouldSkipHealthCheck, HEALTH_GATE_THRESHOLD } from "./health-gate.ts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `health-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "journal"), { recursive: true });
  mkdirSync(join(dir, "mag"), { recursive: true });
  return dir;
}

function writeEvents(dir: string, lines: number): void {
  const body = Array.from({ length: lines }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
  writeFileSync(join(dir, "journal", "events.jsonl"), body);
}

function writeSnapshot(dir: string, obj: Record<string, unknown>): void {
  writeFileSync(join(dir, "mag", "health-last.json"), JSON.stringify(obj));
}

describe("shouldSkipHealthCheck", () => {
  test("first run with no health-last.json → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 100);
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.priorLines).toBe(0);
    expect(res.reason).toContain("first run");
    rmSync(dir, { recursive: true });
  });

  test("snapshot present but missing eventsJsonlLines → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 100);
    writeSnapshot(dir, { timestamp: "2026-04-24T00:00:00Z", findings: [] });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("eventsJsonlLines");
    rmSync(dir, { recursive: true });
  });

  test("delta under threshold → skip: true", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 1030);
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(true);
    expect(res.currentLines).toBe(1030);
    expect(res.priorLines).toBe(1000);
    expect(res.reason).toContain("30");
    rmSync(dir, { recursive: true });
  });

  test("delta exactly at threshold (50) → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 1050);
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.currentLines - res.priorLines).toBe(HEALTH_GATE_THRESHOLD);
    rmSync(dir, { recursive: true });
  });

  test("delta over threshold → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 1200);
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.currentLines).toBe(1200);
    expect(res.priorLines).toBe(1000);
    rmSync(dir, { recursive: true });
  });

  test("events.jsonl missing → skip: false (fail open)", () => {
    const dir = makeTmpDir();
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("fail open");
    rmSync(dir, { recursive: true });
  });

  test("events.jsonl empty → skip: false (fail open)", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "journal", "events.jsonl"), "");
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("fail open");
    rmSync(dir, { recursive: true });
  });

  test("non-numeric eventsJsonlLines → skip: false", () => {
    const dir = makeTmpDir();
    writeEvents(dir, 100);
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: "1000" });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("eventsJsonlLines");
    rmSync(dir, { recursive: true });
  });

  test("line count handles file without trailing newline", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "journal", "events.jsonl"), "a\nb\nc");
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.currentLines).toBe(3);
    rmSync(dir, { recursive: true });
  });

  test("negative delta (rotated/compacted log) → skip: false (fail open)", () => {
    const dir = makeTmpDir();
    // Current file has 200 eligible lines; prior anchor claims 1000.
    writeEvents(dir, 200);
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 1000 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("backward");
    expect(res.reason).toContain("fail open");
    expect(res.currentLines).toBe(200);
    expect(res.priorLines).toBe(1000);
    rmSync(dir, { recursive: true });
  });

  test("health_check_skipped events are excluded from the gate count", () => {
    const dir = makeTmpDir();
    // 40 real events + 20 skip-marker events = 60 physical lines, but only
    // 40 gate-eligible. Prior 0 → delta 40 < 50 → skip.
    const realLines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ event_type: "mag_queue_feed", n: i }));
    const skipLines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ event_type: "health_check_skipped", n: i }));
    writeFileSync(join(dir, "journal", "events.jsonl"), [...realLines, ...skipLines].join("\n") + "\n");
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.currentLines).toBe(40);
    expect(res.skip).toBe(true);
  });

  test("many skip-marker events alone cannot push delta over threshold", () => {
    const dir = makeTmpDir();
    // Simulate 100 accumulated skip events and 0 real activity since last run.
    const skipLines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ event_type: "health_check_skipped", n: i }));
    writeFileSync(join(dir, "journal", "events.jsonl"), skipLines.join("\n") + "\n");
    writeSnapshot(dir, { timestamp: "x", eventsJsonlLines: 0 });
    const res = shouldSkipHealthCheck({ stateDir: dir });
    expect(res.currentLines).toBe(0);
    expect(res.skip).toBe(false);
    expect(res.reason).toContain("empty");
  });
});
