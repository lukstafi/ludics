// Tests for triggers.ts — role-gated trigger installation (AC 7).
//
// The install functions themselves shell out to launchctl/systemctl and write
// unit files, so the behaviour is tested through the pure decision seam
// `triggerAllowedForRole` / `CONTROLLER_ONLY_TRIGGER_NAMES` that every
// controller-only call site consults. The invariant: on a worker node, every
// controller-only trigger is excluded and every worker-relevant trigger is kept;
// controllers and standalone nodes install everything.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { triggerAllowedForRole, CONTROLLER_ONLY_TRIGGER_NAMES, removeControllerTriggerUnits, shouldTeardownControllerUnits, shouldRunTeardown, isUnitDisabledInPrintOutput, plistEnvXml, magKeepaliveServiceBody } from "./triggers.ts";
import type { ClusterMachine } from "./cluster.ts";

const CONTROLLER_ONLY = ["dashboard", "ntfy-subscribe", "morning", "health", "sync", "watch"] as const;
const WORKER_RELEVANT = ["mag", "cluster", "startup", "sessions", "sessions-sweep", "t3code-cleanup"] as const;

describe("triggerAllowedForRole — worker excludes controller-only units (AC 7)", () => {
  // One assertion per named member: a single representative would let a
  // missing-member regression pass.
  for (const name of CONTROLLER_ONLY) {
    test(`worker excludes ${name}`, () => {
      expect(triggerAllowedForRole(name, "worker")).toBe(false);
    });
  }
});

describe("triggerAllowedForRole — worker keeps worker-relevant units (AC 7)", () => {
  for (const name of WORKER_RELEVANT) {
    test(`worker includes ${name}`, () => {
      expect(triggerAllowedForRole(name, "worker")).toBe(true);
    });
  }
});

describe("triggerAllowedForRole — controller and standalone install everything", () => {
  for (const name of [...CONTROLLER_ONLY, ...WORKER_RELEVANT]) {
    test(`controller includes ${name}`, () => {
      expect(triggerAllowedForRole(name, "controller")).toBe(true);
    });
    test(`standalone includes ${name}`, () => {
      expect(triggerAllowedForRole(name, "standalone")).toBe(true);
    });
  }
});

describe("CONTROLLER_ONLY_TRIGGER_NAMES — closed set", () => {
  test("contains exactly the six controller-only trigger names", () => {
    // Closed-set guard: a silent addition/removal (e.g. accidentally adding a
    // worker-relevant trigger here, which would stop a worker from installing it)
    // flips this assertion.
    expect([...CONTROLLER_ONLY_TRIGGER_NAMES].sort()).toEqual(
      [...CONTROLLER_ONLY].sort(),
    );
    expect(CONTROLLER_ONLY_TRIGGER_NAMES.size).toBe(6);
  });

  test("no worker-relevant trigger is in the controller-only set", () => {
    for (const name of WORKER_RELEVANT) {
      expect(CONTROLLER_ONLY_TRIGGER_NAMES.has(name)).toBe(false);
    }
  });
});

