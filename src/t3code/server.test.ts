import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandLineMatchesServerRecord, processAlive, readServerRecord, readSlotState, removeSlotState, writeSlotState } from "./server.ts";
import type { T3CodeServerRecord, T3CodeSlotState } from "./types.ts";

function makeRecord(overrides: Partial<T3CodeServerRecord> = {}): T3CodeServerRecord {
  return {
    pid: 1234,
    port: 3773,
    host: "127.0.0.1",
    webUrl: "http://127.0.0.1:3773",
    wsUrl: "ws://127.0.0.1:3773",
    stateDir: "/tmp/ludics/harness/t3code/state",
    startedAt: "2026-03-07T00:00:00Z",
    command: ["t3", "--home-dir", "/tmp/ludics/harness/t3code/state"],
    ...overrides,
  };
}

describe("commandLineMatchesServerRecord", () => {
  test("matches installed t3 command lines that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "t3 --mode desktop --port 3773 --home-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun source launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun --cwd /Users/lukstafi/t3code/apps/server src/index.ts --mode desktop --home-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun run --cwd launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun run --cwd /Users/lukstafi/t3code-ludics/apps/server start --mode desktop --home-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("matches bun --cwd (without run) launches that include the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "bun --cwd /Users/lukstafi/t3code-ludics/apps/server src/index.ts --home-dir /tmp/ludics/harness/t3code/state",
        record,
      ),
    ).toBe(true);
  });

  test("matches when host is a Tailscale hostname", () => {
    const record = makeRecord({
      host: "macbook.tail12345.ts.net",
      webUrl: "http://macbook.tail12345.ts.net:3773",
      wsUrl: "ws://macbook.tail12345.ts.net:3773",
    });
    expect(
      commandLineMatchesServerRecord(
        "bun run --cwd /Users/lukstafi/t3code-ludics/apps/server start --home-dir /tmp/ludics/harness/t3code/state --host macbook.tail12345.ts.net",
        record,
      ),
    ).toBe(true);
  });

  test("matches npm exec wrapper that includes the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "npm exec t3 -- --mode desktop --port 3773 --home-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("matches npm run wrapper that includes the recorded state dir", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "/usr/local/bin/npm run t3 -- --mode desktop --port 3773 --home-dir /tmp/ludics/harness/t3code/state --no-browser",
        record,
      ),
    ).toBe(true);
  });

  test("rejects unrelated processes even when the pid is alive", () => {
    const record = makeRecord();
    expect(
      commandLineMatchesServerRecord(
        "node /Users/lukstafi/project/server.js --home-dir /tmp/other-state",
        record,
      ),
    ).toBe(false);
    expect(commandLineMatchesServerRecord("python worker.py", record)).toBe(false);
  });
});

