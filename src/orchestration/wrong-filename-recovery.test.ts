import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as eventsMod from "../events.ts";
import { mergedPlanFilePath } from "./plan-files.ts";
import { defaultOrchestrationConfig, initAgentRuntimeState, type OrchestrationState } from "./state.ts";
import type { OrchestrationTransport } from "./transport.ts";
import {
  attemptAutoCp,
  isRecoveryEligiblePhase,
  recoverWrongFilename,
  recoveryRecentlyActed,
  scanRecentlyModified,
  whitelistSuspects,
} from "./wrong-filename-recovery.ts";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TEST_TMP = "";

beforeEach(() => {
  TEST_TMP = mkdtempSync(join(tmpdir(), "ludics-wfr-test-"));
  process.env.HOME = TEST_TMP;
  const configDir = join(TEST_TMP, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), `state_repo: test/ludics-state\nstate_path: harness\n`);
  process.env.LUDICS_CONFIG = join(configDir, "config.yaml");
  process.env.LUDICS_HARNESS_DIR = join(TEST_TMP, "harness");
  mkdirSync(join(TEST_TMP, "harness"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
});

function makePeerSync(): string {
  const dir = mkdtempSync(join(tmpdir(), "ludics-wfr-peer-"));
  mkdirSync(join(dir, "plans"), { recursive: true });
  mkdirSync(join(dir, "reviews"), { recursive: true });
  return dir;
}

function makeState(peerSyncDir: string, overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  const phaseStartedAt = Math.floor(Date.now() / 1000) - 60;
  return {
    slot: 1,
    taskId: "task-3a29f3fb",
    mode: "pair",
    phase: "plan-merge",
    round: 1,
    mergeRound: 0,
    planMergeRound: 0,
    agents: [
      { name: "coder", provider: "claude-code", role: "coder", model: "opus", branch: "a", worktreePath: "/tmp/a" },
      { name: "reviewer", provider: "codex", role: "reviewer", model: "gpt-5", branch: "b", worktreePath: "/tmp/b" },
    ],
    agentStates: initAgentRuntimeState(["coder", "reviewer"]),
    config: defaultOrchestrationConfig(),
    phaseStartedAt,
    startedAt: "2026-04-30T00:00:00Z",
    projectDir: "/tmp/project",
    rootWorktree: "/tmp/project-feat",
    peerSyncDir,
    threadIds: { coder: "t1", reviewer: "t2" },
    ...overrides,
  };
}

function makeMockTransport(): { transport: OrchestrationTransport; calls: Array<{ agent: string; message: string }> } {
  const calls: Array<{ agent: string; message: string }> = [];
  const transport: OrchestrationTransport = {
    async sendTurn(_state, agent, message) { calls.push({ agent: agent.name, message }); return "cmd-mock"; },
    async sendEnter() {},
    async refreshAgentTransportState() {},
    async interruptAgent() {},
  };
  return { transport, calls };
}

function writeFile(path: string, content: string, mtimeSec?: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (mtimeSec !== undefined) {
    const t = new Date(mtimeSec * 1000);
    utimesSync(path, t, t);
  }
}

function setSettledLifecycle(state: OrchestrationState, agent: string) {
  state.agentStates[agent].turnLifecycle = {
    dispatchCommandId: "cmd-test",
    dispatchedAt: new Date().toISOString(),
    phaseToken: "phase-test",
    observedTurnId: "turn-1",
    state: "settled",
    turnStartedAt: new Date().toISOString(),
    turnCompletedAt: new Date().toISOString(),
    completionSource: "snapshot",
    statusFileFingerprint: null,
    lastStopHookAt: null,
    nudgeAttempts: 0,
    lastNudgeAt: null,
  };
}

describe("isRecoveryEligiblePhase", () => {
  test("eligible: plan, plan-merge, plan-review, review", () => {
    expect(isRecoveryEligiblePhase("plan")).toBe(true);
    expect(isRecoveryEligiblePhase("plan-merge")).toBe(true);
    expect(isRecoveryEligiblePhase("plan-review")).toBe(true);
    expect(isRecoveryEligiblePhase("review")).toBe(true);
  });
  test("ineligible: work, pr-create, merge-amend, etc.", () => {
    expect(isRecoveryEligiblePhase("work")).toBe(false);
    expect(isRecoveryEligiblePhase("pr-create")).toBe(false);
    expect(isRecoveryEligiblePhase("merge-amend")).toBe(false);
    expect(isRecoveryEligiblePhase("merge-execute")).toBe(false);
    expect(isRecoveryEligiblePhase("setup")).toBe(false);
    expect(isRecoveryEligiblePhase("done")).toBe(false);
  });
});

describe("whitelistSuspects (plan-merge)", () => {
  test("includes round-R-coder.md (clobber smell)", () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    writeFile(join(dir, "plans", "round-1-coder.md"), "x");
    const out = whitelistSuspects(state, state.agents[0]);
    expect(out).toContain(join(dir, "plans", "round-1-coder.md"));
  });

  test("includes round-R-merge.md and round-R-merged.md (singular-name fallthrough via PLAN_RE)", () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    writeFile(join(dir, "plans", "round-1-merge.md"), "x");
    writeFile(join(dir, "plans", "round-1-merged.md"), "y");
    const out = whitelistSuspects(state, state.agents[0]);
    expect(out).toContain(join(dir, "plans", "round-1-merge.md"));
    expect(out).toContain(join(dir, "plans", "round-1-merged.md"));
  });

  test("includes round-R-merged-(K-1).md and round-R-merged-(K+1).md (off-by-one / skip-counter)", () => {
    const dir = makePeerSync();
    const state = makeState(dir, { planMergeRound: 1 });
    writeFile(join(dir, "plans", "round-1-merged-0.md"), "x");
    writeFile(join(dir, "plans", "round-1-merged-2.md"), "y");
    const out = whitelistSuspects(state, state.agents[0]);
    expect(out).toContain(join(dir, "plans", "round-1-merged-0.md"));
    expect(out).toContain(join(dir, "plans", "round-1-merged-2.md"));
  });

  test("excludes the canonical merged-K.md", () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    const canonical = mergedPlanFilePath(dir, 1, 0);
    writeFile(canonical, "x");
    const out = whitelistSuspects(state, state.agents[0]);
    expect(out).not.toContain(canonical);
  });

  test("excludes cross-round files", () => {
    const dir = makePeerSync();
    const state = makeState(dir, { round: 2, planMergeRound: 0 });
    writeFile(join(dir, "plans", "round-1-coder.md"), "x");
    const out = whitelistSuspects(state, state.agents[0]);
    expect(out).not.toContain(join(dir, "plans", "round-1-coder.md"));
  });

  test("excludes files in reviews/", () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    writeFile(join(dir, "reviews", "round-1-reviewer.md"), "x");
    const out = whitelistSuspects(state, state.agents[0]);
    // Whitelist scans plans/ only — the reviews/ directory is the nudge
    // branch's territory.
    expect(out.find((p) => p.includes("/reviews/"))).toBeUndefined();
  });

  test("returns [] for non-plan-merge phases", () => {
    const dir = makePeerSync();
    for (const phase of ["plan", "plan-review", "review"] as const) {
      const state = makeState(dir, { phase });
      expect(whitelistSuspects(state, state.agents[0])).toEqual([]);
    }
  });
});

