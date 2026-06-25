import { describe, expect, test } from "bun:test";
import { buildProposalNotificationActions, chunkNotificationActions } from "./notify.ts";

describe("buildProposalNotificationActions", () => {
  test("includes approve, revise, and abandon buttons", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "project-x",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    expect(actions.map((action) => String(action.label))).toEqual([
      "approve",
      "revise",
      "abandon",
    ]);
    expect(String(actions[0]!.body)).toBe("Approve task task-042");
    expect(String(actions[1]!.body)).toBe("Revise proposal for task-042");
    expect(String(actions[2]!.body)).toBe("Abandon task task-042");
  });
});

describe("chunkNotificationActions", () => {
  test("proposal actions fit in one chunk", () => {
    const actions = buildProposalNotificationActions("task-042", "project-x", "incoming-topic", {});
    const chunks = chunkNotificationActions(actions, 3);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(3);
    expect(chunks.flat().map((action) => String(action.label))).toEqual(
      actions.map((action) => String(action.label)),
    );
  });
});

describe("buildProposalNotificationActions — t3code-only format", () => {
  test("action bodies contain no adapter or project references", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "some-project",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    for (const action of actions) {
      const body = String(action.body);
      // Must not contain adapter-specific launch patterns
      expect(body).not.toMatch(/Launch \w+ for/);
      // Must not contain "in project" suffix
      expect(body).not.toContain("in project");
    }

    // Verify exact modern format
    expect(String(actions[0]!.body)).toBe("Approve task task-042");
  });
});

import { afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("notify state-file atomic writes", () => {
  let tmpDir: string;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-notify-state-"));
    mkdirSync(join(tmpDir, "mag"), { recursive: true });
    process.env.LUDICS_HARNESS_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  });

  test("saveSessionConclusionState round-trips via loadSessionConclusionState, no .tmp leftover", async () => {
    const { saveSessionConclusionState, loadSessionConclusionState, sessionConclusionStateFile } = await import("./notify.ts");
    const state = { "task-a": "2026-04-24T00:00:00Z", "task-b": "2026-04-24T01:00:00Z" };
    saveSessionConclusionState(state);
    expect(loadSessionConclusionState()).toEqual(state);
    expect(existsSync(sessionConclusionStateFile() + ".tmp")).toBe(false);
  });

  test("saveSubscriberState round-trips via loadSubscriberState and preserves compact JSON shape", async () => {
    const { saveSubscriberState, loadSubscriberState, subscriberStateFile } = await import("./notify.ts");
    saveSubscriberState("msg-42");
    const state = loadSubscriberState();
    expect(state.last_id).toBe("msg-42");
    expect(typeof state.last_time).toBe("string");
    // Compact JSON — no pretty-print indentation
    const raw = readFileSync(subscriberStateFile(), "utf-8");
    expect(raw).not.toContain("\n  \"");
    expect(existsSync(subscriberStateFile() + ".tmp")).toBe(false);
  });

  test("setPendingFollowupRevise writes compact JSON payload with no .tmp leftover", async () => {
    const { setPendingFollowupRevise, pendingFollowupReviseFile } = await import("./notify.ts");
    setPendingFollowupRevise("task-xyz", "t3code");
    const file = pendingFollowupReviseFile("task-xyz", "t3code");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".tmp")).toBe(false);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.task).toBe("task-xyz");
    expect(parsed.adapter).toBe("t3code");
    expect(typeof parsed.created).toBe("number");
  });
});

import { spyOn } from "bun:test";
import * as spawnModule from "./spawn.ts";

