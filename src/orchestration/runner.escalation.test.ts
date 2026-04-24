// Regression tests for `bail-out: escalate` — the agent-initiated resumable
// halt. See task-4cd94043 and docs/orchestration-patterns.md#escalation-contract.
//
// Tests drive runOrchestration with a stub transport and a pre-seeded
// `escalate` status file. The runner should: (a) emit one
// `escalation_requested` event per raising agent, (b) fire a priority-5
// notifyOutgoing, (c) flip slot-json liveness to "escalated", (d) NOT advance
// phase, and (e) return cleanly from runOrchestration.

import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { handleEscalation, runOrchestration } from "./runner.ts";
import * as events from "../events.ts";
import * as notify from "../notify.ts";
import type { OrchestrationTransport } from "./transport.ts";
import {
  makeTmpDir,
  makeLifecycle,
  makeState,
} from "./runner.test-helpers.ts";

setDefaultTimeout(15_000);

function stubTransport(): OrchestrationTransport {
  return {
    async sendTurn() { return "cmd-escalation-test"; },
    async sendEnter() {},
    async refreshAgentTransportState() {},
    async interruptAgent() {},
  };
}

function seedHarness(slot: number, backend: "tmux" | "t3code" = "tmux"): {
  harness: string;
  peerSyncDir: string;
} {
  const tmpDir = makeTmpDir();
  const harness = join(tmpDir, "harness");
  const peerSyncDir = join(tmpDir, "peer-sync");
  mkdirSync(join(harness, "orchestration"), { recursive: true });
  mkdirSync(join(harness, "slots"), { recursive: true });
  mkdirSync(join(harness, "t3code"), { recursive: true });
  mkdirSync(join(harness, "journal"), { recursive: true });
  mkdirSync(join(peerSyncDir, "plans"), { recursive: true });
  mkdirSync(join(peerSyncDir, "reviews"), { recursive: true });

  // Sibling adapter state with our own PID so the self-guard passes.
  if (backend === "tmux") {
    writeFileSync(
      join(harness, "orchestration", `tmux-slot-${slot}.json`),
      JSON.stringify({
        orchestration: { pid: process.pid, stateFile: "x", mode: "pair" },
        sessionNames: { coder: "c", reviewer: "r" },
        ttydPids: {},
      }),
    );
  } else {
    writeFileSync(
      join(harness, "t3code", `slot-${slot}.json`),
      JSON.stringify({
        orchestration: { pid: process.pid, stateFile: "x", mode: "pair" },
        threads: [],
      }),
    );
  }

  // Pre-existing slot json so writeSlotJson has a file to flip.
  writeFileSync(
    join(harness, "slots", `slot-${slot}.json`),
    JSON.stringify({
      slot,
      process: "test-process",
      task: "feat",
      mode: backend,
      session: null,
      path: null,
      started: null,
      adapterArgs: null,
      machine: null,
      sessionStarted: null,
      liveness: null,
      terminals: "",
      runtime: "",
      git: "",
    }, null, 2),
  );

  return { harness, peerSyncDir };
}

function writeStatus(peerSyncDir: string, agent: string, status: string, reason: string): void {
  writeFileSync(
    join(peerSyncDir, `${agent}.status`),
    `${status}|${Math.floor(Date.now() / 1000)}|${reason}\n`,
  );
}

