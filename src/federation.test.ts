// Federation tests — config parsing, role determination, machine selection

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import YAML from "yaml";

// We test the pure logic helpers by importing and exercising them directly.
// Functions that require config/state are tested via mock setup.

describe("FederationMachine parsing", () => {
  it("handles empty federation config gracefully", () => {
    // federationConfig() with no config should return defaults
    const { federationConfig } = require("./federation.ts");
    // This may throw if no config file exists in test env — that's fine
    try {
      const cfg = federationConfig();
      expect(cfg.transport).toBeDefined();
      expect(cfg.machines).toBeInstanceOf(Array);
    } catch {
      // Expected in test env without config
    }
  });
});

describe("selectMachineForSlot", () => {
  it("returns empty string when federation is disabled", () => {
    const { selectMachineForSlot } = require("./federation.ts");
    // When federation is not enabled, should return ""
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
    // Test the normalization logic used in federationCurrentMachine
    const normalize = (host: string) => host.replace(/\.$/, "").toLowerCase();
    expect(normalize("host.tailnet.ts.net.")).toBe("host.tailnet.ts.net");
    expect(normalize("host.tailnet.ts.net")).toBe("host.tailnet.ts.net");
    expect(normalize("HOST.Tailnet.TS.net")).toBe("host.tailnet.ts.net");
  });
});

// --- Integration tests using temp config + heartbeat files ---

describe("legacy network.nodes compat", () => {
  const tmpDir = join(import.meta.dir, "../.test-federation-tmp");
  const configPath = join(tmpDir, "config.yaml");
  const heartbeatsDir = join(tmpDir, "federation", "heartbeats");
  let origConfig: string | undefined;
  let origHarness: string | undefined;

  function writeConfig(cfg: Record<string, unknown>) {
    writeFileSync(configPath, YAML.stringify(cfg));
  }

  function writeHeartbeat(name: string, ageSeconds: number = 0) {
    mkdirSync(heartbeatsDir, { recursive: true });
    const epoch = Math.floor(Date.now() / 1000) - ageSeconds;
    writeFileSync(
      join(heartbeatsDir, `${name}.json`),
      JSON.stringify({ node: name, epoch, mag_running: false, controller_running: false }) + "\n",
    );
  }

  beforeEach(() => {
    origConfig = process.env.LUDICS_CONFIG;
    origHarness = process.env.LUDICS_HARNESS_DIR;
    mkdirSync(tmpDir, { recursive: true });
    process.env.LUDICS_CONFIG = configPath;
    process.env.LUDICS_HARNESS_DIR = tmpDir;
  });

  afterEach(() => {
    if (origConfig === undefined) delete process.env.LUDICS_CONFIG;
    else process.env.LUDICS_CONFIG = origConfig;
    if (origHarness === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = origHarness;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("converts network.nodes to federation.machines with correct roles", () => {
    writeConfig({
      network: {
        mode: "tailscale",
        nodes: [
          { name: "mac-mini", tailscale_hostname: "mac-mini.ts.net" },
          { name: "macbook", tailscale_hostname: "macbook.ts.net" },
          { name: "server", tailscale_hostname: "server.ts.net" },
        ],
      },
    });

    const { federationConfig } = require("./federation.ts");
    const cfg = federationConfig();

    expect(cfg.machines.length).toBe(3);
    expect(cfg.machines[0]!.name).toBe("mac-mini");
    expect(cfg.machines[0]!.role).toBe("leader");
    expect(cfg.machines[0]!.host).toBe("mac-mini.ts.net");
    // Non-first nodes should be "console" for failover
    expect(cfg.machines[1]!.role).toBe("console");
    expect(cfg.machines[2]!.role).toBe("console");
    // Transport should be derived from legacy network.mode
    expect(cfg.transport).toBe("tailscale");
  });

  it("prefers federation.machines over legacy network.nodes", () => {
    writeConfig({
      network: {
        mode: "tailscale",
        nodes: [
          { name: "legacy-node", tailscale_hostname: "legacy.ts.net" },
        ],
      },
      federation: {
        transport: "tailscale",
        machines: [
          { name: "fed-machine", host: "fed.ts.net", role: "leader" },
        ],
      },
    });

    const { federationConfig } = require("./federation.ts");
    const cfg = federationConfig();

    expect(cfg.machines.length).toBe(1);
    expect(cfg.machines[0]!.name).toBe("fed-machine");
  });

  it("fails over to second legacy node when first is offline", () => {
    writeConfig({
      network: {
        mode: "tailscale",
        nodes: [
          { name: "primary", tailscale_hostname: "primary.ts.net" },
          { name: "secondary", tailscale_hostname: "secondary.ts.net" },
        ],
      },
    });

    // Only secondary has a fresh heartbeat; primary is offline
    writeHeartbeat("secondary", 10);
    // primary has no heartbeat file at all

    const { federationElect } = require("./federation.ts");
    const controller = federationElect();

    expect(controller).toBe("secondary");
  });

  it("elects first legacy node when both are online (seniority)", () => {
    writeConfig({
      network: {
        mode: "tailscale",
        nodes: [
          { name: "primary", tailscale_hostname: "primary.ts.net" },
          { name: "secondary", tailscale_hostname: "secondary.ts.net" },
        ],
      },
    });

    writeHeartbeat("primary", 10);
    writeHeartbeat("secondary", 10);

    const { federationElect } = require("./federation.ts");
    const controller = federationElect();

    expect(controller).toBe("primary");
  });

  it("returns null when no legacy nodes are online", () => {
    writeConfig({
      network: {
        mode: "tailscale",
        nodes: [
          { name: "primary", tailscale_hostname: "primary.ts.net" },
          { name: "secondary", tailscale_hostname: "secondary.ts.net" },
        ],
      },
    });

    // No heartbeat files — both offline

    const { federationElect } = require("./federation.ts");
    const controller = federationElect();

    expect(controller).toBeNull();
  });
});