describe("notify ntfy.sh suppression under bun test", () => {
  let tmpDir: string;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_BUN_TEST = process.env.BUN_TEST;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-notify-suppress-"));
    mkdirSync(join(tmpDir, "journal"), { recursive: true });
    process.env.LUDICS_HARNESS_DIR = tmpDir;
    // Isolate the config: without this, loadConfigSync resolves the developer's
    // real ~/config.yaml. On a federation controller that config self-matches
    // the local hostname, so notifyLog's isWorkerContext() guard spawns
    // safeSyncOutput (git/hostname) during cluster-identity resolution and
    // defeats the "0 safeSyncOutput" assertions below. A minimal config with no
    // cluster section makes clusterCurrentMachineName() return falsy, so
    // isWorkerContext() short-circuits without spawning — and no topics keeps
    // the notify* calls on the "topic not configured" path.
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, "state_repo: owner/ludics-state\nstate_path: harness\nslots:\n  count: 2\n");
    process.env.LUDICS_CONFIG = configPath;
    // Set BUN_TEST explicitly: bun-test does not always populate it. The
    // guard's primary signal is BUN_TEST; assert from the test that the
    // value the suppression check sees matches what the runner / wrapper
    // would set in production-test invocations.
    process.env.BUN_TEST = "1";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    if (ORIGINAL_BUN_TEST === undefined) delete process.env.BUN_TEST;
    else process.env.BUN_TEST = ORIGINAL_BUN_TEST;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  });

  test("notifyAgents writes to journal but does NOT invoke safeSyncOutput under BUN_TEST", async () => {
    expect(process.env.BUN_TEST).toBeTruthy();

    const spawnSpy = spyOn(spawnModule, "safeSyncOutput");
    const { notifyAgents } = await import("./notify.ts");
    let calls = 0;
    try {
      notifyAgents("suppression-probe-message", 1, "suppression-probe-title");
      calls = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }
    expect(calls).toBe(0);
    const log = readFileSync(join(tmpDir, "journal", "notifications.jsonl"), "utf-8");
    expect(log).toContain("suppression-probe-message");
  });

  test("shouldSuppressNtfy negative control: returns false when BUN_TEST and NODE_ENV are cleared", async () => {
    const { shouldSuppressNtfy } = await import("./notify.ts");
    const savedBunTest = process.env.BUN_TEST;
    const savedNodeEnv = process.env.NODE_ENV;
    let observed: boolean | null = null;
    try {
      delete process.env.BUN_TEST;
      delete process.env.NODE_ENV;
      observed = shouldSuppressNtfy();
    } finally {
      if (savedBunTest === undefined) delete process.env.BUN_TEST;
      else process.env.BUN_TEST = savedBunTest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
    expect(observed).toBe(false);
  });

  test("shouldSuppressNtfy returns true under BUN_TEST=1 and under NODE_ENV=test", async () => {
    const { shouldSuppressNtfy } = await import("./notify.ts");
    const savedBunTest = process.env.BUN_TEST;
    const savedNodeEnv = process.env.NODE_ENV;
    let withBunTest: boolean | null = null;
    let withNodeEnv: boolean | null = null;
    let withZero: boolean | null = null;
    try {
      delete process.env.NODE_ENV;
      process.env.BUN_TEST = "1";
      withBunTest = shouldSuppressNtfy();

      delete process.env.BUN_TEST;
      process.env.NODE_ENV = "test";
      withNodeEnv = shouldSuppressNtfy();

      delete process.env.NODE_ENV;
      process.env.BUN_TEST = "0";
      withZero = shouldSuppressNtfy();
    } finally {
      if (savedBunTest === undefined) delete process.env.BUN_TEST;
      else process.env.BUN_TEST = savedBunTest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
    expect(withBunTest).toBe(true);
    expect(withNodeEnv).toBe(true);
    expect(withZero).toBe(false);
  });

  test("notifyPublishMessage returns synthesised 200 without calling safeSyncOutput under BUN_TEST", async () => {
    expect(process.env.BUN_TEST).toBeTruthy();

    const spawnSpy = spyOn(spawnModule, "safeSyncOutput");
    const { notifyPublishMessage } = await import("./notify.ts");
    let result: { httpCode: string; stderr: string; body: string } | null = null;
    let calls = 0;
    try {
      result = notifyPublishMessage(
        "lukstafi-agents",
        "publish-probe-message",
        "real-bearer-token",
        "publish-probe-title",
        3,
        "memo,task-87d4b17e",
        [],
      );
      calls = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }
    expect(calls).toBe(0);
    expect(result).toEqual({ httpCode: "200", stderr: "", body: "" });
  });

  test("notifyPublishFile returns synthesised 200 without calling safeSyncOutput under BUN_TEST", async () => {
    expect(process.env.BUN_TEST).toBeTruthy();

    const spawnSpy = spyOn(spawnModule, "safeSyncOutput");
    const { notifyPublishFile } = await import("./notify.ts");
    let result: { httpCode: string; stderr: string; body: string } | null = null;
    let calls = 0;
    try {
      result = notifyPublishFile(
        "lukstafi-agents",
        "/dev/null",
        "probe.md",
        "real-bearer-token",
        "publish-file-probe-title",
        "publish-file-probe-message",
        3,
        "memo,task-87d4b17e",
        [],
      );
      calls = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }
    expect(calls).toBe(0);
    expect(result).toEqual({ httpCode: "200", stderr: "", body: "" });
  });
});

// gh-ludics-592 (defect 2): a federation worker must never write the tracked
// notifications log — a local write blocks `git pull --ff-only` and strands the
// worker on a stale harness clone. notifyLog no-ops in worker context.
describe("notify worker-context guard (gh-ludics-592)", () => {
  let tmpDir: string;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;

  function writeClusterConfig(homeDir: string): string {
    const configPath = join(homeDir, "config.yaml");
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
cluster:
  transport: http
  domain: test.local
  machines:
    - name: leader-box
      host: leader-box.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: minipc-wsl
      host: minipc-wsl.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);
    return configPath;
  }

  const logPath = (): string => join(tmpDir, "harness", "journal", "notifications.jsonl");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-notify-worker-"));
    process.env.HOME = tmpDir;
    process.env.LUDICS_HARNESS_DIR = join(tmpDir, "harness");
    process.env.LUDICS_CONFIG = writeClusterConfig(tmpDir);
    mkdirSync(join(tmpDir, "harness", "journal"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
  });

  test("worker context: notifyAgents does NOT create the tracked notifications log", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // worker (role: worker)
    const { notifyAgents } = await import("./notify.ts");

    notifyAgents("worker-guard-probe", 1, "worker-guard-title");

    // Invariant: a worker leaves journal/notifications.jsonl untouched, so the
    // tracked tree stays clean and `git pull --ff-only` is never blocked.
    // Harness condition: worker context (minipc-wsl has role: worker) — this is
    // what makes isWorkerContext() true. Mutation control: removing the
    // `if (isWorkerContext()) return;` guard makes this file appear → fails.
    expect(existsSync(logPath())).toBe(false);
  });

  test("controller context positive control: notifyAgents DOES write the notifications log", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "leader-box"; // controller (role: leader)
    const { notifyAgents } = await import("./notify.ts");

    notifyAgents("controller-guard-probe", 1, "controller-guard-title");

    // On the controller the guard is inert: the tracked log is still written.
    expect(existsSync(logPath())).toBe(true);
    expect(readFileSync(logPath(), "utf-8")).toContain("controller-guard-probe");
  });
});
