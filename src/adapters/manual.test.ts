import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readState } from "./manual.ts";
import { persistState, defaultOrchestrationConfig, type OrchestrationState } from "../orchestration/state.ts";
import type { AdapterContext } from "./types.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
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
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
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
