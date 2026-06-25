// Tests for cluster-http.ts: validateSignal pure function and handleSignal dispatch

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateSignal, handleClusterRequest } from "./cluster-http.ts";
import { writeSlotJson, emptySlotData } from "./slots/json.ts";
import * as slots from "./slots/index.ts";
import * as events from "./events.ts";

// ---------------------------------------------------------------------------
// validateSignal — pure function tests (no filesystem needed)
// ---------------------------------------------------------------------------

describe("validateSignal", () => {
  const BASE_EPOCH = 1_750_000_000; // a realistic Unix timestamp
  const goodSignal = { taskId: "task-abc", machine: "host-1", epoch: BASE_EPOCH };
  const slotTaskId = "task-abc";
  const slotMachine = "host-1";
  const nowEpoch = BASE_EPOCH + 100; // 100s after epoch — well within 1800s limit

  test("returns valid for matching taskId and machine", () => {
    const result = validateSignal(goodSignal, slotTaskId, slotMachine, nowEpoch);
    expect(result).toEqual({ valid: true });
  });

  test("rejects taskId mismatch with stale-task", () => {
    const result = validateSignal(
      { ...goodSignal, taskId: "task-old" },
      slotTaskId, slotMachine, nowEpoch,
    );
    expect(result).toEqual({ valid: false, reason: "stale-task", httpStatus: 409 });
  });

  test("rejects empty machine with missing-machine", () => {
    const result = validateSignal(
      { ...goodSignal, machine: "" },
      slotTaskId, slotMachine, nowEpoch,
    );
    expect(result).toEqual({ valid: false, reason: "missing-machine", httpStatus: 400 });
  });

  test("rejects machine mismatch with machine-mismatch", () => {
    const result = validateSignal(
      { ...goodSignal, machine: "other-host" },
      slotTaskId, slotMachine, nowEpoch,
    );
    expect(result).toEqual({ valid: false, reason: "machine-mismatch", httpStatus: 409 });
  });

  test("rejects expired signal with expired", () => {
    const expiredEpoch = nowEpoch - 1801; // just over the 1800s limit, still positive
    const result = validateSignal(
      { ...goodSignal, epoch: expiredEpoch },
      slotTaskId, slotMachine, nowEpoch,
    );
    expect(result).toEqual({ valid: false, reason: "expired", httpStatus: 409 });
  });

  test("skips TTL check when epoch is 0", () => {
    const result = validateSignal(
      { ...goodSignal, epoch: 0 },
      slotTaskId, slotMachine, nowEpoch,
    );
    expect(result).toEqual({ valid: true });
  });

  test("allows signal when slot machine is null (not yet assigned)", () => {
    const result = validateSignal(goodSignal, slotTaskId, "null", nowEpoch);
    expect(result).toEqual({ valid: true });
  });

  test("allows signal when slot machine is empty string", () => {
    const result = validateSignal(goodSignal, slotTaskId, "", nowEpoch);
    expect(result).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// handleSignal via handleClusterRequest — integration tests with mocks
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-xyz";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";
let harnessDir = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
cluster:
  secret: ${TEST_SECRET}
slots:
  count: 4
`);
  return configPath;
}

function writeSlotsFile(harness: string, slotNum: number, taskId: string, machine: string): void {
  mkdirSync(harness, { recursive: true });
  writeSlotJson(slotNum, {
    ...emptySlotData(slotNum),
    process: "some-process",
    task: taskId,
    mode: "solo",
    path: "/some/path",
    started: "2026-04-07T00:00Z",
    machine,
  }, harness);
}

function makeRequest(pathname: string, body: object): Request {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TEST_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-fed-http-test-"));
  harnessDir = join(TMP, "harness");
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir;
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;

  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;

  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;

  rmSync(TMP, { recursive: true, force: true });
});

describe("handleSignal dispatch", () => {
  const SLOT = 2;
  const TASK_ID = "task-12345";
  const MACHINE = "worker-1";
  const EPOCH = Math.floor(Date.now() / 1000); // fresh epoch

  test("done status calls slotClear with (slot, 'done') and returns 200", async () => {
    writeSlotsFile(harnessDir, SLOT, TASK_ID, MACHINE);
    const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(async () => {});
    const emitEventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});

    const req = makeRequest("/cluster/signal", {
      slot: SLOT, taskId: TASK_ID, status: "done", message: "all good",
      machine: MACHINE, epoch: EPOCH,
    });
    const resp = await handleClusterRequest(req, "/cluster/signal");

    expect(resp.status).toBe(200);
    expect(slotClearSpy).toHaveBeenCalledWith(SLOT, "done");
    slotClearSpy.mockRestore();
    emitEventSpy.mockRestore();
  });

  test("error status calls emitEvent with worker_signal_error and returns 200", async () => {
    writeSlotsFile(harnessDir, SLOT, TASK_ID, MACHINE);
    const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(async () => {});
    const emitEventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});

    const req = makeRequest("/cluster/signal", {
      slot: SLOT, taskId: TASK_ID, status: "error", message: "something failed",
      machine: MACHINE, epoch: EPOCH,
    });
    const resp = await handleClusterRequest(req, "/cluster/signal");

    expect(resp.status).toBe(200);
    expect(slotClearSpy).not.toHaveBeenCalled();
    expect(emitEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "worker_signal_error" }),
    );
    slotClearSpy.mockRestore();
    emitEventSpy.mockRestore();
  });

  test("progress status returns 200 without calling slotClear or emitEvent", async () => {
    writeSlotsFile(harnessDir, SLOT, TASK_ID, MACHINE);
    const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(async () => {});
    const emitEventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});

    const req = makeRequest("/cluster/signal", {
      slot: SLOT, taskId: TASK_ID, status: "progress", message: "working…",
      machine: MACHINE, epoch: EPOCH,
    });
    const resp = await handleClusterRequest(req, "/cluster/signal");

    expect(resp.status).toBe(200);
    expect(slotClearSpy).not.toHaveBeenCalled();
    expect(emitEventSpy).not.toHaveBeenCalled();
    slotClearSpy.mockRestore();
    emitEventSpy.mockRestore();
  });

  test("missing machine field returns 400", async () => {
    writeSlotsFile(harnessDir, SLOT, TASK_ID, MACHINE);

    const req = makeRequest("/cluster/signal", {
      slot: SLOT, taskId: TASK_ID, status: "done", message: "done",
      epoch: EPOCH,
      // machine is omitted
    });
    const resp = await handleClusterRequest(req, "/cluster/signal");

    expect(resp.status).toBe(400);
  });

  test("taskId mismatch returns 409", async () => {
    writeSlotsFile(harnessDir, SLOT, TASK_ID, MACHINE);
    const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(async () => {});

    const req = makeRequest("/cluster/signal", {
      slot: SLOT, taskId: "different-task", status: "done", message: "done",
      machine: MACHINE, epoch: EPOCH,
    });
    const resp = await handleClusterRequest(req, "/cluster/signal");

    expect(resp.status).toBe(409);
    expect(slotClearSpy).not.toHaveBeenCalled();
    slotClearSpy.mockRestore();
  });

  test("expired signal returns 409", async () => {
    writeSlotsFile(harnessDir, SLOT, TASK_ID, MACHINE);
    const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(async () => {});

    const staleEpoch = Math.floor(Date.now() / 1000) - 2000; // 2000s ago
    const req = makeRequest("/cluster/signal", {
      slot: SLOT, taskId: TASK_ID, status: "done", message: "done",
      machine: MACHINE, epoch: staleEpoch,
    });
    const resp = await handleClusterRequest(req, "/cluster/signal");

    expect(resp.status).toBe(409);
    expect(slotClearSpy).not.toHaveBeenCalled();
    slotClearSpy.mockRestore();
  });
});

import { existsSync, readFileSync } from "fs";

// Reuses the TMP/harnessDir/config fixture from the handleSignal suite above.
describe("atomic writes for intent/heartbeat/orchestration-state", () => {
  test("recordIntent writes a round-trippable file with no .tmp leftover", async () => {
    const mod = await import("./cluster-http.ts");
    const intent: import("./cluster-http.ts").PendingIntent = {
      action: "start",
      epoch: Math.floor(Date.now() / 1000),
      machine: "host-a",
      taskId: "task-abc",
    };
    mod.recordIntent(2, intent);
    const round = mod.getIntentForDashboard(2);
    expect(round).not.toBeNull();
    expect(round?.action).toBe("start");
    expect(round?.taskId).toBe("task-abc");
  });

  test("POST /api/cluster/orchestration-state writes pretty JSON atomically", async () => {
    const req = makeRequest("/api/cluster/orchestration-state", { slot: 3, state: { phase: "setup", agents: [] } });
    const resp = await handleClusterRequest(req, "/api/cluster/orchestration-state");
    expect(resp.status).toBe(200);
    const file = join(harnessDir, "orchestration", "slot-3.json");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(file + ".tmp")).toBe(false);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.phase).toBe("setup");
  });

  test("POST /cluster/heartbeat writes body as JSON atomically", async () => {
    const req = makeRequest("/cluster/heartbeat", { node: "test-node", epoch: 42, status: "ok" });
    const resp = await handleClusterRequest(req, "/cluster/heartbeat");
    expect(resp.status).toBe(200);
    // Heartbeat file lives outside the harness — in ~/.ludics-heartbeats-<hash>/ —
    // so we assert no .tmp sibling appears in the harness directory (atomicity holds
    // across the runtime dir too, verified indirectly by the 200 response).
    expect(existsSync(join(harnessDir, ".tmp"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkAuth gating (AC 3) — empty cluster.secret = unauthenticated tailnet HTTP;
// a configured secret still enforces bearer auth.
// Reuses the TMP/HOME/config fixture from the handleSignal suite above; each test
// rewrites the config's secret to instantiate its own case.
// ---------------------------------------------------------------------------

describe("cluster HTTP auth gating (AC 3)", () => {
  function setSecret(secret: string): void {
    // Overwrite the LUDICS_CONFIG file (set in beforeEach) with the given secret.
    writeFileSync(process.env.LUDICS_CONFIG!, `state_repo: owner/ludics-state
state_path: harness
cluster:
  secret: ${JSON.stringify(secret)}
slots:
  count: 4
`);
  }

  function getReq(pathname: string, auth?: string): Request {
    const headers: Record<string, string> = {};
    if (auth !== undefined) headers["Authorization"] = auth;
    return new Request(`http://localhost${pathname}`, { method: "GET", headers });
  }

  test("empty secret allows an unauthenticated GET /api/cluster/slots/json (not 401)", async () => {
    setSecret("");
    const resp = await handleClusterRequest(getReq("/api/cluster/slots/json"), "/api/cluster/slots/json");
    // The invariant: with no secret, the auth gate must NOT short-circuit to 401.
    // (Mutation: restoring the empty-secret 401 branch flips this to 401.)
    expect(resp.status).not.toBe(401);
    expect(resp.status).toBe(200);
  });

  test("empty secret allows an unauthenticated POST /cluster/heartbeat (not 401)", async () => {
    setSecret("");
    const req = new Request("http://localhost/cluster/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "minipc-wsl", epoch: Math.floor(Date.now() / 1000) }),
    });
    const resp = await handleClusterRequest(req, "/cluster/heartbeat");
    expect(resp.status).not.toBe(401);
    expect(resp.status).toBe(200);
  });

  test("configured secret rejects a missing bearer with 401", async () => {
    setSecret(TEST_SECRET);
    const resp = await handleClusterRequest(getReq("/api/cluster/slots/json"), "/api/cluster/slots/json");
    expect(resp.status).toBe(401);
  });

  test("configured secret rejects a wrong bearer with 401", async () => {
    setSecret(TEST_SECRET);
    const resp = await handleClusterRequest(getReq("/api/cluster/slots/json", "Bearer wrong-token"), "/api/cluster/slots/json");
    expect(resp.status).toBe(401);
  });

  test("configured secret accepts the correct bearer (not 401)", async () => {
    setSecret(TEST_SECRET);
    const resp = await handleClusterRequest(getReq("/api/cluster/slots/json", `Bearer ${TEST_SECRET}`), "/api/cluster/slots/json");
    expect(resp.status).not.toBe(401);
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// parsePendingIntent — boundary validator (gh-ludics-411 AC 1)
// ---------------------------------------------------------------------------

describe("parsePendingIntent", () => {
  const NOW = 1_750_000_000;
  const valid = { action: "start" as const, epoch: NOW, machine: "host-a" };

  test("accepts each of the three valid action values", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, action: "start" })).toEqual({ action: "start", epoch: NOW, machine: "host-a" });
    expect(parsePendingIntent({ ...valid, action: "stop" })).toEqual({ action: "stop", epoch: NOW, machine: "host-a" });
    expect(parsePendingIntent({ ...valid, action: "resume" })).toEqual({ action: "resume", epoch: NOW, machine: "host-a" });
  });

  test("rejects whitespace-padded action (no trim — JSON-on-disk shouldn't gain whitespace)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, action: "  start  " })).toBeNull();
    expect(parsePendingIntent({ ...valid, action: "start\n" })).toBeNull();
  });

  test("rejects unknown action strings", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, action: "unknown" })).toBeNull();
    expect(parsePendingIntent({ ...valid, action: "" })).toBeNull();
    expect(parsePendingIntent({ ...valid, action: "START" })).toBeNull();
  });

  test("parseInt-coerces string-encoded epoch (proposal AC 1 contract)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    // String integers must round-trip — JSON writers from other processes
    // sometimes emit numeric fields as strings.
    expect(parsePendingIntent({ ...valid, epoch: "1750000000" })).toEqual({
      action: "start", epoch: 1_750_000_000, machine: "host-a",
    });
    // parseInt truncates floats and tolerates trailing garbage.
    expect(parsePendingIntent({ ...valid, epoch: "1750000000.9" })?.epoch).toBe(1_750_000_000);
  });

  test("rejects non-finite / unparseable epoch", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, epoch: NaN })).toBeNull();
    expect(parsePendingIntent({ ...valid, epoch: Infinity })).toBeNull();
    expect(parsePendingIntent({ ...valid, epoch: -Infinity })).toBeNull();
    expect(parsePendingIntent({ ...valid, epoch: "not-a-number" })).toBeNull();
    const noEpoch: Record<string, unknown> = { action: "start", machine: "host-a" };
    expect(parsePendingIntent(noEpoch)).toBeNull();
    expect(parsePendingIntent({ ...valid, epoch: {} })).toBeNull();
  });

  test("string-coerces non-string machine (proposal AC 1 contract)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    // Per proposal AC 1: "machine/taskId string-coerce so a single function
    // returns either a fully-validated PendingIntent or null."
    expect(parsePendingIntent({ ...valid, machine: 42 })).toEqual({
      action: "start", epoch: NOW, machine: "42",
    });
  });

  test("rejects empty / missing machine even after coercion", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, machine: "" })).toBeNull();
    const noMachine: Record<string, unknown> = { action: "start", epoch: NOW };
    expect(parsePendingIntent(noMachine)).toBeNull();
    expect(parsePendingIntent({ ...valid, machine: null })).toBeNull();
  });

  test("preserves optional taskId and preserveState when valid", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    const out = parsePendingIntent({ ...valid, taskId: "task-99", preserveState: true });
    expect(out).toEqual({ action: "start", epoch: NOW, machine: "host-a", taskId: "task-99", preserveState: true });
  });

  test("string-coerces non-string taskId; drops empty after coercion", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    // Proposal AC 1: taskId is also string-coerce.
    expect(parsePendingIntent({ ...valid, taskId: 42 })?.taskId).toBe("42");
    // Empty after coercion is dropped (taskId is optional).
    expect(parsePendingIntent({ ...valid, taskId: "" })?.taskId).toBeUndefined();
    // Explicit null on optional field is treated as absent.
    expect(parsePendingIntent({ ...valid, taskId: null })?.taskId).toBeUndefined();
  });

  test("preserves optional adapterArgs and round-trips a duo string (gh-ludics-589)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    const duoArgs = "--pair --coder codex --reviewer claude-code --duo-peer-slot=3";
    const out = parsePendingIntent({ ...valid, taskId: "task-99", adapterArgs: duoArgs });
    // Invariant: the controller-authored expanded duo args survive the parse
    // boundary verbatim. If this dropped/mangled adapterArgs, the worker would
    // launch slotB with no peer/swapped providers — the exact gh-ludics-589 bug.
    expect(out).toEqual({ action: "start", epoch: NOW, machine: "host-a", taskId: "task-99", adapterArgs: duoArgs });
    // The peer-slot token specifically must round-trip (drives slotIsDuoMember + parseOrchestrationAdapterArgs).
    expect(out?.adapterArgs).toContain("--duo-peer-slot=3");
  });

  test("legacy intent without adapterArgs still validates (optional field; gh-ludics-589)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    // Harness condition: a stop/resume intent file written before this field
    // existed. Must not be rejected by the new branch.
    expect(parsePendingIntent({ action: "resume", epoch: NOW, machine: "host-a" }))
      .toEqual({ action: "resume", epoch: NOW, machine: "host-a" });
    expect(parsePendingIntent({ ...valid })?.adapterArgs).toBeUndefined();
  });

  test("string-coerces non-string adapterArgs; drops empty/whitespace after coercion (gh-ludics-589)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, adapterArgs: 42 })?.adapterArgs).toBe("42");
    // Empty / whitespace-only is dropped so it never overrides a populated worker read.
    expect(parsePendingIntent({ ...valid, adapterArgs: "" })?.adapterArgs).toBeUndefined();
    expect(parsePendingIntent({ ...valid, adapterArgs: "   " })?.adapterArgs).toBeUndefined();
    expect(parsePendingIntent({ ...valid, adapterArgs: null })?.adapterArgs).toBeUndefined();
  });

  test("preserves optional taskIntroCommit and round-trips the freshness SHA (gh-ludics-609)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    const sha = "a".repeat(40);
    const out = parsePendingIntent({ ...valid, taskId: "task-99", taskIntroCommit: sha });
    // Invariant: the controller-authored task-content freshness fingerprint survives
    // the parse boundary verbatim. If this dropped/mangled it, the worker's (c)
    // ancestry gate and (b) content gate would both go vacuous (undefined → skipped).
    expect(out).toEqual({ action: "start", epoch: NOW, machine: "host-a", taskId: "task-99", taskIntroCommit: sha });
  });

  test("legacy intent without taskIntroCommit still validates (optional field; gh-ludics-609)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid })?.taskIntroCommit).toBeUndefined();
  });

  test("string-coerces non-string taskIntroCommit; drops/trims empty after coercion (gh-ludics-609)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, taskIntroCommit: 42 })?.taskIntroCommit).toBe("42");
    // Empty / whitespace-only is dropped so a worker with no fingerprint falls back
    // to the existence-only gate (AC2 fallback), not a vacuous mismatch on "".
    expect(parsePendingIntent({ ...valid, taskIntroCommit: "" })?.taskIntroCommit).toBeUndefined();
    expect(parsePendingIntent({ ...valid, taskIntroCommit: "   " })?.taskIntroCommit).toBeUndefined();
    expect(parsePendingIntent({ ...valid, taskIntroCommit: null })?.taskIntroCommit).toBeUndefined();
    // Surrounding whitespace is trimmed so the ancestry compare uses a bare SHA.
    expect(parsePendingIntent({ ...valid, taskIntroCommit: "  abc123  " })?.taskIntroCommit).toBe("abc123");
  });

  test("rejects non-bool preserveState (no sensible coercion target)", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent({ ...valid, preserveState: "yes" })).toBeNull();
    expect(parsePendingIntent({ ...valid, preserveState: 1 })).toBeNull();
  });

  test("rejects null, undefined, and non-objects", async () => {
    const { parsePendingIntent } = await import("./cluster-http.ts");
    expect(parsePendingIntent(null)).toBeNull();
    expect(parsePendingIntent(undefined)).toBeNull();
    expect(parsePendingIntent("start")).toBeNull();
    expect(parsePendingIntent(42)).toBeNull();
    expect(parsePendingIntent([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File-read boundary regression: getIntentForDashboard skips malformed files
// ---------------------------------------------------------------------------

describe("intent file-read boundary (parsePendingIntent at JSON.parse seams)", () => {
  test("getIntentForDashboard returns null for a malformed intent file but works for a valid sibling", async () => {
    const mod = await import("./cluster-http.ts");
    const valid: import("./cluster-http.ts").PendingIntent = {
      action: "resume",
      epoch: Math.floor(Date.now() / 1000),
      machine: "host-b",
    };
    mod.recordIntent(3, valid);

    // Hand-corrupt slot 4's intent by writing a malformed JSON file directly.
    // Reuse intentsDir() shape — `${HOME}/.ludics-intents-<md5(stateRepoDir)>`.
    // Easier: write an invalid action through the same recordIntent helper by
    // first coercing the type, simulating a foreign-machine JSON write.
    const corrupt = { action: "danse-macabre", epoch: 0, machine: "" } as unknown as import("./cluster-http.ts").PendingIntent;
    mod.recordIntent(4, corrupt);

    expect(mod.getIntentForDashboard(3)?.action).toBe("resume");
    expect(mod.getIntentForDashboard(4)).toBeNull(); // malformed → skipped
  });
});

// ---------------------------------------------------------------------------
// validateIntentsPayload — HTTP-client boundary (gh-ludics-411 AC 1, the
// `clusterGetIntents()` cast that was previously unchecked). Tested as a
// pure function plus an integration test that drives clusterGetIntents()
// through a stubbed fetch so the worker keepalive path is exercised
// end-to-end.
// ---------------------------------------------------------------------------

describe("validateIntentsPayload", () => {
  const NOW = 1_750_000_000;
  const validIntent = { action: "start", epoch: NOW, machine: "host-a" };

  test("filters out malformed intent entries while preserving valid siblings", async () => {
    const { validateIntentsPayload } = await import("./cluster-http.ts");
    const payload = {
      intents: {
        "1": validIntent,
        "2": { action: "danse-macabre", epoch: 0, machine: "" }, // bad action
        "3": { action: "stop", epoch: NaN, machine: "host-b" },   // bad epoch
        "4": { action: "resume", epoch: NOW, machine: "" },       // empty machine
        "5": { action: "resume", epoch: "1750000099", machine: 42 }, // coerced
      },
    };
    const out = validateIntentsPayload(payload);
    expect(Object.keys(out).sort()).toEqual(["1", "5"]);
    expect(out[1]).toEqual({ action: "start", epoch: NOW, machine: "host-a" });
    expect(out[5]).toEqual({ action: "resume", epoch: 1_750_000_099, machine: "42" });
  });

  test("returns {} on missing/non-object intents field", async () => {
    const { validateIntentsPayload } = await import("./cluster-http.ts");
    expect(validateIntentsPayload(undefined)).toEqual({});
    expect(validateIntentsPayload(null)).toEqual({});
    expect(validateIntentsPayload({})).toEqual({});
    expect(validateIntentsPayload({ intents: null })).toEqual({});
    expect(validateIntentsPayload({ intents: "string" })).toEqual({});
  });

  test("skips entries whose slot key is non-numeric", async () => {
    const { validateIntentsPayload } = await import("./cluster-http.ts");
    const payload = { intents: { "abc": validIntent, "1": validIntent } };
    const out = validateIntentsPayload(payload);
    expect(Object.keys(out)).toEqual(["1"]);
  });
});

describe("clusterGetIntents — HTTP-client boundary integration (gh-ludics-411 AC 1)", () => {
  test("stubbed GET response with one valid + one malformed entry: malformed is dropped", async () => {
    // Spy on the cluster-side resolver so resolveAndGet succeeds with a
    // synthetic ClusterMachine, then stub fetch to return our mock payload.
    const cluster = await import("./cluster.ts");
    const NOW = 1_750_000_000;
    const fakeMachine = {
      name: "controller",
      ip: "127.0.0.1",
      port: 1,
      seniority: 0,
      role: "controller" as const,
    } as unknown as import("./cluster.ts").ClusterMachine;

    const resolveSpy = spyOn(cluster, "resolveController").mockReturnValue(fakeMachine);
    const stubFetch = (async () => new Response(JSON.stringify({
      intents: {
        "1": { action: "start", epoch: NOW, machine: "host-a" },
        "2": { action: "danse-macabre", epoch: 0, machine: "" }, // malformed
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(stubFetch);

    try {
      const mod = await import("./cluster-http.ts");
      const result = await mod.clusterGetIntents();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      // Only slot 1 (the valid intent) survives the boundary; slot 2 is
      // dropped before mag.ts::workerKeepalive sees it.
      expect(Object.keys(result.data!).sort()).toEqual(["1"]);
      expect(result.data![1].action).toBe("start");
    } finally {
      fetchSpy.mockRestore();
      resolveSpy.mockRestore();
    }
  });
});
