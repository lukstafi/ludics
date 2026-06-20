// Tests for clusterDoctor (AC 9) and wslPersistenceStatus / isWsl (AC 8).
//
// Active probes (controller HTTP reachability, keepalive-timer state, systemd/
// linger) are injected so each case is deterministic and exercises the specific
// branch it claims. Cluster identity uses the real resolution chain: scratch
// LUDICS_CONFIG with cluster.machines + LUDICS_CLUSTER_MACHINE_NAME.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clusterDoctor, wslPersistenceStatus, isWsl } from "./cluster.ts";

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
dashboard:
  port: 7678
`;

describe("clusterDoctor (AC 9)", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let TMP = "";

  // Inject all active probes so the test does not depend on a live controller,
  // systemctl, or the host platform. Default to the all-green worker scenario.
  const ok = { probeController: () => true, timerActive: () => true, timerEnabled: () => true };

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-cluster-doctor-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
    const cfgPath = join(TMP, "config.yaml");
    writeFileSync(cfgPath, CONFIG);
    process.env.LUDICS_CONFIG = cfgPath;
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // resolve as the worker
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("worker that self-identifies, reaches controller, and has an active timer passes", () => {
    const res = clusterDoctor(ok);
    expect(res.ok).toBe(true);
    expect(res.lines.join("\n")).toContain("Self-identify: minipc-wsl");
    expect(res.lines.join("\n")).toContain("Role: worker");
    expect(res.lines.join("\n")).toContain("Controller reachable: mac-studio.ts.net:7678");
    if (process.platform === "linux") {
      expect(res.lines.join("\n")).toContain("Keepalive timer: enabled + active");
    }
  });

  test("host not in cluster.machines fails self-identify with remediation", () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "ghost-host";
    const res = clusterDoctor(ok);
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("Self-identify: FAILED");
    expect(res.lines.join("\n")).toContain("not in cluster.machines");
  });

  test("worker with unreachable controller fails", () => {
    const res = clusterDoctor({ ...ok, probeController: () => false });
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("Controller unreachable");
  });

  test("worker with inactive keepalive timer fails (Linux)", () => {
    if (process.platform !== "linux") return; // timer check is Linux-only
    const res = clusterDoctor({ ...ok, timerActive: () => false });
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("Keepalive timer:");
    expect(res.lines.join("\n")).toContain("NOT active");
  });

  test("standalone (cluster disabled) short-circuits to not-configured", () => {
    // Point at a config with no cluster machines → clusterEnabled() false.
    const cfgPath = join(TMP, "standalone.yaml");
    writeFileSync(cfgPath, `state_repo: test/state\nstate_path: harness\n`);
    process.env.LUDICS_CONFIG = cfgPath;
    const res = clusterDoctor(ok);
    expect(res.ok).toBe(true);
    expect(res.lines.join("\n")).toContain("Cluster: not configured (standalone)");
  });
});

describe("wslPersistenceStatus / isWsl (AC 8)", () => {
  test("non-WSL → not applicable, ok", () => {
    const res = wslPersistenceStatus({ isWslOverride: false });
    expect(res).toEqual({ applicable: false, ok: true, lines: [] });
  });

  test("WSL + systemd PID 1 + linger enabled → ok", () => {
    const res = wslPersistenceStatus({ isWslOverride: true, systemdIsPid1: () => true, lingerEnabled: () => true });
    expect(res.applicable).toBe(true);
    expect(res.ok).toBe(true);
  });

  test("WSL + linger disabled → fail with remediation", () => {
    const res = wslPersistenceStatus({ isWslOverride: true, systemdIsPid1: () => true, lingerEnabled: () => false });
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("enable-linger");
  });

  test("WSL + systemd not PID 1 → fail with wsl.conf remediation", () => {
    const res = wslPersistenceStatus({ isWslOverride: true, systemdIsPid1: () => false, lingerEnabled: () => true });
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("systemd=true");
  });

  test("WSL + linger undeterminable (loginctl absent) → fail loud, not a silent pass (AC 8)", () => {
    // AC 8 requires "detect or fail loud". An undetermined linger precondition
    // must NOT pass: a timer that may not survive logout leaves the node declared
    // but dead. Mutation: flipping the null branch back to ok:true fails here.
    const res = wslPersistenceStatus({ isWslOverride: true, systemdIsPid1: () => true, lingerEnabled: () => null });
    expect(res.ok).toBe(false);
    expect(res.lines.join("\n")).toContain("cannot determine");
    expect(res.lines.join("\n")).toContain("enable-linger");
  });

  test("isWsl detects a microsoft osrelease and rejects a vanilla one", () => {
    expect(isWsl({ osrelease: "5.15.90.1-microsoft-standard-WSL2", distroEnv: "" })).toBe(true);
    expect(isWsl({ osrelease: "6.8.0-generic", distroEnv: "" })).toBe(false);
    expect(isWsl({ osrelease: "6.8.0-generic", distroEnv: "Ubuntu" })).toBe(true);
  });
});

// `ludics cluster doctor` must exit non-zero on a failed check so onboarding
// flows (setup.sh) can gate "complete" on a green result. In-process unit tests
// cover the line content; this spawns the real CLI to pin the exit code, which a
// `process.exitCode = 1` regression (or a `break` that swallows it) would flip.
describe("ludics cluster doctor exit code (AC 8/9 onboarding gate)", () => {
  const ENTRY = join(import.meta.dir, "index.ts");

  function runDoctor(env: Record<string, string>): { code: number; out: string } {
    const TMP = mkdtempSync(join(tmpdir(), "ludics-doctor-cli-"));
    try {
      const cfgPath = join(TMP, "config.yaml");
      writeFileSync(cfgPath, env.__CONFIG__ ?? CONFIG);
      const { __CONFIG__, ...rest } = env;
      const proc = spawnSync("bun", [ENTRY, "cluster", "doctor"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: TMP,
          LUDICS_HARNESS_DIR: join(TMP, "harness"),
          LUDICS_CONFIG: cfgPath,
          ...rest,
        },
      });
      return { code: proc.status ?? -1, out: (proc.stdout ?? "") + (proc.stderr ?? "") };
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  }

  test("self-identify failure (host not in cluster.machines) exits non-zero", () => {
    const { code, out } = runDoctor({ LUDICS_CLUSTER_MACHINE_NAME: "ghost-host" });
    expect(code).toBe(1);
    expect(out).toContain("Self-identify: FAILED");
  });

  test("standalone (no cluster) exits zero", () => {
    const { code, out } = runDoctor({ __CONFIG__: "state_repo: test/state\nstate_path: harness\n" });
    expect(code).toBe(0);
    expect(out).toContain("not configured");
  });
});
