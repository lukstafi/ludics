import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { _remoteTestExec, _runAllTestHealthDispatch, checkProjectTestHealth, detectTestCommand, requirementsSatisfiedByCurrentHost, runAllTestHealth, shouldRunTestHealth, testHealthStatePath } from "./health.ts";
import type { RemoteRunResult } from "./remote.ts";
import { heartbeatsDir } from "./cluster.ts";
import { tmpdir } from "os";
import { _resetPostponedProjectsCache } from "./config.ts";
import { parseTaskFrontmatter, transitionStatus } from "./tasks/markdown.ts";
import { captureConsoleError, withSyntheticHarness } from "./test-utils.ts";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("detectTestCommand", () => {
  test("detects dune-project", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "dune-project"), "(lang dune 3.0)");
    expect(detectTestCommand(dir)).toBe("dune runtest");
    rmSync(dir, { recursive: true });
  });

  test("detects bun.lockb", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "bun.lockb"), "");
    expect(detectTestCommand(dir)).toBe("bun test");
    rmSync(dir, { recursive: true });
  });

  test("detects bun.lock", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "bun.lock"), "");
    expect(detectTestCommand(dir)).toBe("bun test");
    rmSync(dir, { recursive: true });
  });

  test("detects package.json with test script", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    expect(detectTestCommand(dir)).toBe("npm test");
    rmSync(dir, { recursive: true });
  });

  test("skips package.json without test script", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("handles malformed package.json gracefully", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), "not json{{{");
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("detects Makefile with test target", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "Makefile"), "build:\n\tgcc main.c\ntest:\n\t./run_tests\n");
    expect(detectTestCommand(dir)).toBe("make test");
    rmSync(dir, { recursive: true });
  });

  test("skips Makefile without test target", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "Makefile"), "build:\n\tgcc main.c\n");
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("dune-project takes priority over bun.lockb", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "dune-project"), "(lang dune 3.0)");
    writeFileSync(join(dir, "bun.lockb"), "");
    expect(detectTestCommand(dir)).toBe("dune runtest");
    rmSync(dir, { recursive: true });
  });

  test("bun.lockb takes priority over package.json with test script", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "bun.lockb"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    expect(detectTestCommand(dir)).toBe("bun test");
    rmSync(dir, { recursive: true });
  });

  test("returns null for empty directory", () => {
    const dir = makeTmpDir();
    expect(detectTestCommand(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });
});

describe("shouldRunTestHealth", () => {
  const emptyConfig = {};

  test("returns true when no prior state (stale)", () => {
    expect(shouldRunTestHealth("proj", {}, emptyConfig, new Date("2026-04-07T10:00:00"))).toBe(true);
  });

  test("returns false for recent run outside night window", () => {
    const now = new Date(2026, 3, 7, 10, 0, 0); // 10am local — outside [0,6)
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    expect(shouldRunTestHealth("proj", state, emptyConfig, now)).toBe(false);
  });

  test("returns true for recent run inside night window", () => {
    // Use explicit local-time constructor to avoid timezone ambiguity
    const now = new Date(2026, 3, 7, 3, 0, 0); // 3am local time
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    expect(now.getHours()).toBe(3); // sanity check
    expect(shouldRunTestHealth("proj", state, emptyConfig, now)).toBe(true);
  });

  test("returns true for stale run (24+ hours ago)", () => {
    const now = new Date(2026, 3, 7, 10, 0, 0); // 10am local
    const state = { proj: { lastRun: new Date(now.getTime() - 25 * 3600_000).toISOString(), passed: true } };
    expect(shouldRunTestHealth("proj", state, emptyConfig, now)).toBe(true);
  });

  test("uses configured night window with wrap-around", () => {
    const now = new Date(2026, 3, 7, 23, 0, 0); // 11pm local
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    const config = { mag: { test_health_night_hours: [22, 6] as [number, number] } };
    expect(now.getHours()).toBe(23);
    expect(shouldRunTestHealth("proj", state, config, now)).toBe(true);
  });

  test("wrap-around night window [22, 6] excludes midday", () => {
    const now = new Date(2026, 3, 7, 12, 0, 0); // noon local
    const state = { proj: { lastRun: new Date(now.getTime() - 3600_000).toISOString(), passed: true } };
    const config = { mag: { test_health_night_hours: [22, 6] as [number, number] } };
    expect(now.getHours()).toBe(12);
    expect(shouldRunTestHealth("proj", state, config, now)).toBe(false);
  });
});

