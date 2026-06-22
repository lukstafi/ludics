import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { maybeFillEmptySlots, launchSessionFromNotification } from "./mag.ts";
import { heartbeatsDir } from "./cluster.ts";

// gh-ludics-579: the controller must resolve a slot's project path FOR the
// destination machine at dispatch (maybeFillEmptySlots) — shipping a
// ~/-relative (or map-selected) path the worker expands against its own $HOME,
// never the controller's locally-expanded absolute path. A map-miss throws and
// assigns no slot rather than dispatching an empty/wrong path.

let TMP = "";
const ORIGINAL = {
  HOME: process.env.HOME,
  CONFIG: process.env.LUDICS_CONFIG,
  HARNESS: process.env.LUDICS_HARNESS_DIR,
  MACHINE: process.env.LUDICS_CLUSTER_MACHINE_NAME,
};

/** Write config.yaml: tmux orchestration (codex coder/reviewer → no model_classes
 *  needed), autonomy auto, a 2-machine cluster (mac-studio/macos leader [us],
 *  minipc-wsl/linux worker with nvidia gpu), and a cudajit project whose `path`
 *  is the given value, requiring an nvidia gpu (routes to minipc-wsl). */
function writeConfig(cudajitPath: string | Record<string, string>): void {
  const pathBlock = typeof cudajitPath === "string"
    ? `    path: ${cudajitPath}\n`
    : `    path:\n${Object.entries(cudajitPath).map(([k, v]) => `      ${k}: ${v}`).join("\n")}\n`;
  const configPath = join(TMP, "config.yaml");
  writeFileSync(configPath, `state_repo: test/state
state_path: harness
adapter: tmux
slots:
  count: 2
projects:
  - name: cudajit
    repo: lukstafi/ocaml-cudajit
${pathBlock}    requirements:
      gpu: nvidia
mag:
  autonomy_level:
    start_sessions: auto
  orchestration:
    default_coder: codex
    default_reviewer: codex
cluster:
  transport: http
  domain: test.local
  machines:
    - name: mac-studio
      host: mac-studio.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: minipc-wsl
      host: minipc-wsl.test.local
      os: linux
      role: worker
      always_on: false
      gpu: nvidia
`);
  process.env.LUDICS_CONFIG = configPath;
}

/** Publish a fresh heartbeat for `node` so selectMachineForSlot treats it as
 *  online (required for requirement-routed assignment). */
function writeFreshHeartbeat(node: string): void {
  const dir = heartbeatsDir();
  mkdirSync(dir, { recursive: true });
  const epoch = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, `${node}.json`), JSON.stringify({ node, role: "worker", epoch, mag_running: true }));
}

