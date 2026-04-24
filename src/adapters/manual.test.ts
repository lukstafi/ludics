import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readState, start, stop } from "./manual.ts";
import { persistState, defaultOrchestrationConfig, type OrchestrationState } from "../orchestration/state.ts";
import type { AdapterContext } from "./types.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
  return configPath;
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-manual-adapter-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});

function harness(): string {
  return join(TMP, "ludics-state", "harness");
}

function makeCtx(slot: number): AdapterContext {
  return {
    slot,
    mode: "manual",
    session: "",
    path: "/tmp",
    taskId: "",
    adapterArgs: "",
    process: "",
    harnessDir: harness(),
    stateRepoDir: TMP,
  };
}

describe("manual readState — paused orchestration fallback", () => {
  test("returns paused orchestration info when orch state exists but no manual status", () => {
    const ctx = makeCtx(1);
    const h = harness();
    mkdirSync(join(h, "orchestration"), { recursive: true });

    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-paused-1",
      mode: "pair",
      phase: "work",
      round: 2,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
      backend: "tmux",
    };
    persistState(orchState, h);

    const result = readState(ctx);
    expect(result).not.toBeNull();
    expect(result).toContain("paused orchestration");
    expect(result).toContain("task-paused-1");
    expect(result).toContain("paused");
    expect(result).toContain("tmux");
  });

  test("prefers real manual status file over paused orchestration", () => {
    const ctx = makeCtx(1);
    const h = harness();

    // Write orchestration state
    mkdirSync(join(h, "orchestration"), { recursive: true });
    const orchState: OrchestrationState = {
      slot: 1,
      taskId: "task-paused-2",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      config: defaultOrchestrationConfig(),
      phaseStartedAt: Math.floor(Date.now() / 1000),
      startedAt: new Date().toISOString(),
      projectDir: "/tmp/project",
      rootWorktree: "/tmp/root",
      peerSyncDir: "/tmp/peersync",
      threadIds: {},
      backend: "t3code",
    };
    persistState(orchState, h);

    // Write real manual status file
    const manualDir = join(h, "manual");
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, "slot-1.status"), "status: active\nstarted: 2026-04-03T20:00Z\ntask: real-task\n");

    const result = readState(ctx);
    expect(result).not.toBeNull();
    expect(result).toContain("manual (human work)");
    expect(result).not.toContain("paused orchestration");
  });

  test("returns null when neither manual status nor orch state exists", () => {
    const ctx = makeCtx(1);
    const result = readState(ctx);
    expect(result).toBeNull();
  });
});

describe("manual adapter: ctx.harnessDir is authoritative over env", () => {
  test("start/stop/readState write under ctx.harnessDir when LUDICS_HARNESS_DIR points elsewhere", () => {
    // Point the env var at a decoy that must remain untouched.
    const decoy = mkdtempSync(join(tmpdir(), "ludics-manual-decoy-"));
    process.env.LUDICS_HARNESS_DIR = decoy;

    // ctx.harnessDir points at the test's real harness — this must win.
    const ctx = makeCtx(7);
    const realHarness = harness();
    expect(ctx.harnessDir).toBe(realHarness);
    expect(decoy).not.toBe(realHarness);

    try {
      start(ctx);
      const status = readState(ctx);
      expect(status).not.toBeNull();
      expect(status).toContain("manual (human work)");

      // Files land under ctx.harnessDir, not under the decoy.
      const manualDirReal = join(realHarness, "manual");
      const manualDirDecoy = join(decoy, "manual");
      expect(existsSync(join(manualDirReal, "slot-7.status"))).toBe(true);
      expect(existsSync(join(manualDirReal, "slot-7.md"))).toBe(true);
      expect(existsSync(manualDirDecoy)).toBe(false);

      // stop also uses ctx.harnessDir — archive goes under real harness, decoy stays clean.
      stop(ctx);
      expect(existsSync(join(manualDirReal, "archive"))).toBe(true);
      expect(existsSync(manualDirDecoy)).toBe(false);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test("readState resolves status file from ctx.harnessDir even when env points elsewhere", () => {
    const decoy = mkdtempSync(join(tmpdir(), "ludics-manual-decoy-r-"));
    // Seed the decoy with a conflicting status file so a bypass would pick it up.
    const decoyManual = join(decoy, "manual");
    mkdirSync(decoyManual, { recursive: true });
    writeFileSync(
      join(decoyManual, "slot-3.status"),
      "status=active\nstarted=2026-01-01T00:00:00Z\ntask=DECOY\n",
    );
    writeFileSync(join(decoyManual, "slot-3.md"), "# DECOY NOTES\n");
    process.env.LUDICS_HARNESS_DIR = decoy;

    // Real ctx harness has no status file; must return null (not decoy content).
    const ctx = makeCtx(3);

    try {
      const result = readState(ctx);
      expect(result).toBeNull();
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test("start writes notes content readable through ctx.harnessDir (round trip)", () => {
    const decoy = mkdtempSync(join(tmpdir(), "ludics-manual-decoy-w-"));
    process.env.LUDICS_HARNESS_DIR = decoy;

    const ctx = makeCtx(5);
    try {
      start(ctx);
      const notesPath = join(harness(), "manual", "slot-5.md");
      expect(existsSync(notesPath)).toBe(true);
      const body = readFileSync(notesPath, "utf-8");
      expect(body).toContain("Manual Work Notes - Slot 5");
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});