describe("scanRecentlyModified", () => {
  test("filters by mtime threshold and excludes canonical", () => {
    const dir = makePeerSync();
    const phaseStartedAt = 1_000_000;
    const canonical = join(dir, "plans", "round-1-merged-0.md");
    writeFile(join(dir, "plans", "fresh.md"), "x", phaseStartedAt + 10);
    writeFile(join(dir, "plans", "stale.md"), "x", phaseStartedAt - 10);
    writeFile(canonical, "x", phaseStartedAt + 5);
    const out = scanRecentlyModified(dir, phaseStartedAt, canonical);
    const paths = out.map((c) => c.path);
    expect(paths).toContain(join(dir, "plans", "fresh.md"));
    expect(paths).not.toContain(join(dir, "plans", "stale.md"));
    expect(paths).not.toContain(canonical);
  });

  test("unions plans/ and reviews/", () => {
    const dir = makePeerSync();
    const phaseStartedAt = 1_000_000;
    writeFile(join(dir, "plans", "p.md"), "x", phaseStartedAt + 10);
    writeFile(join(dir, "reviews", "r.md"), "x", phaseStartedAt + 20);
    const out = scanRecentlyModified(dir, phaseStartedAt, "/nonexistent");
    const paths = out.map((c) => c.path);
    expect(paths).toContain(join(dir, "plans", "p.md"));
    expect(paths).toContain(join(dir, "reviews", "r.md"));
  });

  test("sorts descending by mtime, caps at 5", () => {
    const dir = makePeerSync();
    const phaseStartedAt = 1_000_000;
    for (let i = 0; i < 7; i++) {
      writeFile(join(dir, "plans", `f${i}.md`), "x", phaseStartedAt + i * 10);
    }
    const out = scanRecentlyModified(dir, phaseStartedAt, "/none");
    expect(out.length).toBe(5);
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].mtime).toBeGreaterThanOrEqual(out[i + 1].mtime);
    }
  });

  test("missing directories treated as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ludics-wfr-empty-"));
    const out = scanRecentlyModified(dir, 0, "/none");
    expect(out).toEqual([]);
  });
});

