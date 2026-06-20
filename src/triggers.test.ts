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
import { triggerAllowedForRole, CONTROLLER_ONLY_TRIGGER_NAMES, removeControllerTriggerUnits } from "./triggers.ts";

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