// PR #574 review (P2): skip-only logging doesn't stop controller units already
// installed when the node was standalone/controller. On a worker, `triggers
// install` must actively disable+delete them, or split-brain persists after an
// upgrade. removeControllerTriggerUnits is the seam triggersInstall calls for
// each CONTROLLER_ONLY_TRIGGER_NAMES entry on a worker.
describe("removeControllerTriggerUnits — removes stale controller units, keeps worker units (AC 7)", () => {
  const ORIGINAL_HOME = process.env.HOME;
  let TMP = "";
  let systemdDir = "";
  let agentsDir = "";

  function setup(): void {
    TMP = mkdtempSync(join(tmpdir(), "ludics-trig-rm-"));
    process.env.HOME = TMP;
    systemdDir = join(TMP, ".config/systemd/user");
    agentsDir = join(TMP, "Library/LaunchAgents");
    mkdirSync(systemdDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
  }
  function teardown(): void {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    rmSync(TMP, { recursive: true, force: true });
  }

  test("linux: deletes ludics-dashboard.{service,timer}, leaves worker-relevant ludics-mag.timer", () => {
    setup();
    try {
      writeFileSync(join(systemdDir, "ludics-dashboard.service"), "x");
      writeFileSync(join(systemdDir, "ludics-dashboard.timer"), "x");
      writeFileSync(join(systemdDir, "ludics-mag.timer"), "x"); // worker-relevant: must survive
      // Mirror the worker-install cleanup loop: remove every controller-only name.
      for (const name of CONTROLLER_ONLY_TRIGGER_NAMES) removeControllerTriggerUnits(name, "linux");
      // Invariant: controller units gone, worker unit kept. Mutation: dropping the
      // unlinkSync leaves dashboard.service present; including "mag" in the set
      // removes mag.timer — either flips an assertion.
      expect(existsSync(join(systemdDir, "ludics-dashboard.service"))).toBe(false);
      expect(existsSync(join(systemdDir, "ludics-dashboard.timer"))).toBe(false);
      expect(existsSync(join(systemdDir, "ludics-mag.timer"))).toBe(true);
    } finally { teardown(); }
  });

  test("linux: removes all watch-* units for the 'watch' trigger", () => {
    setup();
    try {
      writeFileSync(join(systemdDir, "ludics-watch-tasks_sync.service"), "x");
      writeFileSync(join(systemdDir, "ludics-watch-tasks_sync.path"), "x");
      removeControllerTriggerUnits("watch", "linux");
      expect(existsSync(join(systemdDir, "ludics-watch-tasks_sync.service"))).toBe(false);
      expect(existsSync(join(systemdDir, "ludics-watch-tasks_sync.path"))).toBe(false);
    } finally { teardown(); }
  });

  test("darwin: deletes com.ludics.dashboard.plist", () => {
    setup();
    try {
      writeFileSync(join(agentsDir, "com.ludics.dashboard.plist"), "x");
      writeFileSync(join(agentsDir, "com.ludics.mag.plist"), "x"); // worker-relevant
      for (const name of CONTROLLER_ONLY_TRIGGER_NAMES) removeControllerTriggerUnits(name, "darwin");
      expect(existsSync(join(agentsDir, "com.ludics.dashboard.plist"))).toBe(false);
      expect(existsSync(join(agentsDir, "com.ludics.mag.plist"))).toBe(true);
    } finally { teardown(); }
  });
});

// The destructive teardown loop above must NOT run on a transient identity miss.
// `triggersInstall` gates it on shouldTeardownControllerUnits(clusterCurrentMachine()):
// only an *identified non-leader* tears down. Unknown identity (Tailscale down +
// hostname mismatch — exactly the leader-at-home failure mode) must be left alone,
// or the leader disables its own dashboard/briefing units on a flaky resolve.
describe("shouldTeardownControllerUnits — only confidently-identified workers tear down", () => {
  const machine = (role: string): ClusterMachine => ({
    name: "n", host: "n.ts.net", os: "macos", role, always_on: true, gpu: "",
  });

  test("unknown identity (undefined) → false (the leader-safety fix)", () => {
    // Mutation guard: reverting to `clusterRole() === "worker"` would make an
    // unidentified leader tear down its own controller units — this stays false.
    expect(shouldTeardownControllerUnits(undefined)).toBe(false);
  });

  test("identified worker → true", () => {
    expect(shouldTeardownControllerUnits(machine("worker"))).toBe(true);
  });

  test("identified console (non-leader) → true", () => {
    expect(shouldTeardownControllerUnits(machine("console"))).toBe(true);
  });

  test("identified leader → false", () => {
    expect(shouldTeardownControllerUnits(machine("leader"))).toBe(false);
  });
});

// KeepAlive jobs re-resolve cluster identity on every relaunch; baking the
// install-time machine name into the plist env keeps the dashboard serving even
// while Tailscale is reconnecting (the override is honored by clusterCurrentMachine).
describe("plistEnvXml — bakes LUDICS_CLUSTER_MACHINE_NAME when resolvable", () => {
  test("includes the override key/value when a name is given", () => {
    const xml = plistEnvXml("mac-studio");
    expect(xml).toContain("<key>LUDICS_CLUSTER_MACHINE_NAME</key>");
    expect(xml).toContain("<string>mac-studio</string>");
    expect(xml).toContain("<key>PATH</key>"); // PATH still present
  });

  test("omits the override entirely when name is null (no empty/garbage env)", () => {
    const xml = plistEnvXml(null);
    expect(xml).not.toContain("LUDICS_CLUSTER_MACHINE_NAME");
    expect(xml).toContain("<key>PATH</key>");
  });
});

// gh-ludics-584: the generated worker `ludics-mag.service` must carry
// `KillMode=process` so the oneshot keepalive does NOT reap the detached
// orchestration runner via its cgroup on exit. Without this line the worker
// resume loop never advances past `setup` (the runner is SIGTERM'd each tick).
describe("magKeepaliveServiceBody — KillMode=process hardening (gh-ludics-584)", () => {
  test("emits Type=oneshot, KillMode=process, and the mag start ExecStart", () => {
    const body = magKeepaliveServiceBody("/usr/local/bin/ludics");
    // Invariant: the cgroup-reap-protection line is present (its absence is the bug).
    expect(body).toContain("KillMode=process");
    expect(body).toContain("Type=oneshot");
    expect(body).toContain("ExecStart=/usr/local/bin/ludics mag start");
  });

  test("does NOT hardcode a stale bin path (uses the passed bin)", () => {
    const body = magKeepaliveServiceBody("/opt/custom/ludics");
    expect(body).toContain("ExecStart=/opt/custom/ludics mag start");
    expect(body).not.toContain("/usr/local/bin/ludics");
  });

  // Negative control / scope guard: KillMode must be applied ONLY to the mag
  // unit — the other oneshot trigger bodies (startup, morning, health, watch)
  // intentionally have no long-lived descendants and must not gain it. The mag
  // body is the single source; a leak into another inline systemdServiceBody
  // would push this count above 1.
  test("KillMode appears in exactly one unit body in triggers.ts (mag unit only)", () => {
    const src = readFileSync(new URL("./triggers.ts", import.meta.url), "utf-8");
    // Match the template-literal form `\nKillMode=process` (an actual unit-body
    // line), not prose mentions in doc comments. A leak into another inline
    // `systemdServiceBody` template would push this above 1.
    const matches = src.match(/\\nKillMode=process/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// gh-ludics-587: controller-unit teardown is now an explicit opt-in. The pure
// `shouldRunTeardown` seam composes the operator flag with the existing
// leader-immunity guard. Routine installs (no flag) must NEVER run the
// destructive teardown loop — that was the root cause of the leader disabling its
// own dashboard on a mis-resolved `ludics init` from a plain shell.
describe("shouldRunTeardown — teardown is explicit opt-in atop leader-immunity (gh-ludics-587)", () => {
  const machine = (role: string): ClusterMachine => ({
    name: "n", host: "n.ts.net", os: "macos", role, always_on: true, gpu: "",
  });

  test("no flag → NEVER tear down, even for an identified worker", () => {
    expect(shouldRunTeardown({}, machine("worker"))).toBe(false);
    expect(shouldRunTeardown({ reconcileControllerUnits: false }, machine("worker"))).toBe(false);
  });

  test("flag set + identified worker → tear down", () => {
    expect(shouldRunTeardown({ reconcileControllerUnits: true }, machine("worker"))).toBe(true);
    expect(shouldRunTeardown({ reconcileControllerUnits: true }, machine("console"))).toBe(true);
  });

  test("flag set but leader → still false (leader-immunity guard preserved)", () => {
    expect(shouldRunTeardown({ reconcileControllerUnits: true }, machine("leader"))).toBe(false);
  });

  test("flag set but unknown identity (undefined) → false (transient-miss safety net)", () => {
    expect(shouldRunTeardown({ reconcileControllerUnits: true }, undefined)).toBe(false);
  });
});

// gh-ludics-587: self-heal parses `launchctl print-disabled gui/$uid` output to
// decide whether a controller unit needs re-enabling. The parser is the
// unit-testable seam; the surrounding reconcile shells out to launchctl.
describe("isUnitDisabledInPrintOutput — detects disabled controller labels (gh-ludics-587)", () => {
  const sample = [
    'com.apple.disabled list for <gui> {',
    '\t\t"com.ludics.dashboard" => disabled',
    '\t\t"com.ludics.mag" => enabled',
    '\t\t"com.ludics.health" => true', // launchctl historically prints true/false too
    '}',
  ].join("\n");

  test("returns true for an explicitly disabled label", () => {
    expect(isUnitDisabledInPrintOutput(sample, "com.ludics.dashboard")).toBe(true);
  });

  test("returns false for an enabled label", () => {
    expect(isUnitDisabledInPrintOutput(sample, "com.ludics.mag")).toBe(false);
  });

  test("returns false for an absent label", () => {
    expect(isUnitDisabledInPrintOutput(sample, "com.ludics.sync")).toBe(false);
  });

  test("returns false for a non-'disabled' value (e.g. 'true')", () => {
    // Fail-safe: only the literal `=> disabled` re-enables; any other token is left alone.
    expect(isUnitDisabledInPrintOutput(sample, "com.ludics.health")).toBe(false);
  });

  test("empty / garbage input → false (fail-safe)", () => {
    expect(isUnitDisabledInPrintOutput("", "com.ludics.dashboard")).toBe(false);
    expect(isUnitDisabledInPrintOutput("not launchctl output at all", "com.ludics.dashboard")).toBe(false);
    expect(isUnitDisabledInPrintOutput("\n\n   \n", "com.ludics.dashboard")).toBe(false);
  });
});
