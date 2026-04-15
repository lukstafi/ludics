import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HOME = process.env.HOME;
let TMP = "";

function harnessDir(): string {
  return join(TMP, "harness");
}

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state\nstate_path: harness\nslots:\n  count: 2\n`);
  return configPath;
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-04-10T00:00:00Z",
    epoch: 1775952000,
    event_type: "test_event",
    source: "test",
    scope: "unit",
    ...overrides,
  };
}

function writeEvents(lines: string[]): void {
  const journalDir = join(harnessDir(), "journal");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "events.jsonl"), lines.join("\n") + "\n");
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-events-test-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(harnessDir(), { recursive: true });
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME ?? undefined;
  process.env.LUDICS_CONFIG = ORIGINAL_CONFIG ?? undefined;
  process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR ?? undefined;
  rmSync(TMP, { recursive: true, force: true });
});

describe("eventsQuery validation", () => {
  async function captureOutput(args: string[]): Promise<string[]> {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      const { runEvents } = await import("./events.ts");
      runEvents(args);
    } finally {
      console.log = origLog;
    }
    return lines;
  }

  test("valid event objects appear in output", async () => {
    const event = makeEvent({ event_type: "deploy" });
    writeEvents([JSON.stringify(event)]);
    const output = await captureOutput(["--type", "deploy"]);
    expect(output.length).toBe(1);
    const parsed = JSON.parse(output[0]!);
    expect(parsed.event_type).toBe("deploy");
  });

  test("non-object JSON lines are skipped", async () => {
    writeEvents([
      '"hello"',
      "[1,2,3]",
      "null",
      "42",
      JSON.stringify(makeEvent()),
    ]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });

  test("object missing ts is skipped", async () => {
    const bad = makeEvent();
    delete bad.ts;
    writeEvents([JSON.stringify(bad), JSON.stringify(makeEvent())]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });

  test("object with non-number epoch is skipped", async () => {
    const bad = makeEvent({ epoch: "not-a-number" });
    writeEvents([JSON.stringify(bad), JSON.stringify(makeEvent())]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });

  test("object missing event_type is skipped", async () => {
    const bad = makeEvent();
    delete bad.event_type;
    writeEvents([JSON.stringify(bad), JSON.stringify(makeEvent())]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });

  test("object missing source is skipped", async () => {
    const bad = makeEvent();
    delete bad.source;
    writeEvents([JSON.stringify(bad), JSON.stringify(makeEvent())]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });

  test("object missing scope is skipped", async () => {
    const bad = makeEvent();
    delete bad.scope;
    writeEvents([JSON.stringify(bad), JSON.stringify(makeEvent())]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });

  test("malformed JSON lines are skipped", async () => {
    writeEvents(["{bad json", JSON.stringify(makeEvent())]);
    const output = await captureOutput([]);
    expect(output.length).toBe(1);
  });
});
