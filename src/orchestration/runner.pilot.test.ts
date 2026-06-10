// Regression tests for the pilot work-phase "wait indefinitely" contract.
// Codex review of PR #562 flagged two pollUntilDone-internal paths that the
// initial pilot suppression missed: the interrupted-agent "Continue." nudge
// (runner.ts) and pollUntilDone's own deadline → handleTimeout (which
// interrupts the coder). Both must be exempted for `mode: "pilot" && phase:
// "work"`, alongside the two settled-no-signal / hung detectors.
//
// Strategy: drive runOrchestration end-to-end (the escalation tests' proven
// harness) with a recording transport and a coder whose turn is settled but
// not done — exactly the idle state a piloted coder sits in while it waits for
// the user. The work deadline is set to 0 so it is already expired on tick 1.
//   - pilot: the loop must spin past the expired deadline many times WITHOUT
//     sending any turn or interrupting; it ends only when the coder writes a
//     terminal status (here `bail-out`, which short-circuits straight to done).
//   - solo control (same setup): the deadline fires immediately → interruptAgent
//     is called. This proves the assertions would catch a regression.

import { describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { runOrchestration } from "./runner.ts";
import { defaultOrchestrationConfig } from "./state.ts";
import type { OrchestrationState } from "./state.ts";
import type { OrchestrationTransport } from "./transport.ts";
import * as events from "../events.ts";
import * as notify from "../notify.ts";
import { makeTmpDir, makeLifecycle, makeState } from "./runner.test-helpers.ts";

setDefaultTimeout(15_000);

function seedSoloHarness(slot: number): { harness: string; peerSyncDir: string } {
  const tmpDir = makeTmpDir();
  const harness = join(tmpDir, "harness");
  const peerSyncDir = join(tmpDir, "peer-sync");
  mkdirSync(join(harness, "orchestration"), { recursive: true });
  mkdirSync(join(harness, "slots"), { recursive: true });
  mkdirSync(join(harness, "journal"), { recursive: true });
  mkdirSync(join(peerSyncDir, "plans"), { recursive: true });
  mkdirSync(join(peerSyncDir, "reviews"), { recursive: true });

  // Sibling adapter state with our own PID so the runner self-guard passes.
  writeFileSync(
    join(harness, "orchestration", `tmux-slot-${slot}.json`),
    JSON.stringify({
      orchestration: { pid: process.pid, stateFile: "x", mode: "solo" },
      sessionNames: { coder: "c" },
      ttydPids: {},
    }),
  );
  writeFileSync(
    join(harness, "slots", `slot-${slot}.json`),
    JSON.stringify({
      slot, process: "test-process", task: "feat", mode: "tmux", session: null,
      path: null, started: null, adapterArgs: null, machine: null,
      sessionStarted: null, liveness: null, terminals: "", runtime: "", git: "",
    }, null, 2),
  );
  return { harness, peerSyncDir };
}

interface RecordingTransport extends OrchestrationTransport {
  sendTurnMessages: string[];
  interruptCalls: number;
  refreshCount: number;
}

// Transport that records every sendTurn/interruptAgent and, once it has been
// polled `terminateOnCall` times, writes a terminal `bail-out` status so the
// pilot loop (which otherwise waits forever) can exit cleanly. bail-out
// short-circuits solo/pilot straight to `done`, so no later phase dispatches.
function recordingTransport(peerSyncDir: string, terminateOnCall: number): RecordingTransport {
  const t: RecordingTransport = {
    sendTurnMessages: [],
    interruptCalls: 0,
    refreshCount: 0,
    async sendTurn(_state, _agent, message?: string) { t.sendTurnMessages.push(message ?? ""); return "cmd-pilot-test"; },
    async sendEnter() {},
    async refreshAgentTransportState() {
      t.refreshCount++;
      if (t.refreshCount >= terminateOnCall) {
        writeFileSync(
          join(peerSyncDir, "coder.status"),
          `bail-out|${Math.floor(Date.now() / 1000)}|task obsolete\n`,
        );
      }
    },
    async interruptAgent() { t.interruptCalls++; },
  };
  return t;
}

function makeIdleCoderState(
  mode: "pilot" | "solo",
  slot: number,
  peerSyncDir: string,
  harness: string,
): OrchestrationState {
  return makeState({
    slot,
    mode,
    backend: "tmux",
    phase: "work",
    harnessDir: harness,
    // Skip enterPhase's re-dispatch loop while still exercising pollUntilDone.
    phaseDispatched: true,
    currentPhaseToken: "phase-existing",
    // Single coder (solo/pilot shape), turn settled but no done status — the
    // exact idle state a piloted coder waits in.
    agents: [
      { name: "coder", provider: "claude-code", role: "coder", model: "opus-4", branch: "a", worktreePath: "/tmp/a" },
    ],
    agentStates: {
      coder: { status: "working", statusEpoch: 0, statusMessage: "", prUrl: null, interrupted: false, turnLifecycle: makeLifecycle({ state: "settled" }) },
    },
    // Deadline already expired (work timeout 0); fast poll so the test is quick.
    config: { ...defaultOrchestrationConfig(), pollInterval: 0.01, timeouts: { ...defaultOrchestrationConfig().timeouts, work: 0 } },
  }, peerSyncDir);
}

describe("pilot work phase — wait-indefinitely contract (PR #562 Codex P1s)", () => {
  let origHarnessDir: string | undefined;
  let origStartupGrace: string | undefined;
  let eventSpy: ReturnType<typeof spyOn>;
  let notifySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    origHarnessDir = process.env.LUDICS_HARNESS_DIR;
    origStartupGrace = process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
    process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = "0";
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
    notifySpy = spyOn(notify, "notifyOutgoing").mockImplementation(() => {});
  });

  afterEach(() => {
    if (origHarnessDir !== undefined) process.env.LUDICS_HARNESS_DIR = origHarnessDir;
    else delete process.env.LUDICS_HARNESS_DIR;
    if (origStartupGrace !== undefined) process.env.LUDICS_RUNNER_STARTUP_GRACE_MS = origStartupGrace;
    else delete process.env.LUDICS_RUNNER_STARTUP_GRACE_MS;
    eventSpy.mockRestore();
    notifySpy.mockRestore();
  });

  test("pilot: idle coder is never nudged or interrupted past the expired work deadline", async () => {
    const slot = 41;
    const { harness, peerSyncDir } = seedSoloHarness(slot);
    process.env.LUDICS_HARNESS_DIR = harness;

    const transport = recordingTransport(peerSyncDir, 5);
    await runOrchestration(makeIdleCoderState("pilot", slot, peerSyncDir, harness), transport);

    // Looped past the immediately-expired deadline several times (proof the
    // deadline did NOT terminate the loop on tick 1) ...
    expect(transport.refreshCount).toBeGreaterThanOrEqual(5);
    // ... yet never poked the coder: no interrupted-agent "Continue." nudge,
    // no settled-no-signal/hung nudge, and no handleTimeout interrupt.
    expect(transport.interruptCalls).toBe(0);
    expect(transport.sendTurnMessages.some((m) => m.includes("Continue."))).toBe(false);
    expect(transport.sendTurnMessages).toHaveLength(0);
  });

  // Non-vacuity: this suite was confirmed to FAIL when either production guard
  // is reverted — removing the `pilotIdleWait` break makes the interrupted-agent
  // nudge send a "Continue." turn, and ungating the deadline makes handleTimeout
  // raise interruptCalls. Both flip the assertions above. (A full-pipeline solo
  // control is omitted: once solo's work deadline fires it advances into
  // update-docs, which the bail-out status can't cleanly terminate here due to
  // per-phase status freshness gating.)
});