describe("readServerRecord", () => {
  test("returns null when server.json contains a non-object value", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ludics-t3code-test-"));
    const t3Dir = join(tmpDir, "t3code");
    mkdirSync(t3Dir, { recursive: true });

    // JSON string
    writeFileSync(join(t3Dir, "server.json"), '"hello"');
    expect(readServerRecord(tmpDir)).toBeNull();

    // JSON array
    writeFileSync(join(t3Dir, "server.json"), "[1,2,3]");
    expect(readServerRecord(tmpDir)).toBeNull();

    // JSON null
    writeFileSync(join(t3Dir, "server.json"), "null");
    expect(readServerRecord(tmpDir)).toBeNull();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("processAlive", () => {
  test("returns true for the current process", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  test("returns false for invalid pids without throwing", () => {
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
    expect(processAlive(1.5)).toBe(false);
    expect(processAlive(Number.NaN)).toBe(false);
  });

  test("returns false for a pid that cannot exist on any reasonable kernel", () => {
    // INT32_MAX is far above Linux's pid_max (~2^22) and macOS's kern.maxproc
    // (~10^5), so kill(2) returns ESRCH (or EINVAL on some kernels) and
    // processAlive catches it. Using a sentinel pid avoids the PID-reuse race
    // a freshly-exited spawnSync child would have on busy CI hosts.
    expect(processAlive(2147483647)).toBe(false);
  });
});

// gh-ludics-580 AC4 + AC9: per-slot t3code state must move to a non-harness
// worker cache on a federation worker, while controller/standalone keeps using
// the git-tracked harness tree.
describe("readSlotState/writeSlotState/removeSlotState — worker-cache migration", () => {
  let TMP: string;
  let harness: string;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;

  function writeClusterConfig(homeDir: string): string {
    const cfg = join(homeDir, "config.yaml");
    writeFileSync(cfg, `state_repo: owner/ludics-state
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
    return cfg;
  }

  function makeState(slot: number): T3CodeSlotState {
    return {
      slot,
      threads: [{
        threadId: `thr-${slot}`,
        projectId: "proj-1",
        worktreePath: `/tmp/wt-${slot}`,
        title: "t",
        model: "claude-opus-4-8",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-06-22T00:00:00Z",
        updatedAt: "2026-06-22T00:00:00Z",
      }],
    } as T3CodeSlotState;
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "t3code-worker-cache-"));
    process.env.HOME = TMP;
    harness = join(TMP, "harness");
    mkdirSync(harness, { recursive: true });
    process.env.LUDICS_CONFIG = writeClusterConfig(TMP);
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("worker: write/read round-trip via $HOME/.ludics-orch-cache/t3code, harness untouched", () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // → worker context
    const state = makeState(4);
    writeSlotState(state, harness);

    // Round-trip fidelity: every key field survives serialize→deserialize.
    const round = readSlotState(4, harness);
    expect(round).not.toBeNull();
    expect(round!.slot).toBe(4);
    expect(round!.threads.map((t) => t.threadId)).toEqual(["thr-4"]);

    // Bytes live in the non-harness cache…
    const cachePath = join(TMP, ".ludics-orch-cache", "t3code", "slot-4.json");
    expect(existsSync(cachePath)).toBe(true);
    // …and NOT in the git-tracked harness tree.
    expect(existsSync(join(harness, "t3code", "slot-4.json"))).toBe(false);

    removeSlotState(4, harness);
    expect(existsSync(cachePath)).toBe(false);
    expect(readSlotState(4, harness)).toBeNull();
  });

  test("worker upgrade bridge: reads fall back to a legacy harness file when the cache is empty (gh-ludics-580 P1)", () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // worker context
    // Simulate an in-flight slot started BEFORE the migration: state at the
    // legacy harness path, nothing in the cache.
    const harnessSlotPath = join(harness, "t3code", "slot-7.json");
    mkdirSync(join(harness, "t3code"), { recursive: true });
    const legacy = makeState(7);
    writeFileSync(harnessSlotPath, JSON.stringify(legacy));
    expect(existsSync(join(TMP, ".ludics-orch-cache", "t3code", "slot-7.json"))).toBe(false);

    // Invariant: the legacy file is read (resume must not treat the active slot
    // as having no persisted state). Without the `?? legacy` fallback this is null.
    const read = readSlotState(7, harness);
    expect(read).not.toBeNull();
    expect(read!.threads.map((t) => t.threadId)).toEqual(["thr-7"]);

    // After the next persist, state migrates forward to the cache, which then
    // shadows the (intentionally undeleted) legacy file.
    writeSlotState({ ...makeState(7), threads: [{ ...legacy.threads[0], threadId: "thr-7-migrated" }] }, harness);
    expect(existsSync(join(TMP, ".ludics-orch-cache", "t3code", "slot-7.json"))).toBe(true);
    expect(readSlotState(7, harness)!.threads.map((t) => t.threadId)).toEqual(["thr-7-migrated"]);
    // Worker did NOT mutate its git-tracked harness clone on write.
    expect(JSON.parse(readFileSync(harnessSlotPath, "utf-8")).threads[0].threadId).toBe("thr-7");
  });

  test("controller/standalone: write/read uses harness tree, cache untouched", () => {
    // No LUDICS_CLUSTER_MACHINE_NAME and host won't match a configured machine →
    // not a worker (isWorkerContext false). Use a self-leader to be explicit.
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "leader-box"; // role leader → controller
    const state = makeState(2);
    writeSlotState(state, harness);

    expect(existsSync(join(harness, "t3code", "slot-2.json"))).toBe(true);
    expect(existsSync(join(TMP, ".ludics-orch-cache", "t3code", "slot-2.json"))).toBe(false);
    expect(readSlotState(2, harness)?.threads.map((t) => t.threadId)).toEqual(["thr-2"]);

    removeSlotState(2, harness);
    expect(existsSync(join(harness, "t3code", "slot-2.json"))).toBe(false);
  });
});
