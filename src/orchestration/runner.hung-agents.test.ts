// Hung-agent (substantive-diff) detector — task-a670cdbf.
// Distinct from runner.settled-no-signal.test.ts: that file covers the
// renamed legacy detector (static-pane, soft nudge ladder); this file
// covers the genuinely-hung case (spinner-only churn, breakAndPrompt
// recovery → interruptAgent escalation).

import {
  describe, expect, test, beforeEach, afterEach, spyOn, setDefaultTimeout,
} from "bun:test";
import {
  mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "fs";
import { join } from "path";
import { detectAndNudgeHungAgents, substantiveDiff } from "./runner.ts";
import * as events from "../events.ts";
import {
  makeTmpDir, makeLifecycle, makeState, noopTransport,
} from "./runner.test-helpers.ts";
import type { OrchestrationTransport } from "./transport.ts";
import type { OrchestrationState } from "./state.ts";

setDefaultTimeout(20_000);

// ---------------------------------------------------------------------------
// substantiveDiff — pure-function unit tests
// ---------------------------------------------------------------------------

describe("substantiveDiff", () => {
  test("spinner-only churn: identical prefix + suffix, ~10-char tail diff → under-threshold", () => {
    // Synthetic: 1500-char prefix + (Working Nm Ns line) + 400-char suffix
    const prefix = "X".repeat(1500);
    const suffix = "Y".repeat(400);
    const prev = `${prefix}Working 1m 30s${suffix}`;
    const curr = `${prefix}Working 1m 31s${suffix}`;
    const { chars, pct } = substantiveDiff(prev, curr);
    // AC8: chars ≤ 30 AND pct < 0.05
    expect(chars).toBeLessThanOrEqual(30);
    expect(pct).toBeLessThan(0.05);
  });

  test("tool-call line: 60+ residual chars → over-threshold", () => {
    const prefix = "X".repeat(1500);
    const suffix = "Y".repeat(400);
    const prev = `${prefix}${suffix}`;
    const curr = `${prefix} • Ran shell \`bun run build\` (exit 0, 4.2s)\n  ↳ output truncated\n${suffix}`;
    const { chars } = substantiveDiff(prev, curr);
    expect(chars).toBeGreaterThan(30);
  });

  test("identical strings: chars == 0", () => {
    const s = "X".repeat(2000);
    expect(substantiveDiff(s, s)).toEqual({ chars: 0, pct: 0 });
  });

  test("totally different strings: chars == max length, pct == 1", () => {
    const a = "A".repeat(1000);
    const b = "B".repeat(1000);
    const r = substantiveDiff(a, b);
    expect(r.chars).toBe(1000);
    expect(r.pct).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectAndNudgeHungAgents — integration tests
// ---------------------------------------------------------------------------

interface CallLog {
  breakAndPrompt: Array<{ message: string }>;
  interruptAgent: number;
  sendTurn: Array<{ message: string }>;
}

function makeRecordingTransport(): { transport: OrchestrationTransport; log: CallLog } {
  const log: CallLog = { breakAndPrompt: [], interruptAgent: 0, sendTurn: [] };
  const transport: OrchestrationTransport = {
    async sendTurn(_state, _agent, message) { log.sendTurn.push({ message }); return "cmd-test"; },
    async sendEnter() {},
    async refreshAgentTransportState() {},
    async interruptAgent() { log.interruptAgent++; },
    async breakAndPrompt(_state, _agent, message) { log.breakAndPrompt.push({ message }); },
  };
  return { transport, log };
}

function makeTmuxState(opts: { phase?: OrchestrationState["phase"]; tmpDir: string }): OrchestrationState {
  const state = makeState({ phase: opts.phase ?? "work" }, opts.tmpDir);
  state.backend = "tmux";
  return state;
}

describe("detectAndNudgeHungAgents", () => {
  let tmpDir: string;
  let emitSpy: ReturnType<typeof spyOn>;
  let origHarness: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    mkdirSync(join(tmpDir, "reviews"), { recursive: true });
    origHarness = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = join(tmpDir, "harness");
    mkdirSync(process.env.LUDICS_HARNESS_DIR, { recursive: true });
    emitSpy = spyOn(events, "emitEvent");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origHarness !== undefined) process.env.LUDICS_HARNESS_DIR = origHarness;
    else delete process.env.LUDICS_HARNESS_DIR;
    emitSpy.mockRestore();
  });

  test("AC10: t3code transport — detector emits no event regardless of stall state", async () => {
    const state = makeState({ phase: "work" }, tmpDir);
    state.backend = "t3code";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      // Stall window way past threshold — would fire on tmux.
      substantiveStallSince: new Date(Date.now() - 1_300_000).toISOString(),
      substantiveStallChars: 100,
      lastPaneRaw: "spinner output",
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    const evts = emitSpy.mock.calls.map((c: unknown[]) => (c[0] as { event_type?: string }).event_type);
    expect(evts).not.toContain("agent_hung_detected");
    expect(evts).not.toContain("agent_hung_force_settle");
  });

  test("AC11: settled-no-signal layer takes priority — hung detector skips", async () => {
    const state = makeTmuxState({ tmpDir });
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1_300_000).toISOString(),
      substantiveStallChars: 100,
      // settled-no-signal claims the agent for this tick:
      settledNoSignalDetectedAt: new Date().toISOString(),
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    const evts = emitSpy.mock.calls.map((c: unknown[]) => (c[0] as { event_type?: string }).event_type);
    expect(evts).not.toContain("agent_hung_detected");
    expect(state.agentStates.coder.turnLifecycle?.hungDetectedAt).toBeNull();
  });

  test("AC12: stall just under threshold (1199 s) → no detection", async () => {
    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 1200;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1199 * 1000).toISOString(),
      substantiveStallChars: 50,
      lastPaneRaw: "spinner",
    });
    const { transport, log } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    const evts = emitSpy.mock.calls.map((c: unknown[]) => (c[0] as { event_type?: string }).event_type);
    expect(evts).not.toContain("agent_hung_detected");
    expect(log.breakAndPrompt).toHaveLength(0);
    expect(state.agentStates.coder.turnLifecycle?.hungDetectedAt).toBeNull();
  });

  test("AC12 + AC14: stall past threshold → exactly one agent_hung_detected + breakAndPrompt with composed prompt", async () => {
    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 1200;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1201 * 1000).toISOString(),
      substantiveStallChars: 250,
      lastPaneRaw: "Working 20m 1s\n• ⠋",
    });
    const { transport, log } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    const detectEvents = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type?: string }).event_type === "agent_hung_detected",
    );
    expect(detectEvents).toHaveLength(1);
    const payload = detectEvents[0]![0] as Record<string, unknown>;
    expect(payload.slot).toBe(state.slot);
    expect(payload.agent).toBe("coder");
    expect(payload.phase).toBe("work");
    expect(payload.stallSeconds).toBeGreaterThanOrEqual(1201);
    expect(payload.diffCharsAccumulated).toBe(250);
    expect(payload.paneSnapshot).toBe("Working 20m 1s\n• ⠋");

    expect(log.breakAndPrompt).toHaveLength(1);
    expect(typeof log.breakAndPrompt[0]!.message).toBe("string");
    expect(log.breakAndPrompt[0]!.message.length).toBeGreaterThan(0);

    const lc = state.agentStates.coder.turnLifecycle!;
    expect(lc.hungDetectedAt).not.toBeNull();
    expect(lc.hungNudgeAttempts).toBe(1);
  });

  test("AC15: cooldown holds — second tick within 180 s does NOT escalate", async () => {
    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 1200;
    state.config.substantiveStall.nudgeCooldownSeconds = 180;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1300 * 1000).toISOString(),
      substantiveStallChars: 250,
      lastPaneRaw: "spin",
      // Detection #1 fired 60 s ago — well within 180 s cooldown.
      hungDetectedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      hungNudgeAttempts: 1,
    });
    const { transport, log } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    expect(log.interruptAgent).toBe(0);
    const evts = emitSpy.mock.calls.map((c: unknown[]) => (c[0] as { event_type?: string }).event_type);
    expect(evts).not.toContain("agent_hung_force_settle");
    expect(state.agentStates.coder.turnLifecycle?.hungNudgeAttempts).toBe(1);
  });

  test("AC16: cooldown expired with continued stall → exactly one agent_hung_force_settle + interruptAgent", async () => {
    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 1200;
    state.config.substantiveStall.nudgeCooldownSeconds = 180;
    state.config.substantiveStall.maxNudgeAttempts = 2;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1500 * 1000).toISOString(),
      substantiveStallChars: 400,
      lastPaneRaw: "spin",
      hungDetectedAt: new Date(Date.now() - 200 * 1000).toISOString(),
      hungNudgeAttempts: 1,
    });
    const { transport } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    const forceEvents = emitSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type?: string }).event_type === "agent_hung_force_settle",
    );
    expect(forceEvents).toHaveLength(1);
    expect(state.agentStates.coder.interrupted).toBe(true);
    expect(state.agentStates.coder.turnLifecycle?.hungNudgeAttempts).toBe(2);
  });

  test("AC max attempts: hungNudgeAttempts >= max → no further action", async () => {
    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.maxNudgeAttempts = 2;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1_500_000).toISOString(),
      substantiveStallChars: 400,
      lastPaneRaw: "spin",
      hungDetectedAt: new Date(Date.now() - 600 * 1000).toISOString(),
      hungNudgeAttempts: 2, // already escalated
    });
    const { transport, log } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    expect(log.interruptAgent).toBe(0);
    expect(log.breakAndPrompt).toHaveLength(0);
  });

  test("config-driven threshold — runtime reads state.config.substantiveStall.thresholdSeconds, not constants", async () => {
    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 60; // tighten for test
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 61 * 1000).toISOString(),
      substantiveStallChars: 30,
      lastPaneRaw: "spin",
    });
    const { transport, log } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    expect(log.breakAndPrompt).toHaveLength(1); // would not fire at default 1200 s
  });

  test("interrupted agent — detector skips even with stall window past threshold", async () => {
    const state = makeTmuxState({ tmpDir });
    state.agentStates.coder.interrupted = true;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1_500_000).toISOString(),
      substantiveStallChars: 100,
    });

    await detectAndNudgeHungAgents(state, noopTransport);

    const evts = emitSpy.mock.calls.map((c: unknown[]) => (c[0] as { event_type?: string }).event_type);
    expect(evts).not.toContain("agent_hung_detected");
  });

  test("refreshAgentTransportState raw-pane capture: first-tick seeds lastPaneRaw without seeding substantiveStallSince", async () => {
    // AC: "In transport-tmux.ts:refreshAgentTransportState, capture the
    // raw pane and feed it into the per-agent lifecycle." First-tick
    // invariant: lastPaneRaw was null → after refresh it equals the
    // captured 50-line pane AND substantiveStallSince stays null
    // (no diff to evaluate yet). Mutation-test: removing the
    // `lc.lastPaneRaw == null` branch in transport-tmux.ts breaks
    // this assertion (substantiveStallSince would seed prematurely).
    const tmuxAdapter = await import("../adapters/tmux.ts");
    const { TmuxTransport } = await import("./transport-tmux.ts");

    const state = makeTmuxState({ tmpDir });
    state.harnessDir = process.env.LUDICS_HARNESS_DIR;
    const FIRST_PANE = "❯ session prompt\n  echo hello\n";
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      lastPaneRaw: null,
      lastPaneHash: null,
      substantiveStallSince: null,
    });

    const captureSpy = spyOn(tmuxAdapter, "tmuxCapture").mockReturnValue(FIRST_PANE);
    const peerSync = await import("./peer-sync.ts");
    const stopHookSpy = spyOn(peerSync, "readStopHookRecord").mockReturnValue(null);
    const tmuxAdapterMod = await import("../adapters/tmux-adapter.ts");
    const aliveSpy = spyOn(tmuxAdapterMod, "isAgentAlive").mockReturnValue(true);

    try {
      const transport = new TmuxTransport();
      await transport.refreshAgentTransportState(state);

      const lc = state.agentStates.coder.turnLifecycle!;
      expect(lc.lastPaneRaw).toBe(FIRST_PANE); // raw-pane fed into lifecycle
      expect(lc.substantiveStallSince).toBeNull(); // no diff yet on first tick
      expect(lc.substantiveStallChars).toBe(0);
    } finally {
      captureSpy.mockRestore();
      stopHookSpy.mockRestore();
      aliveSpy.mockRestore();
    }
  });

  test("refreshAgentTransportState raw-pane capture: under-threshold diff seeds substantiveStallSince and refreshes lastPaneRaw", async () => {
    // AC continues: under-threshold diff between successive captures
    // must seed `substantiveStallSince` (it was null) AND refresh
    // `lastPaneRaw` to the new capture (per the proposal: "also update
    // lastPaneRaw to current — otherwise a slow-but-genuine diff would
    // accumulate below threshold tick-by-tick and never register").
    // Mutation-test: dropping the `lc.lastPaneRaw = rawCapture;`
    // assignment in the under-threshold branch breaks the second
    // assertion; dropping the `??=` for substantiveStallSince breaks
    // the first.
    const tmuxAdapter = await import("../adapters/tmux.ts");
    const { TmuxTransport } = await import("./transport-tmux.ts");

    const state = makeTmuxState({ tmpDir });
    state.harnessDir = process.env.LUDICS_HARNESS_DIR;
    state.config.substantiveStall.minChars = 30;
    state.config.substantiveStall.minPct = 0.05;

    const PRIOR_PANE = "X".repeat(1500) + "Working 1m 30s" + "Y".repeat(400);
    const NEXT_SPINNER = "X".repeat(1500) + "Working 1m 31s" + "Y".repeat(400);
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      lastPaneRaw: PRIOR_PANE,
      lastPaneHash: "prior-hash",
      substantiveStallSince: null,
      substantiveStallChars: 0,
    });

    const captureSpy = spyOn(tmuxAdapter, "tmuxCapture").mockReturnValue(NEXT_SPINNER);
    const peerSync = await import("./peer-sync.ts");
    const stopHookSpy = spyOn(peerSync, "readStopHookRecord").mockReturnValue(null);
    const tmuxAdapterMod = await import("../adapters/tmux-adapter.ts");
    const aliveSpy = spyOn(tmuxAdapterMod, "isAgentAlive").mockReturnValue(true);

    try {
      const transport = new TmuxTransport();
      await transport.refreshAgentTransportState(state);

      const lc = state.agentStates.coder.turnLifecycle!;
      // Under-threshold path: stall window now seeded.
      expect(lc.substantiveStallSince).not.toBeNull();
      // lastPaneRaw refreshed to current capture (not stuck at prior).
      expect(lc.lastPaneRaw).toBe(NEXT_SPINNER);
      // Cumulative residual chars accumulated for the event payload.
      expect(lc.substantiveStallChars).toBeGreaterThan(0);
    } finally {
      captureSpy.mockRestore();
      stopHookSpy.mockRestore();
      aliveSpy.mockRestore();
    }
  });

  test("AC17 substantive-clear post-detection: substantive diff after breakAndPrompt clears hung lifecycle AND blocks escalation", async () => {
    // Two-phase test. Phase 1: hung detection #1 fires (within cooldown).
    // Phase 2: pane produces substantive output. The transport-tmux
    // substantive-diff branch clears hungDetectedAt /
    // substantiveStallSince / substantiveStallChars / hungNudgeAttempts.
    // A subsequent detector pass past cooldown must NOT escalate
    // (no agent_hung_force_settle event, interruptAgent not called)
    // and the lifecycle must be back to a clean post-recovery state.

    const tmuxAdapter = await import("../adapters/tmux.ts");
    const { TmuxTransport } = await import("./transport-tmux.ts");

    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 1200;
    state.config.substantiveStall.nudgeCooldownSeconds = 180;
    state.config.substantiveStall.maxNudgeAttempts = 2;
    state.harnessDir = process.env.LUDICS_HARNESS_DIR;

    // Phase 1: post-detection state — hungDetectedAt set 60 s ago,
    // substantive-stall window past 20 min, breakAndPrompt already issued.
    const PRIOR_PANE = "Working 20m 5s\n• ⠋"; // spinner-only chrome
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1300 * 1000).toISOString(),
      substantiveStallChars: 250,
      lastPaneRaw: PRIOR_PANE,
      lastPaneHash: "abc123",
      hungDetectedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      hungNudgeAttempts: 1,
      // Pin the dispatch+phaseToken so refreshAgentTransportState
      // doesn't try to advance lifecycle state.
      dispatchedAt: new Date(Date.now() - 1500 * 1000).toISOString(),
      turnStartedAt: new Date(Date.now() - 1400 * 1000).toISOString(),
    });

    // Phase 2: mock tmuxCapture to return a *substantive* diff —
    // a tool-call line ≫ minChars (30) over the prior pane.
    const SUBSTANTIVE_PANE = `${PRIOR_PANE}\n • Ran shell \`bun run build\` (exit 0, 4.2s)\n  ↳ output truncated\nRan tests: ok\n`;
    const captureSpy = spyOn(tmuxAdapter, "tmuxCapture").mockReturnValue(SUBSTANTIVE_PANE);
    // Stub readStopHookRecord (peer-sync) so the lifecycle isn't
    // forcibly settled by an unrelated stop-hook record.
    const peerSync = await import("./peer-sync.ts");
    const stopHookSpy = spyOn(peerSync, "readStopHookRecord").mockReturnValue(null);
    // Stub isAgentAlive (avoids spawning pgrep).
    const tmuxAdapterMod = await import("../adapters/tmux-adapter.ts");
    const aliveSpy = spyOn(tmuxAdapterMod, "isAgentAlive").mockReturnValue(true);

    try {
      // Run the transport refresh — this triggers substantive-diff branch.
      const transport = new TmuxTransport();
      await transport.refreshAgentTransportState(state);

      const lcAfterRefresh = state.agentStates.coder.turnLifecycle!;
      // Substantive-clear invariant — every field reset.
      expect(lcAfterRefresh.hungDetectedAt).toBeNull();
      expect(lcAfterRefresh.substantiveStallSince).toBeNull();
      expect(lcAfterRefresh.substantiveStallChars).toBe(0);
      expect(lcAfterRefresh.hungNudgeAttempts).toBe(0);
      // lastPaneRaw advanced to the new substantive capture.
      expect(lcAfterRefresh.lastPaneRaw).toBe(SUBSTANTIVE_PANE);

      // Now, fast-forward past cooldown (simulate by clearing the
      // earlier emit calls so we count only post-clear events) and
      // run the detector. With cleared lifecycle, the detector must
      // NOT emit force_settle and must NOT call interruptAgent.
      emitSpy.mock.calls.length = 0; // drop refresh-emit history
      const { transport: recordingTransport, log } = makeRecordingTransport();
      await detectAndNudgeHungAgents(state, recordingTransport);

      const evts = emitSpy.mock.calls.map(
        (c: unknown[]) => (c[0] as { event_type?: string }).event_type,
      );
      expect(evts).not.toContain("agent_hung_force_settle");
      expect(evts).not.toContain("agent_hung_detected");
      expect(log.interruptAgent).toBe(0);
      expect(log.breakAndPrompt).toHaveLength(0);
    } finally {
      captureSpy.mockRestore();
      stopHookSpy.mockRestore();
      aliveSpy.mockRestore();
    }
  });

  test("AC21: hung-incident JSON file written with required fields and FIFO-pruned to 50", async () => {
    const incidentsDir = join(process.env.LUDICS_HARNESS_DIR!, "mag", "hung-incidents");
    // Pre-seed 50 older incidents directly so this single detection is the 51st.
    mkdirSync(incidentsDir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      // Older ISO: 2020-01-01TXX-XX-XX (lexicographic min vs detection's 2026+)
      const iso = `2020-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}-${String(i % 60).padStart(2, "0")}-00.000Z`;
      writeFileSync(join(incidentsDir, `${iso}-slot1-coder.json`), "{}");
    }
    const beforeCount = readdirSync(incidentsDir).length;
    expect(beforeCount).toBe(50);

    const state = makeTmuxState({ tmpDir });
    state.config.substantiveStall.thresholdSeconds = 1200;
    state.agentStates.coder.turnLifecycle = makeLifecycle({
      state: "running",
      substantiveStallSince: new Date(Date.now() - 1300 * 1000).toISOString(),
      substantiveStallChars: 75,
      lastPaneRaw: "Working stuck spinner",
    });
    state.harnessDir = process.env.LUDICS_HARNESS_DIR;
    const { transport } = makeRecordingTransport();

    await detectAndNudgeHungAgents(state, transport);

    const after = readdirSync(incidentsDir).filter((f) => f.endsWith(".json")).sort();
    // FIFO cap: still ≤ 50 after the 51st write.
    expect(after.length).toBeLessThanOrEqual(50);
    // Newest write is present (ISO 2026+ sorts after the 2020 seeds).
    const newest = after[after.length - 1]!;
    expect(newest).toMatch(/^2[0-9]{3}-.*-slot1-coder\.json$/);
    expect(newest).not.toMatch(/^2020-/);

    // Required-fields probe: parse the newest record and assert presence.
    const raw = readFileSync(join(incidentsDir, newest), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const k of [
      "detectedAt", "slot", "agent", "phase", "round",
      "stallSeconds", "diffCharsAccumulated", "paneSnapshot", "promptSent",
    ]) {
      expect(k in parsed).toBe(true);
    }
    expect(parsed.slot).toBe(1);
    expect(parsed.agent).toBe("coder");
    expect(parsed.paneSnapshot).toBe("Working stuck spinner");
    expect(parsed.diffCharsAccumulated).toBe(75);
  });
});
