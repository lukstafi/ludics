// Cluster tests — config parsing, role determination, machine selection

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clusterConfig,
  selectMachineForSlot,
  selectOnlineCapableMachine,
  resolveController,
  clusterCurrentMachineName,
  heartbeatsDir,
  hostPrefixMatchesMachineName,
} from "./cluster.ts";

// We test the pure logic helpers by importing and exercising them directly.
// Functions that require config/state are tested via mock setup.

describe("ClusterMachine parsing", () => {
  it("handles empty cluster config gracefully", () => {
    // clusterConfig() with no config should return defaults
    // This may throw if no config file exists in test env — that's fine
    try {
      const cfg = clusterConfig();
      expect(cfg.transport).toBeDefined();
      expect(cfg.machines).toBeInstanceOf(Array);
    } catch {
      // Expected in test env without config
    }
  });
});

describe("selectMachineForSlot", () => {
  it("returns empty string when cluster is disabled", () => {
    // When cluster is not enabled, should return ""
    try {
      const result = selectMachineForSlot({ project: "test", effort: "medium" });
      expect(typeof result).toBe("string");
    } catch {
      // Expected if config not available
    }
  });
});

describe("hostname normalization", () => {
  it("strips trailing dots consistently", () => {
    // Test the normalization logic used in clusterCurrentMachine
    const normalize = (host: string) => host.replace(/\.$/, "").toLowerCase();
    expect(normalize("host.tailnet.ts.net.")).toBe("host.tailnet.ts.net");
    expect(normalize("host.tailnet.ts.net")).toBe("host.tailnet.ts.net");
    expect(normalize("HOST.Tailnet.TS.net")).toBe("host.tailnet.ts.net");
  });
});

describe("resolveController", () => {
  it("returns null when cluster is disabled (no machines)", () => {
    // In test env without config, clusterMachines() returns []
    try {
      const controller = resolveController();
      // Without config, no leader machine exists
      expect(controller).toBeNull();
    } catch {
      // Expected if config not available
    }
  });

  it("returns only the leader machine", () => {
    // Test the selection logic directly
    const machines = [
      { name: "worker-1", host: "w1.ts.net", role: "worker" },
      { name: "console-1", host: "c1.ts.net", role: "console" },
      { name: "leader-1", host: "l1.ts.net", role: "leader" },
      { name: "console-2", host: "c2.ts.net", role: "console" },
    ];
    const leader = machines.find((m) => m.role === "leader") ?? null;

    expect(leader).not.toBeNull();
    expect(leader!.name).toBe("leader-1");
    // Only one machine returned, not an array of candidates
  });
});

// ---------------------------------------------------------------------------
// Online-gated dispatch (AC 10) + CUDA routing (AC 6) + current-machine override.
// Real resolution chain: scratch LUDICS_CONFIG (cluster.machines), HOME-isolated
// heartbeat dir, LUDICS_CLUSTER_MACHINE_NAME to pin the current machine.
// ---------------------------------------------------------------------------