describe("loadTestHealthState validation", () => {
  // Mirrors the validation logic in loadTestHealthState to ensure
  // non-record JSON values are treated as corruption and reset to {}.
  function parseTestHealthState(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  test("valid object is returned as-is", () => {
    const result = parseTestHealthState('{"proj":{"lastRun":"2026-04-07","passed":true}}');
    expect(result).toEqual({ proj: { lastRun: "2026-04-07", passed: true } });
  });

  test("string JSON resets to empty", () => {
    expect(parseTestHealthState('"hello"')).toEqual({});
  });

  test("array JSON resets to empty", () => {
    expect(parseTestHealthState('[1,2,3]')).toEqual({});
  });

  test("null JSON resets to empty", () => {
    expect(parseTestHealthState("null")).toEqual({});
  });

  test("number JSON resets to empty", () => {
    expect(parseTestHealthState("42")).toEqual({});
  });

  test("invalid JSON resets to empty", () => {
    expect(parseTestHealthState("not json{{{")).toEqual({});
  });
});

describe("saveTestHealthState atomic write", () => {
  test("round-trips via loadTestHealthState and leaves no .tmp sibling", async () => {
    const mod = await import("./health.ts");
    const dir = mkdtempSync(join(tmpdir(), "ludics-health-"));
    const ORIGINAL = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = dir;
    try {
      const state = {
        "ludics/ludics": {
          lastRun: "2026-04-24T00:00:00Z",
          passed: true,
        },
      };
      mod.saveTestHealthState(state);
      expect(mod.loadTestHealthState()).toEqual(state);
      const path = mod.testHealthStatePath();
      expect(existsSync(path + ".tmp")).toBe(false);
      // Byte-exactness: pretty-printed with one trailing newline (writeJsonFile shape)
      expect(readFileSync(path, "utf-8")).toBe(JSON.stringify(state, null, 2) + "\n");
    } finally {
      if (ORIGINAL === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = ORIGINAL;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("test-health skips postponed projects", () => {
  const getStateDir = withSyntheticHarness(beforeEach, afterEach, {
    projects: [
      // test_command: "false" would exit non-zero and file a "Fix broken test
      // suite" task if the postponed guard fails. The guard MUST short-circuit
      // before test_command is consulted.
      { name: "postponed-proj", repo: "ex/postponed", postponed: true, test_command: "false" },
      { name: "active-proj", repo: "ex/active" },
    ],
  });

  beforeEach(() => {
    _resetPostponedProjectsCache();
  });
  afterEach(() => {
    _resetPostponedProjectsCache();
  });

  test("checkProjectTestHealth returns {skipped:true, reason:'postponed'} for postponed project", () => {
    const project = { name: "postponed-proj", repo: "ex/postponed", postponed: true, test_command: "false" } as const;
    const result = checkProjectTestHealth(project);
    expect(result).toEqual({ skipped: true, reason: "postponed" });
    // No state mutation: mag/test-health.json must not exist for the skipped project.
    expect(existsSync(testHealthStatePath())).toBe(false);
  });

  test("checkProjectTestHealth matches postponed name case-insensitively", () => {
    // Config-side name is "postponed-proj" (lowercased into the Set); a caller
    // passing "Postponed-Proj" must still be skipped.
    const project = { name: "Postponed-Proj", repo: "ex/postponed", test_command: "false" } as const;
    const result = checkProjectTestHealth(project);
    expect(result).toEqual({ skipped: true, reason: "postponed" });
  });

  test("runAllTestHealth batch guard short-circuits BEFORE calling checkProjectTestHealth for postponed project", () => {
    // AC1 invariant: the batch-loop guard MUST prevent dispatch to
    // checkProjectTestHealth, not merely produce a postponed-looking log via
    // the direct guard. Both guards otherwise emit identical observables
    // (same log string, same absent state file), so we observe dispatch
    // directly via the _runAllTestHealthDispatch seam.
    const calls: string[] = [];
    const original = _runAllTestHealthDispatch.fn;
    _runAllTestHealthDispatch.fn = (p, opts) => {
      calls.push(p.name);
      return original(p, opts);
    };
    try {
      const { lines } = captureConsoleError(() => runAllTestHealth({ project: "postponed-proj" }));
      // Primary AC1 assertion: dispatch did NOT happen for the postponed project.
      expect(calls).toEqual([]);
      // Secondary observation: batch-loop emits the postponed skip log.
      expect(lines.some((l) => l.includes("[test-health] postponed-proj: skipped (postponed)"))).toBe(true);
      // AC3 cross-check: no state mutation on skip.
      expect(existsSync(testHealthStatePath())).toBe(false);
    } finally {
      _runAllTestHealthDispatch.fn = original;
    }
  });

  test("runAllTestHealth seam DOES dispatch for non-postponed projects (positive control)", () => {
    // Mutation evidence for the previous test: prove the seam fires under
    // normal conditions, so an empty `calls` array in the postponed case
    // is meaningful (not vacuous because the seam never fires).
    const calls: string[] = [];
    const original = _runAllTestHealthDispatch.fn;
    _runAllTestHealthDispatch.fn = (p, opts) => {
      calls.push(p.name);
      return original(p, opts);
    };
    try {
      captureConsoleError(() => runAllTestHealth({ project: "active-proj" }));
      expect(calls).toEqual(["active-proj"]);
    } finally {
      _runAllTestHealthDispatch.fn = original;
    }
  });

  test("non-postponed project is not skipped for the postponed reason (negative control)", () => {
    // Mutation evidence: if the .has() check were inverted or hard-coded to true,
    // the active project would also return reason:"postponed". It must not.
    const project = { name: "active-proj", repo: "ex/active" } as const;
    const result = checkProjectTestHealth(project);
    // active-proj has no resolvable path on disk under the synthetic harness;
    // the function falls through to the path-not-found skip, NOT postponed.
    expect(result.skipped).toBe(true);
    expect(result.reason).not.toBe("postponed");
    void getStateDir; // ensures the synthetic-harness lifecycle is engaged
  });
});

describe("test-health t3code integration gate (gh-ludics-539)", () => {
  // checkProjectTestHealth / runAllTestHealth skip t3code-dependent projects
  // while mag.t3code_integration_enabled is off. Two triggers: an explicit
  // requires_t3code: true, OR the t3code-ludics name fallback.
  let TMP = "";
  const ORIG = {
    HOME: process.env.HOME,
    CONFIG: process.env.LUDICS_CONFIG,
    HARNESS: process.env.LUDICS_HARNESS_DIR,
  };

  /** Write config.yaml controlling the t3code flag and optional projects block. */
  function writeConfig(opts: { t3codeEnabled: boolean; projectsBlock?: string }): void {
    const cfgPath = join(TMP, "config.yaml");
    const mag = opts.t3codeEnabled ? "mag:\n  t3code_integration_enabled: true\n" : "";
    writeFileSync(cfgPath, `state_repo: test/state\nstate_path: harness\n${mag}${opts.projectsBlock ?? ""}`);
    process.env.LUDICS_CONFIG = cfgPath;
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-health-t3code-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = TMP;
    _resetPostponedProjectsCache();
  });

  afterEach(() => {
    if (ORIG.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIG.HOME;
    if (ORIG.CONFIG === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = ORIG.CONFIG;
    if (ORIG.HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIG.HARNESS;
    _resetPostponedProjectsCache();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("checkProjectTestHealth skips a requires_t3code: true project when flag off", () => {
    writeConfig({ t3codeEnabled: false });
    // Trigger 1: explicit per-project opt-in (name is NOT t3code-ludics, so the
    // name fallback is not what fires here).
    const project = { name: "some-t3code-dep", repo: "ex/dep", requires_t3code: true } as const;
    const result = checkProjectTestHealth(project);
    expect(result).toEqual({ skipped: true, reason: "t3code-integration-paused" });
    // Skip returns before resolveProjectPath / state write: no test-health.json.
    expect(existsSync(testHealthStatePath())).toBe(false);
  });

  test("checkProjectTestHealth skips the t3code-ludics project by name when flag off", () => {
    writeConfig({ t3codeEnabled: false });
    // Trigger 2: name fallback — no requires_t3code annotation present.
    const project = { name: "t3code-ludics", repo: "lukstafi/t3code-ludics" } as const;
    const result = checkProjectTestHealth(project);
    expect(result).toEqual({ skipped: true, reason: "t3code-integration-paused" });
  });

  test("checkProjectTestHealth does NOT skip an ordinary project for this reason (negative control)", () => {
    writeConfig({ t3codeEnabled: false });
    // Mutation evidence: a project with neither trigger must not get the paused
    // skip — if the guard were unconditional it would. It falls through to the
    // path-not-found skip instead.
    const project = { name: "ordinary-proj", repo: "ex/ordinary" } as const;
    const result = checkProjectTestHealth(project);
    expect(result.reason).not.toBe("t3code-integration-paused");
  });

  test("checkProjectTestHealth does NOT skip a requires_t3code project when flag ON (positive control)", () => {
    writeConfig({ t3codeEnabled: true });
    // With the integration enabled, the requires_t3code project runs normally —
    // falls through to the path-not-found skip (no path on disk), not paused.
    const project = { name: "some-t3code-dep", repo: "ex/dep", requires_t3code: true } as const;
    const result = checkProjectTestHealth(project);
    expect(result.reason).not.toBe("t3code-integration-paused");
  });

  test("runAllTestHealth emits the visible skip line and does NOT dispatch for a paused t3code project", () => {
    writeConfig({
      t3codeEnabled: false,
      projectsBlock: "projects:\n  - name: t3code-ludics\n    repo: lukstafi/t3code-ludics\n",
    });
    const calls: string[] = [];
    const original = _runAllTestHealthDispatch.fn;
    _runAllTestHealthDispatch.fn = (p, opts) => {
      calls.push(p.name);
      return original(p, opts);
    };
    try {
      const { lines } = captureConsoleError(() => runAllTestHealth({ project: "t3code-ludics" }));
      // Invariant: the batch-loop guard short-circuits BEFORE dispatch — the
      // skip is visible (mirrors postponed) and checkProjectTestHealth is not
      // even called for the paused project.
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.includes("[test-health] t3code-ludics: skipped (t3code-integration-paused)"))).toBe(true);
    } finally {
      _runAllTestHealthDispatch.fn = original;
    }
  });
});

describe("test-health capability gating (gh-ludics-578)", () => {
  // Current host is pinned via LUDICS_CLUSTER_MACHINE_NAME against a scratch
  // cluster config; routed remote execution is injected through the
  // _remoteTestExec seam so no real SSH/network runs. tasksCreate's side effect
  // (a markdown file under <harness>/tasks) is observed on disk: the no-task
  // guarantee is "the tasks dir does not exist".
  let TMP = "";
  const ORIG = {
    HOME: process.env.HOME,
    CONFIG: process.env.LUDICS_CONFIG,
    HARNESS: process.env.LUDICS_HARNESS_DIR,
    MACHINE: process.env.LUDICS_CLUSTER_MACHINE_NAME,
  };
  const ORIGINAL_REMOTE = _remoteTestExec.fn;

  // mac-studio = apple-silicon (the always-on leader Mag runs on); minipc-wsl =
  // the sole nvidia worker (always_on: false). Mirrors the live config the
  // proposal corrected.
  const CLUSTER = `cluster:
  transport: tailscale
  machines:
    - name: mac-studio
      host: mac-studio.ts.net
      role: leader
      os: macos
      gpu: apple-silicon
      always_on: true
    - name: minipc-wsl
      host: minipc-wsl.ts.net
      role: worker
      os: linux
      gpu: nvidia
`;

  /** Write config.yaml. `cluster` defaults on; pass `{ cluster: "" }` to omit it
   *  (cluster-disabled case). `projectsBlock` declares postponed/requirements
   *  for projects the guards read from config (postponedProjectSet). */
  function writeConfig(opts?: { cluster?: string; projectsBlock?: string }): void {
    const cfgPath = join(TMP, "config.yaml");
    const cluster = opts?.cluster ?? CLUSTER;
    writeFileSync(cfgPath, `state_repo: test/state\nstate_path: harness\n${cluster}${opts?.projectsBlock ?? ""}`);
    process.env.LUDICS_CONFIG = cfgPath;
  }

  function writeHeartbeat(name: string, ageSeconds: number): void {
    const dir = heartbeatsDir();
    mkdirSync(dir, { recursive: true });
    const epoch = Math.floor(Date.now() / 1000) - ageSeconds;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ node: name, epoch }));
  }

  function taskFiles(): string[] {
    const dir = join(TMP, "tasks");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-health-cap-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = TMP;
    _resetPostponedProjectsCache();
  });

  afterEach(() => {
    _remoteTestExec.fn = ORIGINAL_REMOTE;
    if (ORIG.HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG.HOME;
    if (ORIG.CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIG.CONFIG;
    if (ORIG.HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIG.HARNESS;
    if (ORIG.MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIG.MACHINE;
    _resetPostponedProjectsCache();
    rmSync(TMP, { recursive: true, force: true });
  });

  // --- AC1: predicate ---

  test("requirementsSatisfiedByCurrentHost: satisfied / unmet / host-unknown / no-reqs", () => {
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // apple-silicon / macos

    // No requirements → always satisfied.
    expect(requirementsSatisfiedByCurrentHost({ name: "p", repo: "x/p" }).status).toBe("satisfied");
    // Met (apple-silicon on mac-studio).
    expect(requirementsSatisfiedByCurrentHost({ name: "p", repo: "x/p", requirements: { gpu: "apple-silicon" } }).status).toBe("satisfied");
    // Unmet (nvidia on apple-silicon host).
    expect(requirementsSatisfiedByCurrentHost({ name: "p", repo: "x/p", requirements: { gpu: "nvidia" } }).status).toBe("unmet");
    // Both keys: os matches, gpu mismatch → unmet (exact per-key equality).
    expect(requirementsSatisfiedByCurrentHost({ name: "p", repo: "x/p", requirements: { os: "macos", gpu: "nvidia" } }).status).toBe("unmet");

    // Host unknown (name not in cluster) → host-unknown for gated, satisfied for free.
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "ghost";
    expect(requirementsSatisfiedByCurrentHost({ name: "p", repo: "x/p", requirements: { gpu: "nvidia" } }).status).toBe("host-unknown");
    expect(requirementsSatisfiedByCurrentHost({ name: "p", repo: "x/p" }).status).toBe("satisfied");
  });

  // --- AC3: capability-met runs unchanged ---

  test("capability-met project is NOT skipped for requirements-unmet (falls through)", () => {
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    // ocaml-metal-shaped: gpu apple-silicon, met on mac-studio. No checkout on
    // disk → falls through to path-not-found, NOT requirements-unmet.
    const project = { name: "ocaml-metal", repo: "ex/metal", requirements: { gpu: "apple-silicon" } } as const;
    const result = checkProjectTestHealth(project);
    expect(result.reason).not.toBe("requirements-unmet");
    expect(result.reason).toBe("path-not-found");
  });

  // --- AC4: routed remote execution ---

  test("unmet + online capable worker → routes; a real remote failure files a fix-task", () => {
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // incapable (apple-silicon)
    writeHeartbeat("minipc-wsl", 10); // fresh nvidia worker

    const calls: Array<{ host: string; cmd: string; cwd: string }> = [];
    _remoteTestExec.fn = (machine, cmd, opts): RemoteRunResult => {
      calls.push({ host: machine.host, cmd, cwd: opts.cwd });
      return { kind: "ran", ok: false, stdout: "3 tests failed", stderr: "", timedOut: false };
    };

    const project = { name: "ocaml-cudajit", repo: "ex/cudajit", requirements: { gpu: "nvidia" }, test_command: "dune runtest", path: "~/ocaml-cudajit" } as const;
    const result = checkProjectTestHealth(project, { force: true });

    // Routed to the nvidia worker with the project's command + remote checkout.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.host).toBe("minipc-wsl.ts.net");
    expect(calls[0]!.cmd).toBe("dune runtest");
    expect(calls[0]!.cwd).toBe("~/ocaml-cudajit");
    // Same result shape as a local run; a genuine non-zero result files a task.
    expect(result).toMatchObject({ skipped: false, passed: false });
    expect(existsSync(testHealthStatePath())).toBe(true); // state persisted
    // gh-ludics-605: container/child model files TWO tasks — the `leaf: false`
    // umbrella container plus one dated episode child `subtask_of` it.
    expect(taskFiles()).toHaveLength(2); // container + dated child
  });

  // --- AC5: routing degrades to skip-not-fail ---

  test("unmet + transport/connectivity failure → skip, NO state, NO fix-task", () => {
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    writeHeartbeat("minipc-wsl", 10);

    let fired = false;
    _remoteTestExec.fn = (): RemoteRunResult => {
      fired = true;
      return { kind: "transport-error", detail: "ssh: connect to host minipc-wsl.ts.net: Connection refused" };
    };

    const project = { name: "ocaml-cudajit", repo: "ex/cudajit", requirements: { gpu: "nvidia" }, test_command: "dune runtest" } as const;
    const result = checkProjectTestHealth(project, { force: true });

    expect(fired).toBe(true); // routing was attempted (distinguishes from no-worker skip)
    expect(result).toEqual({ skipped: true, reason: "requirements-unmet" });
    expect(existsSync(testHealthStatePath())).toBe(false); // no state mutation
    expect(taskFiles()).toEqual([]); // no fix-task
  });

  test("unmet + NO online worker → skip requirements-unmet; remote exec never attempted (AC5/AC6: cudajit on mac-studio)", () => {
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    // No heartbeat for minipc-wsl → offline → not routable.

    let fired = false;
    _remoteTestExec.fn = (): RemoteRunResult => { fired = true; return { kind: "transport-error", detail: "" }; };

    const project = { name: "ocaml-cudajit", repo: "ex/cudajit", requirements: { gpu: "nvidia" }, test_command: "dune runtest" } as const;
    const result = checkProjectTestHealth(project, { force: true });

    expect(result).toEqual({ skipped: true, reason: "requirements-unmet" });
    expect(fired).toBe(false); // short-circuits at worker selection — never runs/fails locally
    expect(existsSync(testHealthStatePath())).toBe(false);
    expect(taskFiles()).toEqual([]);
  });

  test("unmet + online worker but NO test_command and NO resolvable checkout → skip (must not auto-detect from controller cwd)", () => {
    // Regression (PR #582 review): with no test_command and no checkout on the
    // controller, resolveProjectPath returns "" and a naive detectTestCommand("")
    // would probe the controller's process cwd — which here (the ludics repo) has
    // bun.lock, yielding "bun test" and wrongly routing an unrelated command.
    // Invariant: routing requires a command we can actually name; otherwise skip.
    // Mutation: reverting to detectTestCommand(resolveProjectPath(...)) makes
    // `fired` true (bun test routed) from the repo cwd.
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    writeHeartbeat("minipc-wsl", 10); // capable worker IS online

    let fired = false;
    _remoteTestExec.fn = (): RemoteRunResult => { fired = true; return { kind: "ran", ok: true, stdout: "", stderr: "", timedOut: false }; };

    // No test_command, no path → unresolvable command.
    const project = { name: "ocaml-cudajit", repo: "ex/cudajit", requirements: { gpu: "nvidia" } } as const;
    const result = checkProjectTestHealth(project, { force: true });

    expect(result).toEqual({ skipped: true, reason: "requirements-unmet" });
    expect(fired).toBe(false); // never routed a cwd-detected command
    expect(existsSync(testHealthStatePath())).toBe(false);
    expect(taskFiles()).toEqual([]);
  });

  // --- AC2: unknown-capability host ---

  test("unknown host (name not in cluster): gated project skips, requirement-free runs", () => {
    writeConfig();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "ghost"; // not a configured machine

    const gated = { name: "ocaml-cudajit", repo: "ex/cudajit", requirements: { gpu: "nvidia" }, test_command: "dune runtest" } as const;
    expect(checkProjectTestHealth(gated, { force: true })).toEqual({ skipped: true, reason: "requirements-unmet" });
    expect(taskFiles()).toEqual([]);

    // Negative control for AC2: a requirement-free project must NOT be skipped
    // for requirements-unmet on the same unknown host (falls through).
    const free = { name: "ludics", repo: "ex/ludics" } as const;
    expect(checkProjectTestHealth(free, { force: true }).reason).not.toBe("requirements-unmet");
  });

  test("cluster disabled: gated project skips requirements-unmet", () => {
    writeConfig({ cluster: "" }); // no cluster block → clusterEnabled() false
    const gated = { name: "ocaml-cudajit", repo: "ex/cudajit", requirements: { gpu: "nvidia" }, test_command: "dune runtest" } as const;
    expect(checkProjectTestHealth(gated, { force: true })).toEqual({ skipped: true, reason: "requirements-unmet" });
  });

  // --- AC7: precedence ---

  test("postponed wins over requirements-unmet (ocaml-hipjit: postponed + gpu:amd)", () => {
    // postponedProjectSet reads config.projects[].postponed, so the project must
    // be declared postponed in config (not just on the literal).
    writeConfig({
      projectsBlock: "projects:\n  - name: ocaml-hipjit\n    repo: ex/hipjit\n    postponed: true\n    requirements:\n      gpu: amd\n",
    });
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // would be unmet for gpu:amd
    _resetPostponedProjectsCache();

    const project = { name: "ocaml-hipjit", repo: "ex/hipjit", postponed: true, requirements: { gpu: "amd" }, test_command: "false" } as const;
    const result = checkProjectTestHealth(project, { force: true });
    expect(result).toEqual({ skipped: true, reason: "postponed" }); // NOT requirements-unmet
  });

  // --- AC8: batch-loop visible skip line ---

  test("runAllTestHealth emits '[test-health] <name>: skipped (requirements-unmet)'", () => {
    writeConfig({
      projectsBlock: "projects:\n  - name: ocaml-cudajit\n    repo: ex/cudajit\n    test_command: dune runtest\n    requirements:\n      gpu: nvidia\n",
    });
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio";
    // minipc-wsl offline → unmet + no worker → requirements-unmet skip.

    const { lines } = captureConsoleError(() => runAllTestHealth({ project: "ocaml-cudajit", force: true }));
    expect(lines.some((l) => l.includes("[test-health] ocaml-cudajit: skipped (requirements-unmet)"))).toBe(true);
    expect(taskFiles()).toEqual([]);
  });
});

describe("test-health container/child auto-filer (gh-ludics-605)", () => {
  // Drive failing runs through the remote-exec seam (a nvidia-gated project
  // routed to an online worker returning ok:false), which flows through the
  // exact same finalizeExecutedRun → fileTestFailureEpisode path as a local
  // failure. Inspect the resulting task files on disk.
  let TMP = "";
  const ORIG = {
    HOME: process.env.HOME,
    CONFIG: process.env.LUDICS_CONFIG,
    HARNESS: process.env.LUDICS_HARNESS_DIR,
    MACHINE: process.env.LUDICS_CLUSTER_MACHINE_NAME,
  };
  const ORIGINAL_REMOTE = _remoteTestExec.fn;

  const CLUSTER = `cluster:
  transport: tailscale
  machines:
    - name: mac-studio
      host: mac-studio.ts.net
      role: leader
      os: macos
      gpu: apple-silicon
      always_on: true
    - name: minipc-wsl
      host: minipc-wsl.ts.net
      role: worker
      os: linux
      gpu: nvidia
`;

  function writeConfig(): void {
    const cfgPath = join(TMP, "config.yaml");
    writeFileSync(cfgPath, `state_repo: test/state\nstate_path: harness\n${CLUSTER}`);
    process.env.LUDICS_CONFIG = cfgPath;
  }

  function writeHeartbeat(name: string, ageSeconds: number): void {
    const dir = heartbeatsDir();
    mkdirSync(dir, { recursive: true });
    const epoch = Math.floor(Date.now() / 1000) - ageSeconds;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ node: name, epoch }));
  }

  const PROJECT = "ludics" as const;
  function project() {
    return { name: PROJECT, repo: "ex/ludics", requirements: { gpu: "nvidia" }, test_command: "dune runtest", path: "~/ludics" } as const;
  }

  function tasksDir(): string {
    return join(TMP, "tasks");
  }

  function readTask(file: string): { id: string; status?: string; leaf?: boolean; subtask_of: string | null; title?: string; body: string } {
    const content = readFileSync(join(tasksDir(), file), "utf-8");
    const fm = parseTaskFrontmatter(content);
    const bodyIdx = content.indexOf("\n---", 3);
    return {
      id: fm.id!,
      status: fm.status,
      leaf: fm.leaf,
      subtask_of: fm.dependencies?.subtask_of ?? null,
      title: fm.title,
      body: bodyIdx >= 0 ? content.slice(bodyIdx) : content,
    };
  }

  function allTasks() {
    const dir = tasksDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map(readTask);
  }

  function container() {
    return allTasks().find((t) => t.leaf === false && t.subtask_of === null);
  }
  function children() {
    const c = container();
    return c ? allTasks().filter((t) => t.subtask_of === c.id) : [];
  }

  /** Trigger one failing run; failures stderr drives the child body. */
  function failingRun(stderr = "FAILED: 3 tests broke"): void {
    _remoteTestExec.fn = () => ({ kind: "ran", ok: false, stdout: "", stderr, timedOut: false } as RemoteRunResult);
    checkProjectTestHealth(project(), { force: true });
  }

  /**
   * Simulate the existing dated child belonging to a *prior day* so today's
   * date-stamped child gets a distinct fingerprint (filename). Renames the file
   * to a stable past-dated id and rewrites its `id:`/`title:` to a past date,
   * freeing today's fingerprint for a fresh child. Returns the new (past) id.
   */
  function agePriorChildToPastDay(childId: string): string {
    const oldFile = join(tasksDir(), `${childId}.md`);
    const pastId = "task-past-episode";
    const content = readFileSync(oldFile, "utf-8")
      .replace(/^id: .+$/m, `id: ${pastId}`)
      .replace(/— \d{4}-\d{2}-\d{2}/g, "— 2000-01-01");
    const newFile = join(tasksDir(), `${pastId}.md`);
    writeFileSync(newFile, content);
    rmSync(oldFile);
    return pastId;
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-health-605-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = TMP;
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // incapable → routes to worker
    _resetPostponedProjectsCache();
    writeConfig();
    writeHeartbeat("minipc-wsl", 10);
  });

  afterEach(() => {
    _remoteTestExec.fn = ORIGINAL_REMOTE;
    if (ORIG.HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG.HOME;
    if (ORIG.CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIG.CONFIG;
    if (ORIG.HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIG.HARNESS;
    if (ORIG.MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIG.MACHINE;
    _resetPostponedProjectsCache();
    rmSync(TMP, { recursive: true, force: true });
  });

  test("first failure → container (leaf:false, ready) + one dated child subtask_of it, child carries failures excerpt", () => {
    failingRun("FAILED: assertion in foo_test");

    const c = container();
    expect(c).toBeDefined();
    expect(c!.leaf).toBe(false);
    expect(c!.status).toBe("ready");
    expect(c!.title).toBe(`Fix broken test suite: ${PROJECT}`);

    const kids = children();
    expect(kids).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(kids[0]!.title).toBe(`Fix broken test suite: ${PROJECT} — ${today}`);
    expect(kids[0]!.subtask_of).toBe(c!.id);
    // Failures excerpt embedded in the child body (not the container).
    expect(kids[0]!.body).toContain("FAILED: assertion in foo_test");
    expect(c!.body).not.toContain("FAILED: assertion in foo_test");
  });

  test("active episode (container ready + open child) → NO new task on re-break", () => {
    failingRun();
    const before = allTasks().length;
    expect(children()).toHaveLength(1);

    // Re-break while the child is still open (ready).
    failingRun();
    expect(allTasks().length).toBe(before); // no new files
    expect(children()).toHaveLength(1);
  });

  test("same-day double-break → no duplicate child", () => {
    failingRun();
    failingRun(); // identical day
    expect(children()).toHaveLength(1);
  });

  test("same-day, today's child marked done + suite still red + no other active child → child REOPENED to ready", () => {
    // A claimed same-day fix that didn't hold: the only (dated) child is done,
    // the container stays ready (verify never closes it), and a fresh same-day
    // child would collide on the date fingerprint. Reopen in place so the
    // episode is actionable again today instead of waiting for the UTC rollover.
    failingRun();
    const childId = children()[0]!.id;
    const childFile = join(tasksDir(), `${childId}.md`);
    transitionStatus(childFile, parseTaskFrontmatter(readFileSync(childFile, "utf-8")).status ?? "ready", "done");
    expect(children()[0]!.status).toBe("done");

    failingRun();

    // No new child filed (date collision); the existing one is reopened.
    expect(children()).toHaveLength(1);
    expect(children()[0]!.id).toBe(childId);
    expect(children()[0]!.status).toBe("ready");
  });

  test("same-day, today's child marked abandoned + suite still red → child STAYS abandoned (respects set-aside)", () => {
    // A deliberate same-day set-aside must be respected: transitionStatus only
    // reopens done/merged, so abandoned/stale are left untouched and NO fresh
    // same-day child is filed. A new child is filed tomorrow under a new date.
    failingRun();
    const childId = children()[0]!.id;
    const childFile = join(tasksDir(), `${childId}.md`);
    transitionStatus(childFile, parseTaskFrontmatter(readFileSync(childFile, "utf-8")).status ?? "ready", "abandoned");
    expect(children()[0]!.status).toBe("abandoned");

    failingRun();

    expect(children()).toHaveLength(1);
    expect(children()[0]!.id).toBe(childId);
    expect(children()[0]!.status).toBe("abandoned"); // untouched
  });

  for (const terminal of ["done", "abandoned", "stale"] as const) {
    test(`re-break after container terminal (${terminal}) → container revived to ready + fresh child`, () => {
      failingRun();
      const c = container()!;
      const firstChildId = children()[0]!.id;

      // Age the prior child to a past day (so today's child is a fresh
      // fingerprint), resolve it, then close the container to the terminal
      // status under test.
      const pastId = agePriorChildToPastDay(firstChildId);
      const childFile = join(tasksDir(), `${pastId}.md`);
      transitionStatus(childFile, parseTaskFrontmatter(readFileSync(childFile, "utf-8")).status ?? "ready", "done");
      const containerFile = join(tasksDir(), `${c.id}.md`);
      transitionStatus(containerFile, "ready", terminal);

      failingRun();

      const revived = container()!;
      expect(revived.status).toBe("ready"); // revived
      expect(revived.leaf).toBe(false); // still a container
      // A fresh dated child exists (today's), distinct from the resolved one.
      const today = new Date().toISOString().slice(0, 10);
      const fresh = children().find((k) => k.title === `Fix broken test suite: ${PROJECT} — ${today}`);
      expect(fresh).toBeDefined();
      expect(fresh!.id).not.toBe(pastId);
    });
  }

  test("self-heal guard: container non-terminal but child already resolved → fresh child filed (signal not lost)", () => {
    // Models the verify-container-completion interaction: the sweep queues
    // verify when all children are terminal, but verify only NOTIFIES — it does
    // NOT close the container. So the container can sit `ready` with a resolved
    // child while the suite is still red. The active-episode no-op is keyed on
    // an OPEN child, not container status, so a fresh child is filed.
    failingRun();
    const firstChildId = children()[0]!.id;

    // Age the prior child to a past day and resolve it (as the downstream user
    // action after verify-container-completion would), but leave the container
    // `ready` — verify never closes it.
    const pastId = agePriorChildToPastDay(firstChildId);
    const childFile = join(tasksDir(), `${pastId}.md`);
    transitionStatus(childFile, parseTaskFrontmatter(readFileSync(childFile, "utf-8")).status ?? "ready", "done");
    expect(container()!.status).toBe("ready"); // container still open

    failingRun();

    const today = new Date().toISOString().slice(0, 10);
    const fresh = children().find((k) => k.title === `Fix broken test suite: ${PROJECT} — ${today}`);
    expect(fresh).toBeDefined(); // signal preserved: a new open episode exists
    expect(fresh!.id).not.toBe(pastId);
  });
});