describe("runner escalation halt — runOrchestration end-to-end", () => {
  let origHarnessDir: string | undefined;
  let origStartupGrace: string | undefined;

  beforeEach(() => {
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    origStartupGrace = process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "0";
  });

  afterEach(() => {
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
    if (origStartupGrace !== undefined) process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = origStartupGrace;
    else delete process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
  });

  test("coder escalation halts: event emitted, notification sent, liveness flipped, phase unchanged", async () => {
    const slot = 11;
    const { harness, peerSyncDir } = seedHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;

    writeStatus(peerSyncDir, "coder", "escalate", "reviewer keeps reversing my fix");
    writeStatus(peerSyncDir, "reviewer", "idle", "awaiting-reviewer");

    const state = makeState({
      slot,
      backend: "tmux",
      phase: "review",
      round: 2,
      // phaseDispatched + currentPhaseToken skip re-entry into enterPhase's
      // dispatch loop while still exercising the real pollUntilDone path.
      phaseDispatched: true,
      currentPhaseToken: "phase-existing",
      agentStates: {
        coder: { status: "working", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
        reviewer: { status: "idle", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
      },
    }, peerSyncDir);

    const eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    const notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});

    try {
      await runOrchestration(state, stubTransport());

      const escalationEvents = eventSpy.mock.calls
        .map((c) => c[0] as { event_type: string; agent?: string; phase?: string; reason?: string; slot?: number; task?: string })
        .filter((e) => e.event_type === "escalation_requested");
      expect(escalationEvents).toHaveLength(1);
      expect(escalationEvents[0]!.agent).toBe("coder");
      expect(escalationEvents[0]!.phase).toBe("review");
      expect(escalationEvents[0]!.reason).toBe("reviewer keeps reversing my fix");
      expect(escalationEvents[0]!.slot).toBe(slot);
      expect(escalationEvents[0]!.task).toBe(state.taskId);

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const [msg, priority, title] = notifySpy.mock.calls[0] as [string, number, string];
      expect(priority).toBe(5);
      expect(title).toContain(`slot ${slot}`);
      expect(msg).toContain(`Slot ${slot}`);
      expect(msg).toContain("coder escalated");
      expect(msg).toContain("review");
      expect(msg).toContain("reviewer keeps reversing my fix");

      const slotData = JSON.parse(readFileSync(join(harness, "slots", `slot-${slot}.json`), "utf-8"));
      expect(slotData.liveness).toBe("escalated");
      // Phase must not advance — resume should pick up exactly where we left off.
      expect(state.phase).toBe("review");
    } finally {
      eventSpy.mockRestore();
      notifySpy.mockRestore();
    }
  });

  test("empty-reason escalation logs a warning and uses '(no reason provided)'", async () => {
    const slot = 12;
    const { harness, peerSyncDir } = seedHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;

    writeStatus(peerSyncDir, "coder", "escalate", "");
    writeStatus(peerSyncDir, "reviewer", "idle", "");

    const state = makeState({
      slot,
      backend: "tmux",
      phase: "work",
      phaseDispatched: true,
      currentPhaseToken: "phase-existing",
      agentStates: {
        coder: { status: "working", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
        reviewer: { status: "idle", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
      },
    }, peerSyncDir);

    const eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    const notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await runOrchestration(state, stubTransport());

      const escalationEvents = eventSpy.mock.calls
        .map((c) => c[0] as { event_type: string; reason?: string; reason_provided?: boolean })
        .filter((e) => e.event_type === "escalation_requested");
      expect(escalationEvents).toHaveLength(1);
      expect(escalationEvents[0]!.reason).toBe("(no reason provided)");
      expect(escalationEvents[0]!.reason_provided).toBe(false);

      const [msg] = notifySpy.mock.calls[0] as [string, number, string];
      expect(msg).toContain("(no reason provided)");

      const warnings = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(warnings.some((m) => m.includes("empty reason"))).toBe(true);
    } finally {
      eventSpy.mockRestore();
      notifySpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("both agents escalating in the same tick surface both, halt fires once", async () => {
    const slot = 13;
    const { harness, peerSyncDir } = seedHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;

    writeStatus(peerSyncDir, "coder", "escalate", "coder reason");
    writeStatus(peerSyncDir, "reviewer", "escalate", "reviewer reason");

    const state = makeState({
      slot,
      backend: "tmux",
      phase: "review",
      phaseDispatched: true,
      currentPhaseToken: "phase-existing",
      agentStates: {
        coder: { status: "working", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
        reviewer: { status: "idle", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
      },
    }, peerSyncDir);

    const eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    const notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});

    try {
      await runOrchestration(state, stubTransport());

      const escalationEvents = eventSpy.mock.calls
        .map((c) => c[0] as { event_type: string; agent?: string; reason?: string })
        .filter((e) => e.event_type === "escalation_requested");
      expect(escalationEvents).toHaveLength(2);
      const byAgent = Object.fromEntries(escalationEvents.map((e) => [e.agent, e.reason]));
      expect(byAgent.coder).toBe("coder reason");
      expect(byAgent.reviewer).toBe("reviewer reason");

      // Single notification summarizing both.
      expect(notifySpy).toHaveBeenCalledTimes(1);
      const [msg, priority] = notifySpy.mock.calls[0] as [string, number, string];
      expect(priority).toBe(5);
      expect(msg).toContain("coder");
      expect(msg).toContain("reviewer");
      expect(msg).toContain("coder reason");
      expect(msg).toContain("reviewer reason");

      const slotData = JSON.parse(readFileSync(join(harness, "slots", `slot-${slot}.json`), "utf-8"));
      expect(slotData.liveness).toBe("escalated");
    } finally {
      eventSpy.mockRestore();
      notifySpy.mockRestore();
    }
  });
});

describe("handleEscalation — isolated halt helper", () => {
  let origHarnessDir: string | undefined;

  beforeEach(() => {
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
  });

  afterEach(() => {
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
  });

  test("no-op when no agent has the escalate status", () => {
    const slot = 20;
    const { harness, peerSyncDir } = seedHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;

    const state = makeState({
      slot,
      phase: "work",
      agentStates: {
        coder: { status: "done", statusEpoch: 0, statusMessage: "ok", prUrl: null, interrupted: false },
        reviewer: { status: "review-done", statusEpoch: 0, statusMessage: "ok", prUrl: null, interrupted: false },
      },
    }, peerSyncDir);

    const eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    const notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});

    try {
      handleEscalation(state);
      const escalationEvents = eventSpy.mock.calls
        .map((c) => (c[0] as { event_type: string }).event_type)
        .filter((t) => t === "escalation_requested");
      expect(escalationEvents).toHaveLength(0);
      expect(notifySpy).not.toHaveBeenCalled();

      const slotData = JSON.parse(readFileSync(join(harness, "slots", `slot-${slot}.json`), "utf-8"));
      expect(slotData.liveness).toBeNull();
    } finally {
      eventSpy.mockRestore();
      notifySpy.mockRestore();
    }
  });
});