function writeReadyTask(): void {
  const tasksDir = join(TMP, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, "task-cudajit-remote.md"),
    `---\nid: task-cudajit-remote\ntitle: CUDA remote\nproject: cudajit\n`
      + `status: ready\npriority: B\neffort: medium\nelaborated: 2026-05-01\n`
      + `proposal: docs/proposals/x.md\ndependencies:\n  blocks: []\n  blocked_by: []\n`
      + `  relates_to: []\n  subtask_of: null\ncontext: cudajit\nuses_browser: false\n`
      + `created: 2026-05-01\nsource: manual\n---\n# task-cudajit-remote\n`,
  );
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-mag-remote-path-"));
  process.env.HOME = TMP;
  process.env.LUDICS_HARNESS_DIR = TMP;
  mkdirSync(join(TMP, "slots"), { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    const key = k === "HOME" ? "HOME" : k === "CONFIG" ? "LUDICS_CONFIG" : k === "HARNESS" ? "LUDICS_HARNESS_DIR" : "LUDICS_CLUSTER_MACHINE_NAME";
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("maybeFillEmptySlots — destination-aware path resolution (gh-ludics-579)", () => {
  // AC1: dispatching cudajit (controller mac-studio) to the nvidia worker
  // minipc-wsl stores the UNEXPANDED ~/ocaml-cudajit on the slot — not the
  // controller's /Users/... — so the worker expands it against /home. The
  // assertion `slot.path === "~/ocaml-cudajit"` would fail under the bug
  // (controller pre-expanding against its own $HOME) or if selectMachineForSlot
  // ran after resolveProjectPath (machine unknown at resolve time).
  test("remote assignment stores the ~/-relative path unexpanded (AC1)", async () => {
    writeConfig("~/ocaml-cudajit");
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    writeFreshHeartbeat("minipc-wsl");
    writeReadyTask();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await maybeFillEmptySlots();
    } finally {
      errSpy.mockRestore();
    }
    const slotFile = join(TMP, "slots", "slot-1.json");
    expect(existsSync(slotFile)).toBe(true);
    const slot = JSON.parse(readFileSync(slotFile, "utf-8")) as { path: string; machine: string; task: string };
    expect(slot.machine).toBe("minipc-wsl");
    expect(slot.task).toBe("task-cudajit-remote");
    // The crux: path shipped unexpanded for the worker to resolve locally.
    expect(slot.path).toBe("~/ocaml-cudajit");
    expect(slot.path.startsWith("/Users/")).toBe(false);
  });

  // Map-miss (rev 2): a path map missing the worker's machine/OS key throws
  // ProjectPathMapMissError at resolution; the dispatch catch logs and assigns
  // NO slot — rather than returning "" which would silently fall through to the
  // wrong root. Mutation: returning "" instead of throwing would write a slot
  // file (assertion `not exist` fails).
  test("path map missing the worker's machine/OS assigns no slot and logs the config error", async () => {
    writeConfig({ macos: "~/ocaml-cudajit" }); // no linux / minipc-wsl entry
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    writeFreshHeartbeat("minipc-wsl");
    writeReadyTask();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    let calls: string[] = [];
    try {
      await maybeFillEmptySlots();
      calls = errSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      errSpy.mockRestore();
    }
    // No slot assigned.
    expect(existsSync(join(TMP, "slots", "slot-1.json"))).toBe(false);
    expect(readdirSync(join(TMP, "slots"))).toEqual([]);
    // And the config error was surfaced (loud, retryable next tick).
    expect(calls.some((l) => l.includes("no entry for machine"))).toBe(true);
  });
});

// gh-ludics-579 (review round 3): the notification/dashboard launch path
// (launchSessionFromNotification) is a SECOND dispatch site with the same bug —
// it must resolve the project path FOR the destination machine, after machine
// selection, not via the controller-local resolveTaskProjectPath.
describe("launchSessionFromNotification — destination-aware path (gh-ludics-579)", () => {
  /** t3code-enabled config (launchSessionFromNotification hardcodes adapter t3code),
   *  controller mac-studio + nvidia worker minipc-wsl, cudajit requires nvidia gpu. */
  function writeLaunchConfig(): void {
    const configPath = join(TMP, "config.yaml");
    writeFileSync(configPath, `state_repo: test/state
state_path: harness
adapter: tmux
slots:
  count: 2
projects:
  - name: cudajit
    repo: lukstafi/ocaml-cudajit
    path: ~/ocaml-cudajit
    requirements:
      gpu: nvidia
mag:
  t3code_integration_enabled: true
cluster:
  transport: http
  domain: test.local
  machines:
    - name: mac-studio
      host: mac-studio.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: minipc-wsl
      host: minipc-wsl.test.local
      os: linux
      role: worker
      always_on: false
      gpu: nvidia
`);
    process.env.LUDICS_CONFIG = configPath;
  }

  // Invariant: the slot stamped for the remote worker carries the UNEXPANDED
  // ~/ocaml-cudajit, not the controller's /Users/.... slotStart short-circuits
  // to a recorded intent for a remote machine, so slotAssign's persisted path is
  // observable. Fails under the bug (path resolved via resolveTaskProjectPath
  // before machine selection → controller-local /Users/... or "").
  test("notification launch to a remote worker stores the ~/-relative path unexpanded", async () => {
    writeLaunchConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // controller
    writeFreshHeartbeat("minipc-wsl");
    writeReadyTask(); // task-cudajit-remote, project cudajit
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await launchSessionFromNotification("task-cudajit-remote");
    } finally {
      errSpy.mockRestore();
    }
    const slotFile = join(TMP, "slots", "slot-1.json");
    expect(existsSync(slotFile)).toBe(true);
    const slot = JSON.parse(readFileSync(slotFile, "utf-8")) as { path: string; machine: string };
    expect(slot.machine).toBe("minipc-wsl");
    expect(slot.path).toBe("~/ocaml-cudajit");
    expect(slot.path.startsWith("/Users/")).toBe(false);
  });
});