describe("attemptAutoCp", () => {
  test("preserves source mtime and copies content atomically", () => {
    const dir = makePeerSync();
    const src = join(dir, "plans", "src.md");
    const dst = join(dir, "plans", "dst.md");
    const fixedMtime = 1_700_000_000;
    writeFile(src, "hello", fixedMtime);
    expect(attemptAutoCp(src, dst)).toBe(true);
    expect(readFileSync(dst, "utf8")).toBe("hello");
    expect(Math.floor(statSync(dst).mtimeMs / 1000)).toBe(fixedMtime);
  });

  test("returns false on missing source", () => {
    const dir = makePeerSync();
    const dst = join(dir, "plans", "dst.md");
    expect(attemptAutoCp(join(dir, "plans", "missing.md"), dst)).toBe(false);
  });
});

describe("recoverWrongFilename — driver outcomes", () => {
  test("(a) canonical present → none, no events, no sendTurn, nudgeAttempts unchanged", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    writeFile(mergedPlanFilePath(dir, 1, 0), "merged");
    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("none");
      expect(calls).toEqual([]);
      expect(eventSpy).not.toHaveBeenCalled();
      expect(state.agentStates["coder"].turnLifecycle?.nudgeAttempts).toBe(0);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(b) canonical missing + no in-phase mods → none", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("none");
      expect(calls).toEqual([]);
      expect(eventSpy).not.toHaveBeenCalled();
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(c) whitelisted suspect in-phase → cp, recovered event, no sendTurn, mtime preserved", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const suspect = join(dir, "plans", "round-1-coder.md");
    const fixedMtime = state.phaseStartedAt + 30;
    writeFile(suspect, "merged-content", fixedMtime);

    const { transport, calls } = makeMockTransport();
    const events: Array<Record<string, unknown>> = [];
    const eventSpy = spyOn(eventsMod, "emitEvent").mockImplementation((e) => { events.push(e as Record<string, unknown>); });
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("cp");
      expect(calls).toEqual([]);
      const canonical = mergedPlanFilePath(dir, 1, 0);
      expect(existsSync(canonical)).toBe(true);
      expect(readFileSync(canonical, "utf8")).toBe("merged-content");
      expect(Math.floor(statSync(canonical).mtimeMs / 1000)).toBe(fixedMtime);
      expect(events.find((e) => e.event_type === "orchestration_artifact_recovered")).toBeTruthy();
      expect(state.agentStates["coder"].turnLifecycle?.nudgeAttempts).toBe(0);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(d) non-whitelisted in-phase mod in plans/ → nudge, sendTurn called, sentinels set", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    // A non-parsing junk-named file (whitespace makes it non-canonical)
    const junk = join(dir, "plans", "scratch.md");
    writeFile(junk, "scratch", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const events: Array<Record<string, unknown>> = [];
    const eventSpy = spyOn(eventsMod, "emitEvent").mockImplementation((e) => { events.push(e as Record<string, unknown>); });
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("nudge");
      expect(calls.length).toBe(1);
      expect(calls[0].agent).toBe("coder");
      expect(calls[0].message).toContain(junk);
      expect(calls[0].message).toContain(mergedPlanFilePath(dir, 1, 0));
      const nudgeEv = events.find((e) => e.event_type === "orchestration_wrong_filename_nudge");
      expect(nudgeEv).toBeTruthy();
      expect((nudgeEv as { candidatePaths: string[] }).candidatePaths).toContain(junk);
      const lc = state.agentStates["coder"].turnLifecycle!;
      expect(lc.nudgeAttempts).toBe(1);
      expect(lc.wrongFilenameNudgeRound).toBe(1);
      expect(lc.wrongFilenameNudgePlanMergeRound).toBe(0);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(e) cross-directory mod in reviews/ → nudge body lists the cross-dir file", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const crossDir = join(dir, "reviews", "stray.md");
    writeFile(crossDir, "x", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("nudge");
      expect(calls.length).toBe(1);
      expect(calls[0].message).toContain(crossDir);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(f) whitelisted suspect with mtime < phaseStartedAt → none, no copy, no nudge", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const suspect = join(dir, "plans", "round-1-coder.md");
    writeFile(suspect, "stale", state.phaseStartedAt - 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("none");
      expect(calls).toEqual([]);
      expect(existsSync(mergedPlanFilePath(dir, 1, 0))).toBe(false);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(g) autoRecoverWrongFilename:false + whitelisted suspect in-phase → nudge instead of cp", async () => {
    const dir = makePeerSync();
    const state = makeState(dir, {
      config: defaultOrchestrationConfig({ autoRecoverWrongFilename: false }),
    });
    setSettledLifecycle(state, "coder");
    const suspect = join(dir, "plans", "round-1-coder.md");
    writeFile(suspect, "x", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("nudge");
      expect(calls.length).toBe(1);
      expect(existsSync(mergedPlanFilePath(dir, 1, 0))).toBe(false);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(h) round R nudge already sent, R+1 missing canonical → nudge fires again", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const lc = state.agentStates["coder"].turnLifecycle!;
    lc.wrongFilenameNudgeRound = 1;
    lc.wrongFilenameNudgePlanMergeRound = 0;
    lc.nudgeAttempts = 1;

    state.round = 2;
    // Non-parsing filename so the auto-cp branch finds nothing and we
    // genuinely exercise the nudge path.
    const junk = join(dir, "plans", "scratch.md");
    writeFile(junk, "x", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("nudge");
      expect(calls.length).toBe(1);
      expect(lc.wrongFilenameNudgeRound).toBe(2);
      expect(lc.nudgeAttempts).toBe(2);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(i) deferred when lc.state === running; nudge fires after flipping to settled", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const lc = state.agentStates["coder"].turnLifecycle!;
    lc.state = "running";

    const junk = join(dir, "plans", "scratch.md");
    writeFile(junk, "x", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      let outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("deferred");
      expect(calls).toEqual([]);
      expect(lc.nudgeAttempts).toBe(0);
      expect(lc.wrongFilenameNudgeRound).toBeUndefined();

      lc.state = "settled";
      outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("nudge");
      expect(calls.length).toBe(1);
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(j) singular-name auto-cp: round-R-merged.md in-phase → cp", async () => {
    for (const fname of ["round-1-merged.md", "round-1-merge.md"]) {
      const dir = makePeerSync();
      const state = makeState(dir);
      setSettledLifecycle(state, "coder");
      const suspect = join(dir, "plans", fname);
      writeFile(suspect, `body-of-${fname}`, state.phaseStartedAt + 30);
      const { transport, calls } = makeMockTransport();
      const eventSpy = spyOn(eventsMod, "emitEvent");
      try {
        const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
        expect(outcome).toBe("cp");
        expect(calls).toEqual([]);
        const canonical = mergedPlanFilePath(dir, 1, 0);
        expect(readFileSync(canonical, "utf8")).toBe(`body-of-${fname}`);
      } finally {
        eventSpy.mockRestore();
      }
    }
  });

  test("(k) skip-counter: canonical merged-K missing, suspect merged-(K+1) present → cp", async () => {
    const dir = makePeerSync();
    const state = makeState(dir, { planMergeRound: 0 });
    setSettledLifecycle(state, "coder");
    const suspect = join(dir, "plans", "round-1-merged-1.md");
    writeFile(suspect, "skip-counter-body", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("cp");
      expect(calls).toEqual([]);
      expect(readFileSync(mergedPlanFilePath(dir, 1, 0), "utf8")).toBe("skip-counter-body");
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(l) two qualifying whitelisted suspects → most-recently-modified wins", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const older = join(dir, "plans", "round-1-coder.md");
    const newer = join(dir, "plans", "round-1-merge.md");
    writeFile(older, "older-body", state.phaseStartedAt + 10);
    writeFile(newer, "newer-body", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const eventSpy = spyOn(eventsMod, "emitEvent");
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("cp");
      expect(calls).toEqual([]);
      expect(readFileSync(mergedPlanFilePath(dir, 1, 0), "utf8")).toBe("newer-body");
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("(m) lc.state === error → diagnostic-only, no sendTurn, sentinels untouched", async () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const lc = state.agentStates["coder"].turnLifecycle!;
    lc.state = "error";

    const junk = join(dir, "plans", "scratch.md");
    writeFile(junk, "x", state.phaseStartedAt + 30);

    const { transport, calls } = makeMockTransport();
    const events: Array<Record<string, unknown>> = [];
    const eventSpy = spyOn(eventsMod, "emitEvent").mockImplementation((e) => { events.push(e as Record<string, unknown>); });
    try {
      const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
      expect(outcome).toBe("diagnostic-only");
      expect(calls).toEqual([]);
      expect(events.find((e) => e.event_type === "orchestration_artifact_recovery_skipped")).toBeTruthy();
      expect(lc.nudgeAttempts).toBe(0);
      expect(lc.wrongFilenameNudgeRound).toBeUndefined();
    } finally {
      eventSpy.mockRestore();
    }
  });

  test("non-eligible phase → none (work, merge-amend)", async () => {
    const dir = makePeerSync();
    for (const phase of ["work", "merge-amend"] as const) {
      const state = makeState(dir, { phase });
      setSettledLifecycle(state, "coder");
      const { transport, calls } = makeMockTransport();
      const eventSpy = spyOn(eventsMod, "emitEvent");
      try {
        const outcome = await recoverWrongFilename(state, state.agents[0], state.agentStates["coder"], transport);
        expect(outcome).toBe("none");
        expect(calls).toEqual([]);
      } finally {
        eventSpy.mockRestore();
      }
    }
  });
});

describe("recoveryRecentlyActed", () => {
  test("false when turnLifecycle is undefined", () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    const runtime = state.agentStates["coder"];
    runtime.turnLifecycle = null;
    expect(recoveryRecentlyActed(state, state.agents[0], runtime)).toBe(false);
  });

  test("true when sentinels match state.round and planMergeRound", () => {
    const dir = makePeerSync();
    const state = makeState(dir, { planMergeRound: 0 });
    setSettledLifecycle(state, "coder");
    const runtime = state.agentStates["coder"];
    runtime.turnLifecycle!.wrongFilenameNudgeRound = 1;
    runtime.turnLifecycle!.wrongFilenameNudgePlanMergeRound = 0;
    expect(recoveryRecentlyActed(state, state.agents[0], runtime)).toBe(true);
  });

  test("false when round mismatches", () => {
    const dir = makePeerSync();
    const state = makeState(dir);
    setSettledLifecycle(state, "coder");
    const runtime = state.agentStates["coder"];
    runtime.turnLifecycle!.wrongFilenameNudgeRound = 99;
    runtime.turnLifecycle!.wrongFilenameNudgePlanMergeRound = 0;
    expect(recoveryRecentlyActed(state, state.agents[0], runtime)).toBe(false);
  });

  test("false when planMergeRound mismatches", () => {
    const dir = makePeerSync();
    const state = makeState(dir, { planMergeRound: 1 });
    setSettledLifecycle(state, "coder");
    const runtime = state.agentStates["coder"];
    runtime.turnLifecycle!.wrongFilenameNudgeRound = 1;
    runtime.turnLifecycle!.wrongFilenameNudgePlanMergeRound = 0;
    expect(recoveryRecentlyActed(state, state.agents[0], runtime)).toBe(false);
  });

  test("normalizes state.planMergeRound undefined to -1 (matches sentinel -1)", () => {
    const dir = makePeerSync();
    const state = makeState(dir, { planMergeRound: undefined });
    setSettledLifecycle(state, "coder");
    const runtime = state.agentStates["coder"];
    runtime.turnLifecycle!.wrongFilenameNudgeRound = 1;
    runtime.turnLifecycle!.wrongFilenameNudgePlanMergeRound = -1;
    expect(recoveryRecentlyActed(state, state.agents[0], runtime)).toBe(true);
  });
});

describe("OrchestrationConfig + AgentTurnLifecycle round-trip", () => {
  test("defaultOrchestrationConfig has autoRecoverWrongFilename = true", () => {
    expect(defaultOrchestrationConfig().autoRecoverWrongFilename).toBe(true);
  });

  test("override flips the default", () => {
    expect(defaultOrchestrationConfig({ autoRecoverWrongFilename: false })
      .autoRecoverWrongFilename).toBe(false);
  });

  test("migrateState fills autoRecoverWrongFilename for legacy persisted state (true default)", async () => {
    const { migrateState } = await import("./state.ts");
    const legacy = {
      slot: 1,
      taskId: "t",
      mode: "pair",
      phase: "work",
      round: 1,
      mergeRound: 0,
      agents: [],
      agentStates: {},
      // Legacy config: no autoRecoverWrongFilename field.
      config: { ...defaultOrchestrationConfig() } as unknown as Record<string, unknown>,
      phaseStartedAt: 0,
      startedAt: "x",
      projectDir: "/",
      rootWorktree: "/",
      peerSyncDir: "/",
      threadIds: {},
    } as unknown as OrchestrationState;
    delete (legacy.config as unknown as Record<string, unknown>).autoRecoverWrongFilename;
    const migrated = migrateState(legacy, 1);
    expect(migrated.config.autoRecoverWrongFilename).toBe(true);
  });

  test("AgentTurnLifecycle round-trips wrongFilename* fields through JSON", () => {
    const lc = {
      dispatchCommandId: "x", dispatchedAt: "x", phaseToken: "x",
      observedTurnId: null, state: "settled" as const,
      turnStartedAt: null, turnCompletedAt: null, completionSource: null,
      statusFileFingerprint: null, lastStopHookAt: null,
      wrongFilenameNudgeRound: 3,
      wrongFilenameNudgePlanMergeRound: 1,
    };
    const parsed = JSON.parse(JSON.stringify(lc));
    expect(parsed.wrongFilenameNudgeRound).toBe(3);
    expect(parsed.wrongFilenameNudgePlanMergeRound).toBe(1);
  });
});
