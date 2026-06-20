// Tests for triggers.ts — role-gated trigger installation (AC 7).
//
// The install functions themselves shell out to launchctl/systemctl and write
// unit files, so the behaviour is tested through the pure decision seam
// `triggerAllowedForRole` / `CONTROLLER_ONLY_TRIGGER_NAMES` that every
// controller-only call site consults. The invariant: on a worker node, every
// controller-only trigger is excluded and every worker-relevant trigger is kept;
// controllers and standalone nodes install everything.

import { describe, test, expect } from "bun:test";
import { triggerAllowedForRole, CONTROLLER_ONLY_TRIGGER_NAMES } from "./triggers.ts";

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