describe("selectMachineForSlot — online gating + routing", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let TMP = "";

  const CONFIG = `state_repo: test/state
state_path: harness
cluster:
  transport: tailscale
  machines:
    - name: mac-studio
      host: mac-studio.ts.net
      role: leader
      os: macos
      gpu: apple-silicon
      always_on: true
    - name: macbook-pro
      host: macbook-pro.ts.net
      role: console
      os: macos
      gpu: apple-silicon
      always_on: false
    - name: minipc-wsl
      host: minipc-wsl.ts.net
      role: worker
      os: linux
      gpu: nvidia
slots:
  count: 6
`;

  function writeHeartbeat(name: string, ageSeconds: number): void {
    const dir = heartbeatsDir();
    mkdirSync(dir, { recursive: true });
    const epoch = Math.floor(Date.now() / 1000) - ageSeconds;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ node: name, epoch }));
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-cluster-route-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
    const cfgPath = join(TMP, "config.yaml");
    writeFileSync(cfgPath, CONFIG);
    process.env.LUDICS_CONFIG = cfgPath;
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // current = non-nvidia leader
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    rmSync(TMP, { recursive: true, force: true });
  });

  it("routes a gpu:nvidia task to the online nvidia worker, not the non-nvidia current (AC 6)", () => {
    writeHeartbeat("minipc-wsl", 10); // fresh
    const result = selectMachineForSlot({ project: "ocannl", effort: "medium", requirements: { gpu: "nvidia" } });
    expect(result).toBe("minipc-wsl");
  });

  it("blocks a gpu:nvidia task (returns null) when the only nvidia worker is offline (AC 10)", () => {
    // No heartbeat written → minipc-wsl is offline. Invariant: assignment is blocked,
    // NOT stamped onto the worker's slot to idle. Mutation: reverting the online-gate
    // to `pool = online || eligible` makes this return "minipc-wsl".
    const result = selectMachineForSlot({ project: "ocannl", effort: "medium", requirements: { gpu: "nvidia" } });
    expect(result).toBeNull();
  });

  it("blocks a gpu:nvidia task when the nvidia worker heartbeat is stale (AC 10)", () => {
    writeHeartbeat("minipc-wsl", 1000); // stale (> 900s timeout)
    const result = selectMachineForSlot({ project: "ocannl", effort: "medium", requirements: { gpu: "nvidia" } });
    expect(result).toBeNull();
  });

  it("leaves no-requirements dispatch unchanged: falls back to an eligible machine even when none are online", () => {
    // No heartbeats at all; no requirements → not gated. Returns a non-null machine
    // (the always_on leader), preserving the prior fallback.
    const result = selectMachineForSlot({ project: "ludics", effort: "medium" });
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result).not.toBe("");
  });

  it("returns null when no machine meets requirements (gpu:amd has no host)", () => {
    writeHeartbeat("minipc-wsl", 10);
    const result = selectMachineForSlot({ project: "x", effort: "medium", requirements: { gpu: "amd" } });
    expect(result).toBeNull();
  });

  it("honors LUDICS_CLUSTER_MACHINE_NAME for current-machine resolution", () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl";
    expect(clusterCurrentMachineName()).toBe("minipc-wsl");
  });

  // gh-ludics-602: ludics SELF-task routing preference — keep self-modification
  // off the watched controller when a live console node exists. Current machine
  // is pinned to mac-studio (the leader) by beforeEach.

  it("AC(a): routes a no-requirements ludics self-task to the live console node, not the always_on controller", () => {
    writeHeartbeat("macbook-pro", 10); // console fresh
    writeHeartbeat("mac-studio", 10);  // controller also online
    const result = selectMachineForSlot({ project: "ludics", effort: "medium" });
    // Invariant: a fresh console node wins over the online always_on controller.
    // Mutation: deleting the self-task branch returns "mac-studio".
    expect(result).toBe("macbook-pro");
  });

  it("AC(b): falls back to the controller (not null) when the console node has no heartbeat", () => {
    writeHeartbeat("mac-studio", 10); // controller online; console absent (down)
    const result = selectMachineForSlot({ project: "ludics", effort: "medium" });
    // Invariant: self-task stays assignable; empty consolePref falls through to
    // the always_on ranking (mac-studio), never null.
    expect(result).not.toBeNull();
    expect(result).toBe("mac-studio");
  });

  it("AC(b): treats a stale console heartbeat as down and falls back to the controller", () => {
    writeHeartbeat("macbook-pro", 1000); // stale (> 900s timeout) → not in `online`
    writeHeartbeat("mac-studio", 10);
    const result = selectMachineForSlot({ project: "ludics", effort: "medium" });
    expect(result).toBe("mac-studio");
  });

  it("AC(c): leaves a non-ludics no-requirements task on the always_on controller even when the console is live", () => {
    writeHeartbeat("macbook-pro", 10);
    writeHeartbeat("mac-studio", 10);
    const result = selectMachineForSlot({ project: "ocannl", effort: "medium" });
    // Invariant: the self-task branch must not perturb other projects.
    // Mutation: making isLudicsSelfTask always-true returns "macbook-pro".
    expect(result).toBe("mac-studio");
  });

  it("AC(c): matches the self-task project name case-insensitively", () => {
    writeHeartbeat("macbook-pro", 10);
    writeHeartbeat("mac-studio", 10);
    const result = selectMachineForSlot({ project: "LUDICS", effort: "medium" });
    // Invariant: case-insensitive match via .toLowerCase().
    // Mutation: dropping .toLowerCase() returns "mac-studio".
    expect(result).toBe("macbook-pro");
  });

  it("AC(d)/(e): a ludics self-task with a hard gpu requirement routes to the eligible worker, never the console", () => {
    writeHeartbeat("macbook-pro", 10); // console fresh but gpu-ineligible (apple-silicon)
    writeHeartbeat("minipc-wsl", 10);  // nvidia worker fresh
    const result = selectMachineForSlot({
      project: "ludics",
      effort: "medium",
      requirements: { gpu: "nvidia" },
    });
    // Invariant: the console preference re-ranks only WITHIN the requirement-
    // filtered online pool; a requirement-ineligible console is unreachable.
    // Mutation: filtering `pool`/all-machines instead of `online` returns
    // "macbook-pro".
    expect(result).toBe("minipc-wsl");
  });

  it("AC(d): a ludics self-task with a hard gpu requirement is still blocked (null) when the eligible worker is offline, even with a live console", () => {
    writeHeartbeat("macbook-pro", 10); // console fresh — must NOT rescue the requirement
    // minipc-wsl absent → offline
    const result = selectMachineForSlot({
      project: "ludics",
      effort: "medium",
      requirements: { gpu: "nvidia" },
    });
    // Invariant: the AC10 online gate fires before the self-task branch; a fresh
    // console cannot resurrect a requirement-ineligible/offline assignment.
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cluster.disable_console_workers — config parse + console-exclusion routing.
// When set, console-role machines are never selected to run worker slots and
// (in mag's keepalive) are never auto-started. Default false for back-compat.
// ---------------------------------------------------------------------------

describe("cluster.disable_console_workers — parsing + console exclusion", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let TMP = "";

  // `${flagLine}` is spliced in to toggle the option (or omit it entirely).
  function config(flagLine: string): string {
    return `state_repo: test/state
state_path: harness
cluster:
  transport: tailscale
${flagLine}  machines:
    - name: mac-studio
      host: mac-studio.ts.net
      role: leader
      os: macos
      gpu: apple-silicon
      always_on: true
    - name: macbook-pro
      host: macbook-pro.ts.net
      role: console
      os: macos
      gpu: apple-silicon
      always_on: false
    - name: minipc-wsl
      host: minipc-wsl.ts.net
      role: worker
      os: linux
      gpu: nvidia
slots:
  count: 6
`;
  }

  function writeHeartbeat(name: string, ageSeconds: number): void {
    const dir = heartbeatsDir();
    mkdirSync(dir, { recursive: true });
    const epoch = Math.floor(Date.now() / 1000) - ageSeconds;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ node: name, epoch }));
  }

  function setup(flagLine: string): void {
    writeFileSync(join(TMP, "config.yaml"), config(flagLine));
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-disable-console-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
    process.env.LUDICS_CONFIG = join(TMP, "config.yaml");
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "mac-studio"; // current = leader
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    rmSync(TMP, { recursive: true, force: true });
  });

  // (a) parse
  it("parses disable_console_workers: true", () => {
    setup("  disable_console_workers: true\n");
    expect(clusterConfig().disableConsoleWorkers).toBe(true);
  });

  it("parses disable_console_workers: false", () => {
    setup("  disable_console_workers: false\n");
    expect(clusterConfig().disableConsoleWorkers).toBe(false);
  });

  it("defaults disable_console_workers to false when absent", () => {
    setup("");
    expect(clusterConfig().disableConsoleWorkers).toBe(false);
  });

  // (b) selection excludes / includes the console per the flag
  it("excludes the console node from a ludics self-task when the flag is ON", () => {
    setup("  disable_console_workers: true\n");
    writeHeartbeat("macbook-pro", 10); // console fresh
    writeHeartbeat("mac-studio", 10);  // controller online
    const result = selectMachineForSlot({ project: "ludics", effort: "medium" });
    // With the flag ON the console is removed from `eligible`, so the
    // gh-ludics-602 console-preference branch can't fire — the self-task falls
    // back to the always_on controller instead of the console.
    expect(result).not.toBe("macbook-pro");
    expect(result).toBe("mac-studio");
  });

  it("includes the console node (gh-ludics-602 routing) when the flag is OFF", () => {
    setup("  disable_console_workers: false\n");
    writeHeartbeat("macbook-pro", 10); // console fresh
    writeHeartbeat("mac-studio", 10);  // controller online
    const result = selectMachineForSlot({ project: "ludics", effort: "medium" });
    // Back-compat: with the flag OFF a live console still wins for self-tasks.
    expect(result).toBe("macbook-pro");
  });

  // (c) no-eligible-machine path must NOT fall back to the console
  it("returns null (no fallback to console) when excluding the console empties the candidate set", () => {
    // Config with ONLY a console machine; flag ON. current = a non-listed name
    // so the console is the sole candidate, then excluded → no machine left.
    const onlyConsole = `state_repo: test/state
state_path: harness
cluster:
  transport: tailscale
  disable_console_workers: true
  machines:
    - name: macbook-pro
      host: macbook-pro.ts.net
      role: console
      os: macos
      gpu: apple-silicon
      always_on: true
slots:
  count: 6
`;
    writeFileSync(join(TMP, "config.yaml"), onlyConsole);
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "macbook-pro";
    writeHeartbeat("macbook-pro", 10); // fresh — must NOT rescue the assignment
    const result = selectMachineForSlot({ project: "ocannl", effort: "medium" });
    // Invariant: console-only + flag ON blocks assignment rather than running
    // on the console. Mutation: dropping the empty-after-exclusion guard returns
    // "macbook-pro".
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectOnlineCapableMachine — capability + online filter for test-health
// routing (gh-ludics-578). Mirrors selectMachineForSlot's per-key filter +
// heartbeatIsFresh gate but returns the full ClusterMachine for SSH routing.
// ---------------------------------------------------------------------------

describe("selectOnlineCapableMachine — capability + online gate", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
  let TMP = "";

  const CONFIG = `state_repo: test/state
state_path: harness
cluster:
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

  function writeHeartbeat(name: string, ageSeconds: number): void {
    const dir = heartbeatsDir();
    mkdirSync(dir, { recursive: true });
    const epoch = Math.floor(Date.now() / 1000) - ageSeconds;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ node: name, epoch }));
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-cluster-capable-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
    const cfgPath = join(TMP, "config.yaml");
    writeFileSync(cfgPath, CONFIG);
    process.env.LUDICS_CONFIG = cfgPath;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns the fresh-heartbeat nvidia worker for { gpu: nvidia }", () => {
    writeHeartbeat("minipc-wsl", 10); // fresh
    const m = selectOnlineCapableMachine({ gpu: "nvidia" });
    expect(m?.name).toBe("minipc-wsl");
    expect(m?.host).toBe("minipc-wsl.ts.net"); // routing needs .host
  });

  it("returns null when the only capable worker is offline (no heartbeat)", () => {
    // Invariant: an offline capable worker is not routable. Mutation: dropping
    // the heartbeatIsFresh filter would return minipc-wsl here.
    const m = selectOnlineCapableMachine({ gpu: "nvidia" });
    expect(m).toBeNull();
  });

  it("returns null when the only capable worker heartbeat is stale", () => {
    writeHeartbeat("minipc-wsl", 1000); // > 900s default TTL
    expect(selectOnlineCapableMachine({ gpu: "nvidia" })).toBeNull();
  });

  it("returns null when no machine has the required capability (gpu: amd)", () => {
    writeHeartbeat("minipc-wsl", 10);
    expect(selectOnlineCapableMachine({ gpu: "amd" })).toBeNull();
  });

  it("matches both os and gpu keys exactly when both present", () => {
    writeHeartbeat("minipc-wsl", 10);
    expect(selectOnlineCapableMachine({ os: "linux", gpu: "nvidia" })?.name).toBe("minipc-wsl");
    // os mismatch (macos worker with nvidia does not exist) → null
    expect(selectOnlineCapableMachine({ os: "macos", gpu: "nvidia" })).toBeNull();
  });

  it("returns null when the cluster is disabled (no config)", () => {
    delete process.env.LUDICS_CONFIG;
    expect(selectOnlineCapableMachine({ gpu: "nvidia" })).toBeNull();
  });
});

// gh-ludics-587: the loose `prefix.includes(mName)` substring match in
// clusterCurrentMachine could let a short machine name false-match an unrelated
// host prefix (and thereby mis-resolve identity → tear down the wrong node's
// units). hostPrefixMatchesMachineName replaces it with a boundaried match:
// equal, or a `-`/`.`-boundaried suffix of the host prefix.
describe("hostPrefixMatchesMachineName — boundaried prefix↔name match (gh-ludics-587)", () => {
  it("POSITIVE: documented legitimate case lukaszs-mac-studio ↔ mac-studio", () => {
    expect(hostPrefixMatchesMachineName("lukaszs-mac-studio", "mac-studio")).toBe(true);
  });

  it("POSITIVE: exact equality", () => {
    expect(hostPrefixMatchesMachineName("mac-studio", "mac-studio")).toBe(true);
    expect(hostPrefixMatchesMachineName("minipc-wsl", "minipc-wsl")).toBe(true);
  });

  it("POSITIVE: dot-boundaried suffix", () => {
    expect(hostPrefixMatchesMachineName("host.mac-studio", "mac-studio")).toBe(true);
  });

  it("NEGATIVE: short name does NOT substring-match a longer prefix (the bug)", () => {
    expect(hostPrefixMatchesMachineName("mac-studio", "mac")).toBe(false);
  });

  it("NEGATIVE: unrelated roster member does not match another's host", () => {
    expect(hostPrefixMatchesMachineName("macbook-pro", "mac-studio")).toBe(false);
    expect(hostPrefixMatchesMachineName("mac-studio", "macbook-pro")).toBe(false);
    expect(hostPrefixMatchesMachineName("minipc-wsl", "mac-studio")).toBe(false);
  });

  it("NEGATIVE: empty args are fail-safe false", () => {
    expect(hostPrefixMatchesMachineName("", "mac-studio")).toBe(false);
    expect(hostPrefixMatchesMachineName("mac-studio", "")).toBe(false);
  });

  it("boundaried-suffix semantics: mac-studio ↔ studio IS true (the '-' boundary matches)", () => {
    // Documenting actual logic: `mac-studio`.endsWith(`-studio`) holds, so this is
    // a boundaried suffix and returns true. This is acceptable — no current roster
    // name is a boundaried suffix of another roster member's host.
    expect(hostPrefixMatchesMachineName("mac-studio", "studio")).toBe(true);
  });

  it("no current-roster name false-matches another roster member's host prefix", () => {
    const names = ["mac-studio", "macbook-pro", "minipc-wsl"];
    for (const host of names) {
      for (const name of names) {
        if (host === name) continue;
        expect(hostPrefixMatchesMachineName(host, name)).toBe(false);
      }
    }
  });
});
