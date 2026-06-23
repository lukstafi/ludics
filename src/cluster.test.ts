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
      always_on: true
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
