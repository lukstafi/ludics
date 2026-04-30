import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HOME = process.env.HOME;
let TMP = "";

function restoreEnv(vars: { home: string | undefined; config: string | undefined; harness: string | undefined }): void {
  if (vars.home === undefined) delete process.env.HOME;
  else process.env.HOME = vars.home;
  if (vars.config === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = vars.config;
  if (vars.harness === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = vars.harness;
}

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
  restoreEnv({ home: ORIGINAL_HOME, config: ORIGINAL_CONFIG, harness: ORIGINAL_HARNESS_DIR });
  rmSync(TMP, { recursive: true, force: true });
});

describe("eventsQuery validation", () => {
  // TODO(once-import-is-static): replace with captureConsoleLog from ./test-utils.ts
  // — the wrapper is only async because of the local `await import("./events.ts")`;
  // once that becomes a static top-level import this collapses to a one-liner.
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

describe("env teardown restoration", () => {
  test("restoreEnv restores all three sentinel values", () => {
    const preHome = process.env.HOME;
    const preConfig = process.env.LUDICS_CONFIG;
    const preHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      process.env.HOME = "/tmp/mutated-home";
      process.env.LUDICS_CONFIG = "/tmp/mutated-config";
      process.env.LUDICS_HARNESS_DIR = "/tmp/mutated-harness";
      restoreEnv({ home: "/sentinel-home", config: "/sentinel-config", harness: "/sentinel-harness" });
      expect(process.env.HOME).toBe("/sentinel-home");
      expect(process.env.LUDICS_CONFIG).toBe("/sentinel-config");
      expect(process.env.LUDICS_HARNESS_DIR).toBe("/sentinel-harness");
    } finally {
      restoreEnv({ home: preHome, config: preConfig, harness: preHarness });
    }
  });

  test("restoreEnv(undefined) deletes rather than setting literal 'undefined'", () => {
    const preHome = process.env.HOME;
    const preConfig = process.env.LUDICS_CONFIG;
    const preHarness = process.env.LUDICS_HARNESS_DIR;
    try {
      process.env.HOME = "/tmp/mutated-home";
      process.env.LUDICS_CONFIG = "/tmp/mutated-config";
      process.env.LUDICS_HARNESS_DIR = "/tmp/mutated-harness";
      restoreEnv({ home: undefined, config: undefined, harness: undefined });
      expect(process.env.HOME).toBeUndefined();
      expect(process.env.LUDICS_CONFIG).toBeUndefined();
      expect(process.env.LUDICS_HARNESS_DIR).toBeUndefined();
      expect(process.env.HOME).not.toBe("undefined");
      expect(process.env.LUDICS_CONFIG).not.toBe("undefined");
      expect(process.env.LUDICS_HARNESS_DIR).not.toBe("undefined");
    } finally {
      restoreEnv({ home: preHome, config: preConfig, harness: preHarness });
    }
  });
});
