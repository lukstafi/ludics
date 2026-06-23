import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeLaunchAdapter, evaluateAutoStartDecisionPure, resolveQueueRequestCommand, orchPidForSlotMode, mergeRequirements, briefingPrecomputeContext, clearStaleSettled, setQueueHold, isQueueHeld, applyQueueFeedPrefix, runMag, clearAutoProposalDebounce, autoProposalDebounceFile, runStagingOutboundPushTick, maybeResumeDeadOrchestrators, fillBlankSnapshotArgsFromIntent } from "./mag.ts";
import { emptySlotData, writeSlotJson } from "./slots/json.ts";
import type { SlotData } from "./slots/types.ts";
import type { RunGit } from "./git-runner.ts";
import type { LudicsFullConfig, ProjectConfig } from "./config.ts";

describe("normalizeLaunchAdapter", () => {
  test("t3code passes through unchanged", () => {
    expect(normalizeLaunchAdapter("t3code")).toBe("t3code");
  });

  test("legacy agent-claude maps to t3code", () => {
    expect(normalizeLaunchAdapter("agent-claude")).toBe("t3code");
  });

  test("legacy agent-codex maps to t3code", () => {
    expect(normalizeLaunchAdapter("agent-codex")).toBe("t3code");
  });

  test("legacy agent-session maps to t3code", () => {
    expect(normalizeLaunchAdapter("agent-session")).toBe("t3code");
  });

  test("unknown adapter maps to t3code", () => {
    expect(normalizeLaunchAdapter("some-unknown")).toBe("t3code");
  });

  test("empty string maps to t3code", () => {
    expect(normalizeLaunchAdapter("")).toBe("t3code");
  });

  test("whitespace-padded adapter is trimmed and normalized", () => {
    expect(normalizeLaunchAdapter("  agent-claude  ")).toBe("t3code");
    expect(normalizeLaunchAdapter("  t3code  ")).toBe("t3code");
  });
});

describe("evaluateAutoStartDecisionPure", () => {
  test("auto + high + empty rationale + slot assigned → auto-start", () => {
    const result = evaluateAutoStartDecisionPure("high", "", "auto", true);
    expect(result.decision).toBe("auto-start");
  });

  test("auto + low → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure("low", "", "auto", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("worker confidence");
  });

  test("auto + undefined confidence → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure(undefined, "", "auto", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("missing");
  });

  test("auto + high + ambiguity in rationale → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure("high", "scope is ambiguous, needs clarification", "auto", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("ambiguous");
  });

  test("auto + high + 'speculative' in rationale → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure("high", "task is somewhat speculative", "auto", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("speculative");
  });

  test("auto + high + 'open question' in rationale → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure("high", "there is an open question about scope", "auto", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("open question");
  });

  test("auto + high + 'unambiguous' in rationale → auto-start (negation prefix)", () => {
    const result = evaluateAutoStartDecisionPure("high", "scope is unambiguous and well-defined", "auto", true);
    expect(result.decision).toBe("auto-start");
  });

  test("auto + high + 'no open question' in rationale → auto-start (negation prefix)", () => {
    const result = evaluateAutoStartDecisionPure("high", "No open questions, ready to proceed", "auto", true);
    expect(result.decision).toBe("auto-start");
  });

  test("auto + high + 'not speculative' in rationale → auto-start (negation prefix)", () => {
    const result = evaluateAutoStartDecisionPure("high", "this is not speculative, it is concrete", "auto", true);
    expect(result.decision).toBe("auto-start");
  });

  test("auto + high + clean rationale + no slot → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure("high", "clear bounded improvement", "auto", false);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("no slot");
  });

  test("suggest always defers regardless of confidence", () => {
    const result = evaluateAutoStartDecisionPure("high", "", "suggest", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("suggest");
  });

  test("manual always defers regardless of confidence", () => {
    const result = evaluateAutoStartDecisionPure("high", "", "manual", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("manual");
  });

  test("auto + high + 'uncertain scope' in rationale → defer-to-user", () => {
    const result = evaluateAutoStartDecisionPure("high", "the task has uncertain scope", "auto", true);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("uncertain scope");
  });

  test("suggest + high + no slot → still defers (slot state irrelevant for non-auto)", () => {
    const result = evaluateAutoStartDecisionPure("high", "", "suggest", false);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("suggest");
  });

  test("manual + high + no slot → still defers (slot state irrelevant for non-auto)", () => {
    const result = evaluateAutoStartDecisionPure("high", "", "manual", false);
    expect(result.decision).toBe("defer-to-user");
    expect(result.reason).toContain("manual");
  });
});

describe("resolveQueueRequestCommand — backward compat parsing", () => {
  // Approve format — recognized as programmatic (returns null)
  test("'Approve task <id>' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Approve task task-042" },
      false,
    );
    expect(result).toBeNull();
  });

  // Legacy launch format — recognized as programmatic (returns null)
  test("legacy format: 'Launch task <id>' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Launch task task-042" },
      false,
    );
    expect(result).toBeNull();
  });

  // Legacy format — must still be recognized (returns null, not the raw string)
  test("legacy format: 'Launch <adapter> for <id> in project ...' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Launch agent-claude for task-042 in project ludics" },
      false,
    );
    expect(result).toBeNull();
  });

  // New followup format
  test("new format: 'Followup task <id>' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Followup task task-042" },
      false,
    );
    expect(result).toBeNull();
  });

  // Legacy followup format
  test("legacy format: 'Followup <adapter> for <id>' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Followup agent-claude for task-042" },
      false,
    );
    expect(result).toBeNull();
  });

  // Abandon format
  test("'Abandon task <id>' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Abandon task task-042" },
      false,
    );
    expect(result).toBeNull();
  });

  // Done format
  test("'Done task <id>' is recognized", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "Done task task-042" },
      false,
    );
    expect(result).toBeNull();
  });

  // Unrecognized message — returned as user turn
  test("unrecognized message is returned as user turn content", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "message", content: "hello world" },
      false,
    );
    expect(result).toBe("hello world");
  });

  // Non-message actions route to skills
  test("draft-proposal action routes to skill command", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "draft-proposal", task: "task-042" },
      false,
    );
    expect(result).toBe("/ludics-draft-proposal task-042");
  });

  test("process-suggestions action routes to skill command", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "process-suggestions", task: "task-042" },
      false,
    );
    expect(result).toBe("/ludics-process-suggestions task-042");
  });

  test("process-suggestions without task returns null", async () => {
    const result = await resolveQueueRequestCommand(
      { action: "process-suggestions" },
      false,
    );
    expect(result).toBeNull();
  });
});

describe("applyQueueFeedPrefix — structural prefix decision", () => {
  // Positive case: task-bearing automated action gets prefix.
  // Harness condition: rawLine has `task` field and NO `content` field.
  // Invariant: any QueueAction whose JSON omits `content` is automated and
  // must be visibly distinguishable to Mag (no leading `/`, so Claude Code
  // does not auto-dispatch the embedded slash command).
  test("automated task-bearing action gets 'Ludics: ' prefix", () => {
    const raw = JSON.stringify({ action: "draft-proposal", task: "task-X" });
    const result = applyQueueFeedPrefix(raw, "/ludics-draft-proposal task-X");
    expect(result.startsWith("Ludics: ")).toBe(true);
    expect(result).toBe("Ludics: /ludics-draft-proposal task-X");
  });

  // Negative case: content-bearing message action goes through verbatim.
  // Harness condition: rawLine has `content: string` field.
  // Invariant: content-bearing entries (user-typed messages OR auto-fed
  // slash commands like `/compact` queued via the message channel) reach
  // Mag without prefix so Claude Code's parser still dispatches them.
  test("content-bearing message action does NOT get prefix", () => {
    const raw = JSON.stringify({ action: "message", content: "hello" });
    const result = applyQueueFeedPrefix(raw, "hello");
    expect(result.startsWith("Ludics: ")).toBe(false);
    expect(result).toBe("hello");
  });

  // AC 2a: load-bearing /compact case. The keepalive auto-schedules
  // `/compact` as a `message` action whose content is fed verbatim;
  // prefixing would break Claude Code's slash-command auto-dispatch.
  // Harness condition: rawLine has `content: "/compact"`.
  // Invariant: command remains exactly "/compact" — no prefix, even
  // though it starts with `/`.
  test("'/compact' message action is fed verbatim (load-bearing)", () => {
    const raw = JSON.stringify({ action: "message", content: "/compact" });
    const result = applyQueueFeedPrefix(raw, "/compact");
    expect(result).toBe("/compact");
  });

  // Falsifier: empty-string content still counts as content-bearing.
  // (typeof content === "string" — present but empty is still "user
  // shape" and should not be prefixed.)
  test("empty-string content is still content-bearing (no prefix)", () => {
    const raw = JSON.stringify({ action: "message", content: "" });
    const result = applyQueueFeedPrefix(raw, "");
    expect(result).toBe("");
  });

  // Falsifier: non-string content (e.g. null) is NOT content-bearing,
  // so the structural rule prefixes. Guards against a future variant
  // accidentally sneaking through with a falsy non-string content.
  test("non-string content field is treated as automated (gets prefix)", () => {
    const raw = JSON.stringify({ action: "weird", content: null, task: "task-X" });
    const result = applyQueueFeedPrefix(raw, "/ludics-weird task-X");
    expect(result).toBe("Ludics: /ludics-weird task-X");
  });

  // Defensive default: malformed JSON → treat as automated.
  test("parse failure defaults to prefixing (treat as automated)", () => {
    const result = applyQueueFeedPrefix("not-json{{{", "/ludics-foo");
    expect(result).toBe("Ludics: /ludics-foo");
  });

  // Falsifier: an action-name allowlist that omits `message` would
  // pass the positive test but fail this — `process-suggestions` has
  // a `task` field but no `content`, must be prefixed.
  test("process-suggestions task-bearing action gets prefix", () => {
    const raw = JSON.stringify({ action: "process-suggestions", task: "task-Y" });
    const result = applyQueueFeedPrefix(raw, "/ludics-process-suggestions task-Y");
    expect(result).toBe("Ludics: /ludics-process-suggestions task-Y");
  });

  // Inversion falsifier guard: if the structural condition is
  // accidentally inverted (prefixing content-bearing, not prefixing
  // task-bearing), the positive and negative tests above would both
  // fail. This explicit cross-pair confirms both branches in one shot.
  test("inversion-resistant: task-bearing prefixed, content-bearing not", () => {
    const taskRaw = JSON.stringify({ action: "elaborate", task: "task-Z" });
    const messageRaw = JSON.stringify({ action: "message", content: "free-form" });
    const taskResult = applyQueueFeedPrefix(taskRaw, "/ludics-elaborate task-Z");
    const messageResult = applyQueueFeedPrefix(messageRaw, "free-form");
    // Task-bearing must start with "Ludics: ", content-bearing must not.
    expect(taskResult.startsWith("Ludics: ")).toBe(true);
    expect(messageResult.startsWith("Ludics: ")).toBe(false);
  });
});

describe("orchPidForSlotMode", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  let TMP = "";

  function writeConfig(homeDir: string): string {
    const configDir = join(homeDir, ".config", "ludics");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.yaml");
    writeFileSync(configPath, `state_repo: owner/ludics-state\nstate_path: harness\nslots:\n  count: 2\n`);
    return configPath;
  }

  function testHarnessDir(): string {
    return join(TMP, "harness");
  }

  function writeT3codeSlotState(slot: number, state: object): void {
    const dir = join(testHarnessDir(), "t3code");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `slot-${slot}.json`), JSON.stringify(state));
  }

  function writeTmuxSlotState(slot: number, state: object): void {
    const dir = join(testHarnessDir(), "orchestration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `tmux-slot-${slot}.json`), JSON.stringify(state));
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-mag-"));
    process.env.HOME = TMP;
    process.env.LUDICS_CONFIG = writeConfig(TMP);
    process.env.LUDICS_HARNESS_DIR = testHarnessDir();
    mkdirSync(testHarnessDir(), { recursive: true });
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("tmux mode reads PID from tmux slot state", () => {
    writeTmuxSlotState(1, {
      slot: 1, ttydPids: {},
      orchestration: { stateFile: "orch.json", mode: "duo", pid: 12345 },
    });
    expect(orchPidForSlotMode(1, "tmux")).toBe(12345);
  });

  test("t3code mode reads PID from t3code slot state", () => {
    writeT3codeSlotState(1, {
      slot: 1, threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair", pid: 67890 },
    });
    expect(orchPidForSlotMode(1, "t3code")).toBe(67890);
  });

  test("unknown mode returns undefined", () => {
    expect(orchPidForSlotMode(1, "manual")).toBeUndefined();
  });

  test("missing state file returns undefined", () => {
    expect(orchPidForSlotMode(99, "tmux")).toBeUndefined();
  });
});

describe("mergeRequirements", () => {
  test("both undefined returns undefined", () => {
    expect(mergeRequirements(undefined, undefined)).toBeUndefined();
  });

  test("task only returns task values", () => {
    expect(mergeRequirements({ os: "linux" }, undefined)).toEqual({ os: "linux" });
  });

  test("project only returns project values", () => {
    expect(mergeRequirements(undefined, { gpu: "nvidia" })).toEqual({ gpu: "nvidia" });
  });

  test("task overrides project for overlapping key", () => {
    expect(mergeRequirements(
      { gpu: "nvidia" },
      { os: "linux", gpu: "apple-silicon" },
    )).toEqual({ os: "linux", gpu: "nvidia" });
  });

  test("non-overlapping keys combine", () => {
    expect(mergeRequirements(
      { gpu: "nvidia" },
      { os: "linux" },
    )).toEqual({ os: "linux", gpu: "nvidia" });
  });

  test("both empty objects returns undefined", () => {
    expect(mergeRequirements({}, {})).toBeUndefined();
  });
});

describe("settled sentinel atomic claim", () => {
  let tmpDir: string;
  let sentinelPath: string;
  let claimPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mag-settled-"));
    sentinelPath = join(tmpDir, "settled");
    claimPath = sentinelPath + ".claiming";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function atomicClaim(): boolean {
    try {
      renameSync(sentinelPath, claimPath);
    } catch {
      return false;
    }
    try { unlinkSync(claimPath); } catch { /* ignore */ }
    return true;
  }

  test("single claim succeeds when sentinel exists", () => {
    writeFileSync(sentinelPath, "1234");
    expect(atomicClaim()).toBe(true);
    expect(existsSync(sentinelPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
  });

  test("claim fails when sentinel does not exist", () => {
    expect(atomicClaim()).toBe(false);
  });

  test("only one of two concurrent claims succeeds", () => {
    writeFileSync(sentinelPath, "1234");
    const results = [atomicClaim(), atomicClaim()];
    const successes = results.filter(Boolean).length;
    expect(successes).toBe(1);
    expect(existsSync(sentinelPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
  });

  test("repeated claims after sentinel consumed all fail", () => {
    writeFileSync(sentinelPath, "1234");
    expect(atomicClaim()).toBe(true);
    expect(atomicClaim()).toBe(false);
    expect(atomicClaim()).toBe(false);
  });
});

describe("clearAutoProposalDebounce", () => {
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  let TMP = "";

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-debounce-"));
    process.env.LUDICS_HARNESS_DIR = TMP;
  });

  afterEach(() => {
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    rmSync(TMP, { recursive: true, force: true });
  });

  // AC1: clear-when-present
  test("removes a fresh debounce sentinel for the named task", () => {
    const path = autoProposalDebounceFile("task-X");
    mkdirSync(join(TMP, "mag", "auto-proposal-debounce"), { recursive: true });
    writeFileSync(path, String(Date.now()));
    expect(existsSync(path)).toBe(true);
    clearAutoProposalDebounce("task-X");
    expect(existsSync(path)).toBe(false);
  });

  // AC2: idempotent-when-absent
  test("is a no-op when the sentinel does not exist", () => {
    const path = autoProposalDebounceFile("task-Y");
    expect(existsSync(path)).toBe(false);
    expect(() => clearAutoProposalDebounce("task-Y")).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  test("does not affect debounce sentinels for other tasks", () => {
    const keep = autoProposalDebounceFile("task-keep");
    const drop = autoProposalDebounceFile("task-drop");
    mkdirSync(join(TMP, "mag", "auto-proposal-debounce"), { recursive: true });
    writeFileSync(keep, String(Date.now()));
    writeFileSync(drop, String(Date.now()));
    clearAutoProposalDebounce("task-drop");
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
  });
});

describe("briefingPrecomputeContext — Upstream vs Staging Lag section", () => {
  let tmpHome: string;
  let tmpConfig: string;
  let tmpHarness: string;
  const savedEnv: Record<string, string | undefined> = {};

  function snapshotEnv(keys: string[]) {
    for (const k of keys) savedEnv[k] = process.env[k];
  }
  function restoreEnv() {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mag-briefing-home-"));
    tmpHarness = mkdtempSync(join(tmpdir(), "mag-briefing-harness-"));
    tmpConfig = join(tmpHome, "config.yaml");
    snapshotEnv(["LUDICS_CONFIG", "LUDICS_HARNESS_DIR"]);
    process.env.LUDICS_CONFIG = tmpConfig;
    process.env.LUDICS_HARNESS_DIR = tmpHarness;
  });

  afterEach(() => {
    restoreEnv();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpHarness, { recursive: true, force: true });
  });

  function writeConfig(yaml: string) {
    writeFileSync(tmpConfig, yaml);
  }

  function contextFile(): string {
    return join(tmpHarness, "mag", "briefing-context.md");
  }

  // Fake runGit used for the presence test: matches the synthetic ocannl-ish fixture.
  const fakeRunGit: RunGit = (args) => {
    if (args[0] === "remote") return { stdout: "origin\nupstream\n", exitCode: 0 };
    if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
      return { stdout: "refs/remotes/origin/master\n", exitCode: 0 };
    }
    if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/upstream/HEAD") {
      return { stdout: "refs/remotes/upstream/master\n", exitCode: 0 };
    }
    if (args[0] === "rev-list") {
      return { stdout: "5\t2\n", exitCode: 0 };
    }
    if (args[0] === "log") {
      if (args[args.length - 1].startsWith("origin/")) {
        return { stdout: "aaa1111 2026-04-20 staging tip\n", exitCode: 0 };
      }
      return { stdout: "bbb2222 2026-04-01 upstream tip\n", exitCode: 0 };
    }
    return { stdout: "", exitCode: 0 };
  };

  test("section appears between Preempted Slots and Sessions Report when projects have upstream_repo", async () => {
    // Checkout directory must exist so the lag helper proceeds past the path check.
    const checkout = join(tmpHome, "my-proj");
    mkdirSync(checkout, { recursive: true });
    writeConfig([
      "state_repo: test/testrepo",
      "state_path: harness",
      "mag:",
      "  ensure_t3code: false",
      "projects:",
      "  - name: my-proj",
      "    repo: owner/my-proj-staging",
      "    upstream_repo: upstream/my-proj",
      `    path: ${checkout}`,
    ].join("\n"));

    await briefingPrecomputeContext({ runGit: fakeRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    const preIdx = content.indexOf("## Preempted Slots");
    const lagIdx = content.indexOf("## Upstream vs Staging Lag");
    const sessIdx = content.indexOf("## Sessions Report");
    expect(preIdx).toBeGreaterThan(0);
    expect(lagIdx).toBeGreaterThan(preIdx);
    expect(sessIdx).toBeGreaterThan(lagIdx);
    // Exactly one occurrence of the header
    expect(content.split("## Upstream vs Staging Lag").length).toBe(2);
    expect(content).toContain("### my-proj (upstream: upstream/my-proj)");
    expect(content).toContain("**staging is 2 commits AHEAD of upstream**");
  });

  test("section is omitted entirely when no project has upstream_repo", async () => {
    writeConfig([
      "state_repo: test/testrepo",
      "state_path: harness",
      "mag:",
      "  ensure_t3code: false",
      "projects:",
      "  - name: plain-proj",
      "    repo: owner/plain-proj",
    ].join("\n"));

    await briefingPrecomputeContext({ runGit: fakeRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    expect(content.indexOf("## Upstream vs Staging Lag")).toBe(-1);
    // Preempted Slots block should flow directly into Sessions Report (no header in between).
    const preIdx = content.indexOf("## Preempted Slots");
    const sessIdx = content.indexOf("## Sessions Report");
    expect(preIdx).toBeGreaterThan(0);
    expect(sessIdx).toBeGreaterThan(preIdx);
    const between = content.slice(preIdx, sessIdx);
    expect(between).not.toContain("##  "); // no spurious section header between the two
  });

  test("missing upstream remote emits per-project note, not a failure", async () => {
    const checkout = join(tmpHome, "my-proj2");
    mkdirSync(checkout, { recursive: true });
    writeConfig([
      "state_repo: test/testrepo",
      "state_path: harness",
      "mag:",
      "  ensure_t3code: false",
      "projects:",
      "  - name: my-proj2",
      "    repo: owner/my-proj2",
      "    upstream_repo: upstream/my-proj2",
      `    path: ${checkout}`,
    ].join("\n"));

    const noUpstream: RunGit = (args) => {
      if (args[0] === "remote") return { stdout: "origin\n", exitCode: 0 };
      return { stdout: "", exitCode: 128 };
    };
    await briefingPrecomputeContext({ runGit: noUpstream });

    const content = readFileSync(contextFile(), "utf-8");
    expect(content).toContain("## Upstream vs Staging Lag");
    expect(content).toContain("### my-proj2");
    expect(content).toContain("upstream remote not configured");
  });
});

// gh-ludics-535 A9: briefing-prep absorbs orphan in-flight records (records
// whose request id is no longer in queue.jsonl and whose result JSON is
// absent — the post-boot-race shape from the issue body). The orphan stanza
// is the audit trail; non-orphan records are left untouched. A resolved
// record (result file exists) is cleared by the leading reconcileInFlight()
// call, not by the orphan loop.
describe("briefingPrecomputeContext — orphan absorption (A9)", () => {
  let tmpHome: string;
  let tmpConfig: string;
  let tmpHarness: string;
  let magDirPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  function snapshotEnv(keys: string[]) {
    for (const k of keys) savedEnv[k] = process.env[k];
  }
  function restoreEnv() {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mag-orphan-home-"));
    tmpHarness = mkdtempSync(join(tmpdir(), "mag-orphan-harness-"));
    tmpConfig = join(tmpHome, "config.yaml");
    snapshotEnv(["LUDICS_CONFIG", "LUDICS_HARNESS_DIR"]);
    process.env.LUDICS_CONFIG = tmpConfig;
    process.env.LUDICS_HARNESS_DIR = tmpHarness;
    magDirPath = join(tmpHarness, "mag");
    mkdirSync(join(magDirPath, "in-flight"), { recursive: true });
    mkdirSync(join(magDirPath, "results"), { recursive: true });
    writeFileSync(tmpConfig, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "mag:",
      "  ensure_t3code: false",
      "projects: []",
    ].join("\n"));
  });

  afterEach(() => {
    restoreEnv();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpHarness, { recursive: true, force: true });
  });

  function inFlightFile(id: string): string {
    return join(magDirPath, "in-flight", `${id}.json`);
  }
  function resultFile(id: string): string {
    return join(magDirPath, "results", `${id}.json`);
  }
  function queueFile(): string {
    return join(magDirPath, "queue.jsonl");
  }
  function contextFile(): string {
    return join(magDirPath, "briefing-context.md");
  }
  function seedInFlight(id: string, deliveredAt = "2026-05-15T10:00:00Z"): void {
    writeFileSync(inFlightFile(id), JSON.stringify({
      requestId: id, command: "/ludics-learn",
      line: JSON.stringify({ id, action: "learn" }),
      deliveredAt,
    }));
  }

  const noopRunGit: RunGit = () => ({ stdout: "", exitCode: 0 });

  test("orphan record (id absent from queue, no result) is appended to briefing context and unlinked", async () => {
    seedInFlight("req-ORPHAN");
    // Queue does not contain req-ORPHAN.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-OTHER", action: "learn" }) + "\n");

    await briefingPrecomputeContext({ runGit: noopRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    expect(content).toContain("## Unresolved Deliveries (orphans)");
    expect(content).toContain("req-ORPHAN");
    expect(content).toContain("/ludics-learn");
    expect(content).toContain("2026-05-15T10:00:00Z");
    // Orphan record is unlinked so the next briefing doesn't re-list it.
    expect(existsSync(inFlightFile("req-ORPHAN"))).toBe(false);
  });

  test("non-orphan (id still in queue) is NOT listed and NOT unlinked", async () => {
    seedInFlight("req-PENDING");
    // Queue still has the id — record is still genuinely in flight.
    writeFileSync(queueFile(), JSON.stringify({ id: "req-PENDING", action: "learn" }) + "\n");

    await briefingPrecomputeContext({ runGit: noopRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    // The orphans section reads "(none)" because req-PENDING isn't an orphan.
    expect(content).toContain("## Unresolved Deliveries (orphans)\n\n(none)");
    // Non-orphan record is preserved.
    expect(existsSync(inFlightFile("req-PENDING"))).toBe(true);
  });

  test("resolved record (result file exists) is cleared by the leading reconcileInFlight call and NOT listed as orphan", async () => {
    // This is the load-bearing assertion for the explicit reconcileInFlight()
    // call at the top of the A9 step. If that call were removed, the orphan
    // filter would still skip req-DONE (it has a result), so the section
    // would still read "(none)" — but req-DONE's in-flight file would stay
    // on disk. The unlink assertion is the mutation-test signal.
    seedInFlight("req-DONE");
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));
    writeFileSync(queueFile(), "");

    await briefingPrecomputeContext({ runGit: noopRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    expect(content).toContain("## Unresolved Deliveries (orphans)\n\n(none)");
    // Removing the leading reconcileInFlight() makes this fail.
    expect(existsSync(inFlightFile("req-DONE"))).toBe(false);
  });

  test("no in-flight records → section reads '(none)' and no directory side effects", async () => {
    writeFileSync(queueFile(), "");

    await briefingPrecomputeContext({ runGit: noopRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    expect(content).toContain("## Unresolved Deliveries (orphans)\n\n(none)");
  });

  test("mix: one orphan + one pending + one resolved — only the orphan is listed; non-orphan survives; resolved is cleared", async () => {
    seedInFlight("req-ORPHAN", "2026-05-15T09:00:00Z");
    seedInFlight("req-PENDING", "2026-05-15T10:00:00Z");
    seedInFlight("req-DONE", "2026-05-15T11:00:00Z");
    writeFileSync(resultFile("req-DONE"), JSON.stringify({ id: "req-DONE", status: "ok" }));
    writeFileSync(queueFile(), JSON.stringify({ id: "req-PENDING", action: "learn" }) + "\n");

    await briefingPrecomputeContext({ runGit: noopRunGit });

    const content = readFileSync(contextFile(), "utf-8");
    expect(content).toContain("req-ORPHAN");
    expect(content).not.toContain("req-PENDING");
    expect(content).not.toContain("req-DONE");
    expect(existsSync(inFlightFile("req-ORPHAN"))).toBe(false);
    expect(existsSync(inFlightFile("req-PENDING"))).toBe(true);
    expect(existsSync(inFlightFile("req-DONE"))).toBe(false);
  });

  // Codex review on PR #536: queuePopSkill removes the entry from queue.jsonl
  // BEFORE deliverPoppedSkill writes the in-flight record. So the
  // currently-active delivery's requestId is absent from queue.jsonl AND its
  // result file does not yet exist — the literal orphan filter would
  // (incorrectly) absorb it. The active id sits in mag/current-request-id;
  // briefingPrecomputeContext must exclude it from the orphan set.
  test("ACTIVE delivery (id in mag/current-request-id, absent from queue.jsonl, no result) is NOT absorbed", async () => {
    // Harness condition reconstructed from queuePopSkill's pop→deliver
    // sequence: the active id sits in mag/current-request-id, the in-flight
    // record is on disk, the entry is no longer in queue.jsonl, the result
    // file is still absent. This is the exact state that
    // briefingPrecomputeContext sees when invoked from inside a Tier-2
    // briefing skill (e.g., action: "briefing").
    seedInFlight("req-ACTIVE", "2026-05-15T10:00:00Z");
    writeFileSync(join(magDirPath, "current-request-id"), "req-ACTIVE");
    writeFileSync(queueFile(), "");

    await briefingPrecomputeContext({ runGit: noopRunGit });

    // The gate invariant: an active delivery must remain on disk so
    // deliveryGateBlocked() stays true. Without the exclusion, this
    // assertion fails — the briefing would unlink its own record and
    // unblock the gate, letting the next pop dispatch prematurely.
    expect(existsSync(inFlightFile("req-ACTIVE"))).toBe(true);
    const content = readFileSync(contextFile(), "utf-8");
    expect(content).toContain("## Unresolved Deliveries (orphans)\n\n(none)");
  });
});

// gh-ludics-547: the briefing-context generator emits a precomputed
// `## Needs Confirmation` section so the briefing skill reads a
// status-verified list instead of hand-scanning tasks/*.md (which let three
// long-`done` tasks carry over into the 2026-05-20 briefing).
describe("briefingPrecomputeContext — Needs Confirmation section (gh-ludics-547)", () => {
  let tmpHome: string;
  let tmpConfig: string;
  let tmpHarness: string;
  const savedEnv: Record<string, string | undefined> = {};

  function snapshotEnv(keys: string[]) {
    for (const k of keys) savedEnv[k] = process.env[k];
  }
  function restoreEnv() {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mag-needsconf-home-"));
    tmpHarness = mkdtempSync(join(tmpdir(), "mag-needsconf-harness-"));
    tmpConfig = join(tmpHome, "config.yaml");
    snapshotEnv(["LUDICS_CONFIG", "LUDICS_HARNESS_DIR"]);
    process.env.LUDICS_CONFIG = tmpConfig;
    process.env.LUDICS_HARNESS_DIR = tmpHarness;
    mkdirSync(join(tmpHarness, "tasks"), { recursive: true });
    writeFileSync(tmpConfig, [
      "state_repo: test/testrepo",
      "state_path: harness",
      "mag:",
      "  ensure_t3code: false",
      "projects: []",
    ].join("\n"));
  });

  afterEach(() => {
    restoreEnv();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpHarness, { recursive: true, force: true });
  });

  const noopRunGit: RunGit = () => ({ stdout: "", exitCode: 0 });

  function contextFile(): string {
    return join(tmpHarness, "mag", "briefing-context.md");
  }

  function writeTask(
    id: string,
    status: string,
    opts: { priority?: string; project?: string; title?: string } = {},
  ): void {
    const { priority = "B", project = "ludics", title = id } = opts;
    writeFileSync(
      join(tmpHarness, "tasks", `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\nproject: ${project}\nstatus: ${status}\npriority: ${priority}\n---\n\n# ${title}\n`,
    );
  }

  /** The trimmed body between `## Needs Confirmation` and the next `## ` header. */
  function needsConfirmationBody(content: string): string {
    const header = "## Needs Confirmation";
    const start = content.indexOf(header);
    expect(start).toBeGreaterThanOrEqual(0);
    const after = content.slice(start + header.length);
    const next = after.indexOf("\n## ");
    return (next >= 0 ? after.slice(0, next) : after).trim();
  }

  test("#547 regression: lists the needs-confirmation task, excludes done/abandoned/merged", async () => {
    // Harness condition: a needs-confirmation task coexists with one task in
    // each terminal status. Pre-fix, step 4 hand-scanned tasks/*.md and
    // carried long-`done` tasks forward. Invariant: the precomputed section
    // is populated by exact status-match. Mutation — relaxing the predicate
    // to a non-terminal inverse filter readmits the terminal-status ids and
    // the three `not.toContain` assertions below fail.
    writeTask("task-nc-live", "needs-confirmation");
    writeTask("task-done-stale", "done");
    writeTask("task-abandoned-stale", "abandoned");
    writeTask("task-merged-stale", "merged");

    await briefingPrecomputeContext({ runGit: noopRunGit });
    const content = readFileSync(contextFile(), "utf-8");
    const body = needsConfirmationBody(content);

    expect(body).toContain("task-nc-live");
    expect(body).not.toContain("task-done-stale");
    expect(body).not.toContain("task-abandoned-stale");
    expect(body).not.toContain("task-merged-stale");
  });

  test("section sits between Tasks Needing Elaboration and Recent Journal", async () => {
    writeTask("task-nc-pos", "needs-confirmation");

    await briefingPrecomputeContext({ runGit: noopRunGit });
    const content = readFileSync(contextFile(), "utf-8");

    const elabIdx = content.indexOf("## Tasks Needing Elaboration");
    const ncIdx = content.indexOf("## Needs Confirmation");
    const journalIdx = content.indexOf("## Recent Journal");
    expect(elabIdx).toBeGreaterThan(0);
    expect(ncIdx).toBeGreaterThan(elabIdx);
    expect(journalIdx).toBeGreaterThan(ncIdx);
    // Exactly one occurrence of the header.
    expect(content.split("## Needs Confirmation").length).toBe(2);
  });

  test("projects id, priority, project, title — deterministically ordered by priority", async () => {
    // Harness condition: three tasks whose id alphabetical order AND their
    // creation order are both the *inverse* of their priority order —
    // `task-a-low` (priority C) is created first / sorts alphabetically first
    // but must render last; `task-z-high` (priority A) is created last but
    // must render first. Invariant: the section is stably priority-ordered
    // (AC 6), not readdir/creation-ordered, and carries all four projected
    // fields (AC 3). Mutation — removing the production sort yields
    // readdir order, which on an alphabetical-readdir or insertion-order
    // (tmpfs) filesystem is [task-a-low, task-m-mid, task-z-high], the exact
    // reverse of this expected body.
    writeTask("task-a-low", "needs-confirmation", { priority: "C", project: "ocannl", title: "Low priority confirm" });
    writeTask("task-m-mid", "needs-confirmation", { priority: "B", project: "ludics", title: "Mid priority confirm" });
    writeTask("task-z-high", "needs-confirmation", { priority: "A", project: "ludics", title: "High priority confirm" });

    await briefingPrecomputeContext({ runGit: noopRunGit });
    const body = needsConfirmationBody(readFileSync(contextFile(), "utf-8"));

    expect(body).toBe(
      'task-z-high (A) [ludics] "High priority confirm"\n'
      + 'task-m-mid (B) [ludics] "Mid priority confirm"\n'
      + 'task-a-low (C) [ocannl] "Low priority confirm"',
    );
  });

  test("renders the empty marker `None` when no task is in needs-confirmation status", async () => {
    // Harness condition: only a done task exists. Invariant: the section is
    // still present with an explicit empty marker (AC 4) so the briefing
    // skill can tell "no such tasks" from "section missing".
    writeTask("task-done-only", "done");

    await briefingPrecomputeContext({ runGit: noopRunGit });
    const content = readFileSync(contextFile(), "utf-8");

    expect(content).toContain("## Needs Confirmation");
    expect(needsConfirmationBody(content)).toBe("None");
  });
});

describe("stale settled sentinel detection", () => {
  // Migrated to call the production clearStaleSettled() directly (task-1b44d17b).
  // Tests drive the function via injected { nowMs, graceMs, currentHash } and
  // assert side effects on real harness files (mag/settled, mag/last-pane.hash)
  // by pointing LUDICS_HARNESS_DIR at a temp directory.
  let tmpHarness: string;
  let magDir: string;
  let sentinelPath: string;
  let hashPath: string;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

  beforeEach(() => {
    tmpHarness = mkdtempSync(join(tmpdir(), "mag-stale-settled-"));
    process.env.LUDICS_HARNESS_DIR = tmpHarness;
    magDir = join(tmpHarness, "mag");
    mkdirSync(magDir, { recursive: true });
    sentinelPath = join(magDir, "settled");
    hashPath = join(magDir, "last-pane.hash");
  });

  afterEach(() => {
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    rmSync(tmpHarness, { recursive: true, force: true });
  });

  // Existing tests seed sentinel content "1234" (epoch 1970-01-01) — that age
  // is trivially past any realistic grace window, so the timestamp guard does
  // not short-circuit these cases.

  test("clears settled when pane hash has changed", () => {
    writeFileSync(sentinelPath, "1234");
    writeFileSync(hashPath, "oldhash");
    clearStaleSettled({ currentHash: "newhash" });
    expect(existsSync(sentinelPath)).toBe(false);
    expect(readFileSync(hashPath, "utf-8")).toBe("newhash");
  });

  test("keeps settled when pane hash unchanged", () => {
    writeFileSync(sentinelPath, "1234");
    writeFileSync(hashPath, "samehash");
    clearStaleSettled({ currentHash: "samehash" });
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(hashPath, "utf-8")).toBe("samehash");
  });

  test("keeps settled on first observation (no prior hash)", () => {
    writeFileSync(sentinelPath, "1234");
    clearStaleSettled({ currentHash: "firsthash" });
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(hashPath, "utf-8")).toBe("firsthash");
  });

  test("no-op when settled does not exist", () => {
    clearStaleSettled({ currentHash: "anyhash" });
    expect(existsSync(sentinelPath)).toBe(false);
    expect(existsSync(hashPath)).toBe(false);
  });

  test("no-op when pane hash is null (tmux capture failed)", () => {
    writeFileSync(sentinelPath, "1234");
    clearStaleSettled({ currentHash: null });
    expect(existsSync(sentinelPath)).toBe(true);
    expect(existsSync(hashPath)).toBe(false);
  });

  // gh-ludics-308: timestamp-guard regression tests

  test("keeps settled when sentinel is young despite hash change", () => {
    const now = Date.now();
    writeFileSync(sentinelPath, String(Math.floor(now / 1000)));
    writeFileSync(hashPath, "oldhash");
    clearStaleSettled({ currentHash: "newhash", nowMs: now });
    expect(existsSync(sentinelPath)).toBe(true);
    // Prior hash is untouched — guard returns before any write
    expect(readFileSync(hashPath, "utf-8")).toBe("oldhash");
  });

  test("clears settled when sentinel is old and hash changed", () => {
    const now = Date.now();
    const oldEpoch = Math.floor((now - 5 * 60_000) / 1000); // 5 minutes ago
    writeFileSync(sentinelPath, String(oldEpoch));
    writeFileSync(hashPath, "oldhash");
    clearStaleSettled({ currentHash: "newhash", nowMs: now });
    expect(existsSync(sentinelPath)).toBe(false);
    expect(readFileSync(hashPath, "utf-8")).toBe("newhash");
  });

  test("keeps settled when sentinel is old but hash unchanged", () => {
    const now = Date.now();
    const oldEpoch = Math.floor((now - 5 * 60_000) / 1000);
    writeFileSync(sentinelPath, String(oldEpoch));
    writeFileSync(hashPath, "samehash");
    clearStaleSettled({ currentHash: "samehash", nowMs: now });
    expect(existsSync(sentinelPath)).toBe(true);
  });

  test("keeps settled on first observation regardless of sentinel age", () => {
    const now = Date.now();
    const oldEpoch = Math.floor((now - 5 * 60_000) / 1000);
    writeFileSync(sentinelPath, String(oldEpoch));
    // No prior hash written
    clearStaleSettled({ currentHash: "firsthash", nowMs: now });
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(hashPath, "utf-8")).toBe("firsthash");
  });

  test("respects non-default keepalive interval (grace scales)", () => {
    const now = Date.now();
    // Sentinel written 100 seconds ago
    const epoch = Math.floor((now - 100_000) / 1000);
    writeFileSync(sentinelPath, String(epoch));
    writeFileSync(hashPath, "oldhash");

    // keepalive_interval=120 → grace=180s → 100s is still within grace
    clearStaleSettled({ currentHash: "newhash", nowMs: now, graceMs: 180_000 });
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(hashPath, "utf-8")).toBe("oldhash");

    // keepalive_interval=40 → grace=60s → 100s is past grace, clears on hash change
    clearStaleSettled({ currentHash: "newhash", nowMs: now, graceMs: 60_000 });
    expect(existsSync(sentinelPath)).toBe(false);
    expect(readFileSync(hashPath, "utf-8")).toBe("newhash");
  });
});

// Note: dequeueQueueHead was removed during rebase onto main — its CAS-preserving
// role is now fulfilled by src/queue.ts:queuePopExpected, which has its own
// coverage in src/queue.test.ts ("queuePopExpected" describe) including mismatch-
// without-mutation, malformed-JSON head, and empty-queue cases.

describe("setQueueHold sentinel", () => {
  // Migrated from the deleted bash test script (gh-ludics-407): that script
  // emulated the mkdirSync({recursive: true}) + writeFileSync sentinel-write
  // path with `mkdir -p` + `touch` and asserted both the fresh-harness
  // ENOENT branch and idempotent re-hold. Test the production helper directly.

  let TMP = "";
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-mag-qh-"));
    process.env.LUDICS_HARNESS_DIR = TMP;
    // Note: deliberately do NOT pre-create TMP/mag — the fresh-harness case
    // exercises the mkdirSync({recursive: true}) ENOENT branch in setQueueHold.
  });

  afterEach(() => {
    if (ORIGINAL_HARNESS_DIR === undefined) {
      delete process.env.LUDICS_HARNESS_DIR;
    } else {
      process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    }
    rmSync(TMP, { recursive: true, force: true });
  });

  test("setQueueHold(true) creates sentinel when mag/ does not pre-exist", () => {
    // Invariant: setQueueHold's mkdirSync({recursive: true}) handles the
    // fresh-harness ENOENT scenario. Removing the recursive flag flips this.
    // Harness condition: TMP/mag is intentionally absent on entry.
    expect(existsSync(join(TMP, "mag"))).toBe(false);
    expect(setQueueHold(true, "test")).toBe(true);
    expect(existsSync(join(TMP, "mag", "queue-hold"))).toBe(true);
    expect(isQueueHeld()).toBe(true);
  });

  test("setQueueHold(true) creates sentinel when mag/ already exists", () => {
    // Invariant: mkdirSync({recursive: true}) is also idempotent against an
    // already-existing directory (no EEXIST throw).
    // Harness condition: TMP/mag pre-created before the call.
    mkdirSync(join(TMP, "mag"), { recursive: true });
    expect(setQueueHold(true, "test")).toBe(true);
    expect(existsSync(join(TMP, "mag", "queue-hold"))).toBe(true);
  });

  test("setQueueHold(true) is idempotent — second call is a no-op", () => {
    // Invariant: setQueueHold short-circuits when state already matches —
    // no second writeFileSync, no throw, returns false. The early-return
    // `if (held === isQueueHeld()) return false` is what enforces this.
    // Harness condition: queue is already held when the second call runs.
    setQueueHold(true, "test");
    expect(setQueueHold(true, "test")).toBe(false);
    expect(existsSync(join(TMP, "mag", "queue-hold"))).toBe(true);
  });

  test("setQueueHold(false) removes sentinel after a hold", () => {
    // Invariant: resume removes the sentinel via unlinkSync; isQueueHeld
    // reflects sentinel absence. Skipping the unlink flips this.
    // Harness condition: queue was held immediately before resume.
    setQueueHold(true, "test");
    expect(setQueueHold(false, "test")).toBe(true);
    expect(existsSync(join(TMP, "mag", "queue-hold"))).toBe(false);
    expect(isQueueHeld()).toBe(false);
  });

  test("setQueueHold(false) is idempotent on already-not-held", () => {
    // Invariant: same short-circuit on the resume branch — no unlinkSync
    // ENOENT throw on a fresh harness with no sentinel.
    // Harness condition: no prior hold; sentinel does not exist on entry.
    expect(isQueueHeld()).toBe(false);
    expect(setQueueHold(false, "test")).toBe(false);
  });
});

describe("magStateFile atomic write", () => {
  test("writes session state via atomic tmp+rename (no .tmp leftover)", async () => {
    // Exercise atomicWriteFileSync via json module directly since magStart
    // requires tmux; verify the helper the production path now calls.
    const { atomicWriteFileSync } = await import("./json.ts");
    const dir = mkdtempSync(join(tmpdir(), "mag-state-test-"));
    const file = join(dir, "state");
    const body = `session=test\nstarted=2026-04-24T00:00:00Z\nworking_dir=${dir}\nstatus=starting\n`;
    atomicWriteFileSync(file, body);
    expect(readFileSync(file, "utf-8")).toBe(body);
    expect(existsSync(file + ".tmp")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runMag unknown-command listing (gh-ludics-438)", () => {
  // Invariant: the default-case error listing is derived from the
  // `magSubcommands` registry keys, not a hand-maintained literal. If the
  // registry refactor is reverted, the message would either drift from
  // reality (current `analyze`/`feedback-digest` mismatch) or fail to
  // include newly added cases. These assertions enforce that derivation.
  //
  // Harness condition: invoke runMag with a sentinel sub the registry has
  // never had; the dispatcher takes the missing-handler branch and emits
  // the derived listing.

  test("listing includes every live first-level case (no drift)", async () => {
    let err: Error | null = null;
    try {
      await runMag(["__bogus__"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toMatch(/^unknown mag command: __bogus__ \(use: /);
    // Real cases that drift on `main`'s hand-maintained listing — must
    // appear in the derived listing.
    expect(msg).toContain("auto-start-evaluate");
    expect(msg).toContain("revise-proposal");
    expect(msg).toContain("feedback-digest");
    // Spot-check a handful of long-standing cases.
    expect(msg).toContain("start");
    expect(msg).toContain("verify-container-completion");
  });

  test("listing excludes stale entries previously hand-typed in default", async () => {
    let err: Error | null = null;
    try {
      await runMag(["__bogus__"]);
    } catch (e) {
      err = e as Error;
    }
    const msg = err!.message;
    // `analyze` had no handler — it was literal-only drift.
    expect(msg).not.toContain("analyze");
    // Nested second-level commands must not pollute the first-level listing.
    expect(msg).not.toContain("queue pop one");
    expect(msg).not.toContain("queue pop all");
  });

  test("listing excludes internal hook entry points (on-stop / queue-pop)", async () => {
    // Invariant: hook entries (`on-stop`, deprecated alias `queue-pop`) stay
    // callable for templates/hooks/ludics-on-stop.sh but never surface in
    // user-facing help. Without the MAG_HIDDEN_SUBCOMMANDS filter, the
    // derived listing would leak both names into `(use: ...)` output.
    //
    // Harness condition: invoke runMag with a sentinel sub so the
    // unknown-handler branch fires; capture the listing string.
    let err: Error | null = null;
    try {
      await runMag(["__bogus__"]);
    } catch (e) {
      err = e as Error;
    }
    const msg = err!.message;
    // The (use: …) listing must not contain either internal entry. Anchor
    // the assertion to that segment so we don't trip on the `${sub}`
    // payload: the sentinel would never collide with these names anyway,
    // but the listing-side check is the real contract.
    const useMatch = msg.match(/\(use: ([^)]*)\)/);
    expect(useMatch).not.toBeNull();
    const useEntries = useMatch![1]!.split(/,\s*/);
    expect(useEntries).not.toContain("on-stop");
    expect(useEntries).not.toContain("queue-pop");
    // Sanity: the public commands are still present.
    expect(useEntries).toContain("start");
    expect(useEntries).toContain("completed");
  });
});

// =============================================================================
// gh-ludics-540: runStagingOutboundPushTick wrapper gates.
// AC 14 (controller-gate) + AC 7 (per-project opt-in: missing/false → off).
// All four tests use a recording RunGit and assert `calls.length === 0`
// (or specific outcomes when the wrapper passes through).
// =============================================================================

function recordingRunGit(): { run: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args.slice());
      return { stdout: "", exitCode: 0 };
    },
  };
}

function ocannlProject(opts: { enabled?: boolean | undefined; path?: string }): ProjectConfig {
  const base: ProjectConfig = {
    name: "ocannl",
    repo: "lukstafi/ocannl-staging",
    upstream_repo: "ahrefs/ocannl",
    path: opts.path ?? "/does/not/exist-ludics-540-test",
  };
  // Only set the field when the caller wants it set — preserves the
  // "absent" distinction from explicit false.
  if (opts.enabled !== undefined) {
    base.outbound_sync_enabled = opts.enabled;
  }
  return base;
}

// task-35e74651: RunGit driver that reaches step (E)'s push and returns a
// given push result. remote/status/branch-detect/fetch/local-ff/ancestry all
// succeed so the push is the only failure point.
function pushPathRunGit(push: { stdout?: string; stderr?: string; exitCode?: number }): RunGit {
  return (args) => {
    const key = args[0] ?? "";
    if (key === "remote") return { stdout: "origin\nupstream\n", exitCode: 0 };
    if (key === "status") return { stdout: "", exitCode: 0 };
    if (key === "symbolic-ref") {
      const ref = args[1] ?? "";
      if (ref.endsWith("/origin/HEAD")) return { stdout: "refs/remotes/origin/master\n", exitCode: 0 };
      if (ref.endsWith("/upstream/HEAD")) return { stdout: "refs/remotes/upstream/master\n", exitCode: 0 };
      return { stdout: "", exitCode: 128 };
    }
    if (key === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "master\n", exitCode: 0 };
    if (key === "checkout") return { stdout: "", exitCode: 0 };
    if (key === "fetch") return { stdout: "", exitCode: 0 };
    if (key === "merge" && args[1] === "--ff-only") return { stdout: "Already up to date.\n", exitCode: 0 };
    if (key === "rev-list" && args[1] === "--count") return { stdout: "5\n", exitCode: 0 };
    if (key === "merge-base" && args[1] === "--is-ancestor") return { stdout: "", exitCode: 0 };
    if (key === "push") return { stdout: push.stdout ?? "", stderr: push.stderr, exitCode: push.exitCode ?? 0 };
    return { stdout: "", exitCode: 0 };
  };
}

const WORKFLOW_SCOPE_STDERR =
  "! [remote rejected] origin/master -> master (refusing to allow an OAuth App to create or update workflow `.github/workflows/gh-pages-docs.yml` without `workflow` scope)";

describe("runStagingOutboundPushTick", () => {
  test("task-35e74651: workflow-scope push rejection persists event with structured project + remedy", () => {
    const harnessRoot = mkdtempSync("/tmp/mag-outbound-wfscope-harness-");
    const checkoutDir = mkdtempSync("/tmp/mag-outbound-wfscope-checkout-");
    const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = harnessRoot;
    try {
      const cfg = {
        projects: [{
          name: "ocannl",
          repo: "lukstafi/ocannl-staging",
          upstream_repo: "ahrefs/ocannl",
          outbound_sync_enabled: true,
          path: checkoutDir,
        }],
      } as unknown as LudicsFullConfig;
      const results = runStagingOutboundPushTick({
        isController: () => true,
        runGit: pushPathRunGit({ stderr: WORKFLOW_SCOPE_STDERR, exitCode: 128 }),
        config: cfg,
        now: new Date(),
        // sentinelDir omitted → emitEvent writes under env-overridden harnessRoot.
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.outcome).toBe("skipped-no-workflow-scope");

      const eventsFile = join(harnessRoot, "journal", "events.jsonl");
      expect(existsSync(eventsFile)).toBe(true);
      const lines = readFileSync(eventsFile, "utf-8").trim().split("\n").filter(Boolean);
      const wf = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.event_type === "staging_outbound_workflow_scope_missing");
      expect(wf).toHaveLength(1);
      // Mutation guard for the new `project: ev.project` adapter line: drop it
      // and this assertion fails (the annotation lookup would then have to
      // parse the message prefix).
      expect(wf[0]!.project).toBe("ocannl");
      expect(String(wf[0]!.message)).toContain("gh auth refresh -h github.com -s workflow");
    } finally {
      if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
      rmSync(harnessRoot, { recursive: true, force: true });
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  test("task-35e74651: skipped-no-workflow-scope outcome is logged to stderr", () => {
    const sentinelDir = mkdtempSync("/tmp/outbound-wfscope-stderr-");
    const checkoutDir = mkdtempSync("/tmp/outbound-wfscope-stderr-checkout-");
    const cfg = {
      projects: [{
        name: "ocannl",
        repo: "lukstafi/ocannl-staging",
        upstream_repo: "ahrefs/ocannl",
        outbound_sync_enabled: true,
        path: checkoutDir,
      }],
    } as unknown as LudicsFullConfig;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let logged: string[];
    try {
      const results = runStagingOutboundPushTick({
        isController: () => true,
        runGit: pushPathRunGit({ stderr: WORKFLOW_SCOPE_STDERR, exitCode: 128 }),
        config: cfg,
        sentinelDir,
        now: new Date(),
      });
      expect(results[0]!.outcome).toBe("skipped-no-workflow-scope");
      // Capture before restore (bun:test mockRestore wipes call history).
      logged = spy.mock.calls.map((c) => String(c[0]));
    } finally {
      spy.mockRestore();
      rmSync(sentinelDir, { recursive: true, force: true });
      rmSync(checkoutDir, { recursive: true, force: true });
    }
    expect(logged.some((l) => l.includes("outbound-staging-ff ocannl: skipped-no-workflow-scope"))).toBe(true);
  });


  test("controller-gate: short-circuits with zero git invocations when isController() returns false", () => {
    const { run, calls } = recordingRunGit();
    const sentinelDir = mkdtempSync("/tmp/outbound-gate-");
    const cfg = {
      projects: [ocannlProject({ enabled: true })],
    } as unknown as LudicsFullConfig;
    const results = runStagingOutboundPushTick({
      isController: () => false,
      runGit: run,
      sentinelDir,
      config: cfg,
      now: new Date(),
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("opt-in absent: project with no outbound_sync_enabled is filtered out", () => {
    // Closes the absent-field regression (reviewer finding 3 on v1).
    // A legacy config with no outbound_sync_enabled must behave as off.
    const { run, calls } = recordingRunGit();
    const sentinelDir = mkdtempSync("/tmp/outbound-flag-absent-");
    const cfg = {
      projects: [ocannlProject({ enabled: undefined })],
    } as unknown as LudicsFullConfig;
    const results = runStagingOutboundPushTick({
      isController: () => true,
      runGit: run,
      sentinelDir,
      config: cfg,
      now: new Date(),
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("opt-in false: project with outbound_sync_enabled: false is filtered out", () => {
    const { run, calls } = recordingRunGit();
    const sentinelDir = mkdtempSync("/tmp/outbound-flag-false-");
    const cfg = {
      projects: [ocannlProject({ enabled: false })],
    } as unknown as LudicsFullConfig;
    const results = runStagingOutboundPushTick({
      isController: () => true,
      runGit: run,
      sentinelDir,
      config: cfg,
      now: new Date(),
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("opt-in true: project reaches the core syncUpstreamMainFromStaging", () => {
    // Positive-control sibling for the two negative tests above — without
    // this assertion the wrapper could silently filter EVERY project and
    // both negative tests would still pass under a broken filter.
    // The cheap reach-the-core observation: path points to a non-existent
    // directory so the core returns skipped-no-path (length 1).
    const { run } = recordingRunGit();
    const sentinelDir = mkdtempSync("/tmp/outbound-flag-true-");
    const cfg = {
      projects: [ocannlProject({ enabled: true })],
    } as unknown as LudicsFullConfig;
    const results = runStagingOutboundPushTick({
      isController: () => true,
      runGit: run,
      sentinelDir,
      config: cfg,
      now: new Date(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("skipped-no-path");
  });

  test("AC 4: divergence event payload survives the Mag adapter (divergedBy reaches journal/events.jsonl)", () => {
    // Reviewer round-2 invariant: the wrapper must NOT drop the
    // structured divergence count from `ev.extra` when forwarding to
    // events.emitEvent. Mutation test: replace `...(ev.extra ?? {})`
    // with `{}` in src/mag.ts and this assertion fails.
    //
    // End-to-end path:
    //   syncUpstreamMainFromStaging emits divergedBy in ev.extra
    //   → runStagingOutboundPushTick spreads ev.extra into emitEvent()
    //   → emitEvent (./events.ts) appends to journal/events.jsonl
    //     with LudicsEvent's open `[key: string]: unknown` shape.
    const harnessRoot = mkdtempSync("/tmp/mag-outbound-event-harness-");
    const checkoutDir = mkdtempSync("/tmp/mag-outbound-event-checkout-");
    const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
    process.env.LUDICS_HARNESS_DIR = harnessRoot;
    try {
      // Custom RunGit that drives the divergence path:
      //   remote → origin\nupstream\n
      //   status → clean
      //   rev-parse --abbrev-ref HEAD → master
      //   symbolic-ref / ls-remote → master defaults
      //   fetch upstream → 0
      //   fetch origin master → 0
      //   merge --ff-only origin/master → 0 (local-ff OK)
      //   rev-list --count upstream/master..origin/master → 5
      //   merge-base --is-ancestor upstream/master origin/master → 1 (NOT ancestor)
      //   rev-list --left-right --count upstream/master...origin/master → "3\t5\n"
      const run: RunGit = (args) => {
        const key = args[0] ?? "";
        if (key === "remote") return { stdout: "origin\nupstream\n", exitCode: 0 };
        if (key === "status") return { stdout: "", exitCode: 0 };
        if (key === "symbolic-ref") {
          const ref = args[1] ?? "";
          if (ref.endsWith("/origin/HEAD")) return { stdout: "refs/remotes/origin/master\n", exitCode: 0 };
          if (ref.endsWith("/upstream/HEAD")) return { stdout: "refs/remotes/upstream/master\n", exitCode: 0 };
          return { stdout: "", exitCode: 128 };
        }
        if (key === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "master\n", exitCode: 0 };
        if (key === "checkout") return { stdout: "", exitCode: 0 };
        if (key === "fetch") return { stdout: "", exitCode: 0 };
        if (key === "merge" && args[1] === "--ff-only") return { stdout: "Already up to date.\n", exitCode: 0 };
        if (key === "rev-list" && args[1] === "--count") return { stdout: "5\n", exitCode: 0 };
        if (key === "rev-list" && args[1] === "--left-right") return { stdout: "3\t5\n", exitCode: 0 };
        // Non-ancestor: exit 1.
        if (key === "merge-base" && args[1] === "--is-ancestor") return { stdout: "", exitCode: 1 };
        return { stdout: "", exitCode: 0 };
      };
      const cfg = {
        projects: [{
          name: "ocannl",
          repo: "lukstafi/ocannl-staging",
          upstream_repo: "ahrefs/ocannl",
          outbound_sync_enabled: true,
          path: checkoutDir,
        }],
      } as unknown as LudicsFullConfig;
      const results = runStagingOutboundPushTick({
        isController: () => true,
        runGit: run,
        config: cfg,
        now: new Date(),
        // sentinelDir omitted on purpose so emitEvent writes under the
        // env-overridden harnessRoot/journal/events.jsonl, exercising
        // the production code path end-to-end.
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.outcome).toBe("skipped-not-fast-forward");

      const eventsFile = join(harnessRoot, "journal", "events.jsonl");
      expect(existsSync(eventsFile)).toBe(true);
      const lines = readFileSync(eventsFile, "utf-8").trim().split("\n").filter(Boolean);
      const divergedLines = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.event_type === "staging_outbound_fast_forward_diverged");
      expect(divergedLines).toHaveLength(1);
      const divergedEvent = divergedLines[0]!;
      // AC 4: the structured count made it all the way through:
      //   core → ev.extra.divergedBy
      //   → wrapper's spread (...(ev.extra ?? {}))
      //   → emitEvent() persists under LudicsEvent's open shape.
      expect(divergedEvent.divergedBy).toBe(3);
      expect(divergedEvent.aheadBy).toBe(5);
      expect(divergedEvent.source).toBe("mag");
      expect(typeof divergedEvent.message).toBe("string");
      // The human-readable message already includes the count (the
      // project name is part of the message rather than a structured
      // LudicsEvent field; LudicsEvent.task is unused for project
      // scope, see src/events.ts:LudicsEvent for the structured shape).
      expect(String(divergedEvent.message)).toContain("ocannl");
      expect(String(divergedEvent.message)).toContain("3 commits");
    } finally {
      if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
      else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
      rmSync(harnessRoot, { recursive: true, force: true });
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  test("global enable_staging_fast_forward=false: outbound tick short-circuits like inbound", () => {
    // Operator escape hatch — disabling inbound also kills outbound,
    // matching the runStagingFastForwardTick gate.
    const { run, calls } = recordingRunGit();
    const sentinelDir = mkdtempSync("/tmp/outbound-global-off-");
    const cfg = {
      mag: { enable_staging_fast_forward: false },
      projects: [ocannlProject({ enabled: true })],
    } as unknown as LudicsFullConfig;
    const results = runStagingOutboundPushTick({
      isController: () => true,
      runGit: run,
      sentinelDir,
      config: cfg,
      now: new Date(),
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// gh-ludics-580: worker dead-orchestrator auto-resume must use controller-live
// slot state (the `freshSlots` map), never the worker's stale local harness
// clone. These tests exercise maybeResumeDeadOrchestrators on a federation
// worker — a path that previously had zero coverage.
describe("maybeResumeDeadOrchestrators — worker controller-live slot state (gh-ludics-580)", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let TMP = "";

  function harness(): string { return join(TMP, "harness"); }
  function orchCacheDir(): string { return join(TMP, ".ludics-orch-cache"); }

  // Config: start_sessions autonomy must be non-manual or the function
  // early-returns (gh feedback: keepalive tests need autonomy auto), plus a
  // two-machine cluster so worker/controller context resolves via
  // LUDICS_CLUSTER_MACHINE_NAME.
  function writeConfig(homeDir: string): string {
    const configPath = join(homeDir, "config.yaml");
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
mag:
  autonomy_level:
    start_sessions: auto
cluster:
  transport: http
  domain: test.local
  machines:
    - name: leader-box
      host: leader-box.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: minipc-wsl
      host: minipc-wsl.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);
    return configPath;
  }

  // Worker-cache writers (mirror the migrated read paths in worker context).
  function writeWorkerOrchState(slot: number, taskId: string): void {
    mkdirSync(orchCacheDir(), { recursive: true });
    writeFileSync(join(orchCacheDir(), `slot-${slot}.json`), JSON.stringify({
      slot, taskId, phase: "work", mode: "pair",
    }));
  }
  function writeWorkerT3codeState(slot: number, pid: number): void {
    const dir = join(orchCacheDir(), "t3code");
    mkdirSync(dir, { recursive: true });
    // threads: [] → slotResume's t3code branch throws "no persisted t3code
    // state" *after* the machine gate — a deterministic, process-free failure
    // that is NOT the remote-offline refusal.
    writeFileSync(join(dir, `slot-${slot}.json`), JSON.stringify({
      slot, threads: [], orchestration: { stateFile: "x", mode: "pair", pid },
    }));
  }
  function freshSlot(slot: number, machine: string, taskId: string): SlotData {
    return { ...emptySlotData(slot), process: "orch-runner", task: taskId, mode: "t3code", machine, path: join(TMP, "wt"), liveness: null };
  }
  // Observable seam: on a worker, emitEvent forwards to the controller over
  // HTTP and writes no local journal, so we observe the resume decision via
  // console.error — which fires locally for both the "detected dead
  // orchestrator" detection log and the catch-path "failed to auto-resume" log
  // (carrying the thrown message).
  async function runCapturingErrors(fresh: Map<number, SlotData> | null): Promise<string> {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await maybeResumeDeadOrchestrators(fresh);
    } finally {
      spy.mockRestore();
    }
    return logs.join("\n");
  }

  const DEAD_PID = 2147483647; // INT32_MAX — never a live process

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-mag-resume-"));
    process.env.HOME = TMP;
    process.env.LUDICS_CONFIG = writeConfig(TMP);
    process.env.LUDICS_HARNESS_DIR = harness();
    mkdirSync(harness(), { recursive: true });
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("AC1: worker resumes its own slot locally despite a stale local harness clone (no remote-offline refusal)", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // worker context

    // Stale LOCAL harness slot — the bug's trigger: machine=mac-studio (a remote
    // peer with no heartbeat). Without the override, readSlot reads THIS.
    writeSlotJson(1, { ...emptySlotData(1), process: "orch-runner", task: "task-850e1b37", mode: "t3code", machine: "mac-studio" });

    // Worker-cache state (fresh, what the runner wrote): orch state + dead t3code pid.
    writeWorkerOrchState(1, "task-66a3bbff");
    writeWorkerT3codeState(1, DEAD_PID);

    // Controller-live state: this worker (minipc-wsl) owns slot 1, current task.
    const freshSlots = new Map<number, SlotData>([[1, freshSlot(1, "minipc-wsl", "task-66a3bbff")]]);

    const out = await runCapturingErrors(freshSlots);

    // Harness condition: stale local machine=mac-studio + freshSlots machine=self.
    // Invariant: the slot the worker legitimately owns reaches LOCAL execution.
    // The override makes readSlot return machine=minipc-wsl (self), so resume
    // passes the isRemoteMachine gate and fails only on the t3code state check —
    // never the machine-identity refusal.
    expect(out).toContain("detected dead orchestrator for slot 1"); // reached resume
    expect(out).toContain("no persisted t3code state");             // failed LOCALLY, past the gate
    // Mutation control: dropping the setWorkerSlotsOverride wrap makes readSlot
    // return the stale machine=mac-studio → this assertion would FAIL with
    // "assigned machine mac-studio is offline — cannot resume".
    expect(out).not.toContain("is offline — cannot resume");
  });

  test("AC2: worker skips auto-resume when freshSlots is null — no local-clone fallback", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // worker context

    // A LOCAL slot that WOULD look resumable (machine=self so it survives the
    // remote-skip; dead orch in the worker cache). If the function fell back to
    // readAllSlotJson, it would detect this and attempt resume.
    writeSlotJson(1, { ...emptySlotData(1), process: "orch-runner", task: "task-66a3bbff", mode: "t3code", machine: "minipc-wsl" });
    writeWorkerOrchState(1, "task-66a3bbff");
    writeWorkerT3codeState(1, DEAD_PID);

    const out = await runCapturingErrors(null);

    // Harness condition: worker context + null freshSlots + a resumable local
    // clone. Invariant: with no controller-live state, a worker never reads the
    // local clone, so it never even detects the dead orchestrator. Mutation
    // control: removing the `if (isWorkerNode()) return` guard makes
    // readAllSlotJson find slot 1 → "detected dead orchestrator" would appear →
    // this assertion would FAIL.
    expect(out).not.toContain("detected dead orchestrator");
  });

  test("gh-ludics-592: worker never resurrects a slot the controller-live freshSlots reports (empty)", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "minipc-wsl"; // worker context

    // The exact incident: the worker's stale LOCAL harness clone still shows the
    // slot LIVE (task-55a11fa3, owned by self), and a dead orchestrator sits in
    // the worker cache — so a stale-clone-driven resume WOULD detect it and
    // re-create tmux/worktree on an already-DONE task.
    writeSlotJson(4, { ...emptySlotData(4), process: "orch-runner", task: "task-55a11fa3", mode: "t3code", machine: "minipc-wsl" });
    writeWorkerOrchState(4, "task-55a11fa3");
    writeWorkerT3codeState(4, DEAD_PID);

    // But the controller cleared the slot: its controller-live freshSlots row is
    // (empty) (process defaults to "(empty)" in emptySlotData).
    const freshSlots = new Map<number, SlotData>([[4, emptySlotData(4)]]);

    const out = await runCapturingErrors(freshSlots);

    // Invariant: with the controller-live view saying (empty), the worker must
    // NOT detect the dead orchestrator or attempt any resume/resurrection — the
    // `(empty)` continue fires BEFORE any orch-state read or PID check. Harness
    // condition: freshSlots row for slot 4 has process="(empty)" while the local
    // clone says live. Mutation control: flipping the fresh row's process to a
    // non-empty value (e.g. {...emptySlotData(4), process:"orch-runner", task:...,
    // mode:"t3code", machine:"minipc-wsl"}) makes the loop reach detection →
    // "detected dead orchestrator" appears → this assertion FAILS.
    expect(out).not.toContain("detected dead orchestrator");
  });

  test("AC2 positive control: controller WITH null freshSlots still reaches the loop (skip is worker-only)", async () => {
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "leader-box"; // controller context

    // On the controller the harness is authoritative; the local-clone fallback
    // is legitimate. Same resumable local slot → resume IS attempted.
    writeSlotJson(1, { ...emptySlotData(1), process: "orch-runner", task: "task-66a3bbff", mode: "t3code", machine: "leader-box" });
    // On the controller, orch + t3code state live in the harness tree (not the
    // worker cache), so write them there.
    mkdirSync(join(harness(), "orchestration"), { recursive: true });
    writeFileSync(join(harness(), "orchestration", "slot-1.json"), JSON.stringify({ slot: 1, taskId: "task-66a3bbff", phase: "work", mode: "pair" }));
    mkdirSync(join(harness(), "t3code"), { recursive: true });
    writeFileSync(join(harness(), "t3code", "slot-1.json"), JSON.stringify({ slot: 1, threads: [], orchestration: { stateFile: "x", mode: "pair", pid: DEAD_PID } }));

    const out = await runCapturingErrors(null);

    // Controller did NOT early-return: it reached slotResume (which fails on the
    // t3code state check). isRemoteMachine("leader-box")=self → local, so the
    // failure is the t3code-state one, not an offline refusal. This proves the
    // null-freshSlots skip is gated on isWorkerNode(), not unconditional.
    expect(out).toContain("detected dead orchestrator for slot 1");
    expect(out).toContain("no persisted t3code state");
  });
});

// gh-ludics-584: resume-loop circuit-breaker. When the keepalive auto-resumes a
// slot that keeps dying in the SAME (taskId, phase) without advancing, it must
// stop re-spawning after N consecutive no-advance ticks, mark the slot
// escalated, raise a priority notification, and emit a structured event —
// instead of churning a dying runner every ~2 min forever. These run in
// CONTROLLER context (leader-box) so emitEvent/notify/persistSlotLiveness write
// locally and are directly observable.
describe("maybeResumeDeadOrchestrators — resume circuit-breaker (gh-ludics-584)", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let TMP = "";
  const DEAD_PID = 2147483647; // INT32_MAX — never a live process
  const THRESHOLD = 3; // mirrors MAX_CONSECUTIVE_NO_ADVANCE_RESUMES

  function harness(): string { return join(TMP, "harness"); }

  function writeConfig(homeDir: string): string {
    const configPath = join(homeDir, "config.yaml");
    writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
mag:
  autonomy_level:
    start_sessions: auto
cluster:
  transport: http
  domain: test.local
  machines:
    - name: leader-box
      host: leader-box.test.local
      os: macos
      role: leader
      always_on: true
      gpu: ""
    - name: minipc-wsl
      host: minipc-wsl.test.local
      os: linux
      role: worker
      always_on: false
      gpu: ""
`);
    return configPath;
  }

  // Controller harness writers: orch state + t3code (dead pid) live in the
  // harness tree. `threads: []` → slotResume throws "no persisted t3code state"
  // *after* the machine gate, a deterministic process-free failure that proves
  // slotResume was reached (the positive control / no-throttle path).
  function writeOrchState(slot: number, taskId: string, phase: string, noProgress?: { taskId: string; phase: string; consecutiveTicks: number }): void {
    mkdirSync(join(harness(), "orchestration"), { recursive: true });
    writeFileSync(join(harness(), "orchestration", `slot-${slot}.json`), JSON.stringify({
      slot, taskId, phase, mode: "pair",
      ...(noProgress ? { autoResumeNoProgress: noProgress } : {}),
    }));
  }
  function writeT3codeState(slot: number, pid: number): void {
    mkdirSync(join(harness(), "t3code"), { recursive: true });
    writeFileSync(join(harness(), "t3code", `slot-${slot}.json`), JSON.stringify({
      slot, threads: [], orchestration: { stateFile: "x", mode: "pair", pid },
    }));
  }
  function writeSlot(slot: number, taskId: string, liveness: SlotData["liveness"] = null): void {
    writeSlotJson(slot, { ...emptySlotData(slot), process: "orch-runner", task: taskId, mode: "t3code", machine: "leader-box", path: join(TMP, "wt"), liveness });
  }

  async function runCapturingErrors(fresh: Map<number, SlotData> | null): Promise<string> {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await maybeResumeDeadOrchestrators(fresh);
    } finally {
      spy.mockRestore();
    }
    return logs.join("\n");
  }

  function readSlotLiveness(slot: number): unknown {
    const raw = JSON.parse(readFileSync(join(harness(), "slots", `slot-${slot}.json`), "utf-8"));
    return raw.liveness;
  }
  function readEvents(): string {
    const p = join(harness(), "journal", "events.jsonl");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }
  function readNotifications(): string {
    const p = join(harness(), "journal", "notifications.jsonl");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-mag-cb-"));
    process.env.HOME = TMP;
    process.env.LUDICS_CONFIG = writeConfig(TMP);
    process.env.LUDICS_HARNESS_DIR = harness();
    process.env.LUDICS_CLUSTER_MACHINE_NAME = "leader-box"; // controller context
    mkdirSync(harness(), { recursive: true });
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("TRIP: same (task,phase) at threshold-1 → no resume, slot escalated, priority-5 notify, event emitted", async () => {
    // Harness condition: prior persisted count = THRESHOLD-1 (=2) for the SAME
    // (taskId, phase) the orchestrator is still stuck in → this detection makes
    // ticks reach THRESHOLD and trips the breaker.
    writeSlot(1, "task-66a3bbff");
    writeOrchState(1, "task-66a3bbff", "setup", { taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: THRESHOLD - 1 });
    writeT3codeState(1, DEAD_PID);

    const out = await runCapturingErrors(null);

    // Invariant: the breaker tripped — it did NOT reach slotResume. If it had,
    // the t3code branch would log "no persisted t3code state". Its absence is
    // what proves no re-spawn happened.
    expect(out).toContain("circuit-breaker tripped for slot 1");
    expect(out).not.toContain("no persisted t3code state");
    expect(out).not.toContain("detected dead orchestrator for slot 1 (pid"); // the resume log

    // Invariant: the slot is marked escalated in authoritative state so the
    // other auto-loops (and the next tick's liveness skip) stop touching it.
    expect(readSlotLiveness(1)).toBe("escalated");

    // Invariant: one priority-5 notification names the wedge.
    const notifs = readNotifications();
    expect(notifs).toContain('"priority":5');
    expect(notifs).toContain("orchestration wedged");

    // Invariant: a structured circuit-break event is emitted with the count.
    const events = readEvents();
    expect(events).toContain("orchestration_resume_circuit_break");
    expect(events).toContain(`"count":${THRESHOLD}`);
  });

  test("NO-THROTTLE positive control: recorded phase differs (advanced) → counter resets, resume IS attempted", async () => {
    // Harness condition: a HIGH prior count (5) but recorded against a DIFFERENT
    // phase ("plan") than the current orchestrator phase ("setup") — i.e. the
    // orchestrator advanced between ticks. sameWork=false → ticks resets to 1 <
    // THRESHOLD → resume proceeds, never throttled.
    writeSlot(1, "task-66a3bbff");
    writeOrchState(1, "task-66a3bbff", "setup", { taskId: "task-66a3bbff", phase: "plan", consecutiveTicks: 5 });
    writeT3codeState(1, DEAD_PID);

    const out = await runCapturingErrors(null);

    expect(out).not.toContain("circuit-breaker tripped");
    // Reached slotResume (proves not throttled) — fails on the t3code state check.
    expect(out).toContain("detected dead orchestrator for slot 1");
    expect(out).toContain("no persisted t3code state");
  });

  test("LIVENESS SKIP: an already-escalated slot is never re-detected or re-escalated", async () => {
    // Harness condition: slot liveness already "escalated" (a prior trip, or an
    // operator). The loop must skip it entirely — no detection, no second
    // escalation/notification. Without the skip the breaker would re-fire each tick.
    writeSlot(1, "task-66a3bbff", "escalated");
    writeOrchState(1, "task-66a3bbff", "setup", { taskId: "task-66a3bbff", phase: "setup", consecutiveTicks: THRESHOLD });
    writeT3codeState(1, DEAD_PID);

    const out = await runCapturingErrors(null);

    expect(out).not.toContain("detected dead orchestrator");
    expect(out).not.toContain("circuit-breaker tripped");
  });

  test("RATE LIMIT: a trip on slot 1 consumes the per-invocation action — slot 2 is left untouched this tick", async () => {
    // Harness condition: slot 1 trips (escalation), slot 2 is independently
    // resumable. Escalation does `resumed += 1`, so the loop must not also act
    // on slot 2 in the same invocation. Mutation control: dropping `resumed += 1`
    // from the trip path would let slot 2 be detected → this assertion FAILS.
    writeSlot(1, "task-aaa");
    writeOrchState(1, "task-aaa", "setup", { taskId: "task-aaa", phase: "setup", consecutiveTicks: THRESHOLD - 1 });
    writeT3codeState(1, DEAD_PID);
    writeSlot(2, "task-bbb");
    writeOrchState(2, "task-bbb", "setup");
    writeT3codeState(2, DEAD_PID);

    const out = await runCapturingErrors(null);

    expect(out).toContain("circuit-breaker tripped for slot 1");
    expect(out).not.toContain("slot 2"); // slot 2 not detected/resumed this tick
  });
});

// gh-ludics-589: the worker fills a blank snapshot slot's adapterArgs from the
// controller-authored start intent, so a freshSlots snapshot that raced the
// two-slot duo publish still launches slotB with the correct expanded args.
describe("fillBlankSnapshotArgsFromIntent (gh-ludics-589 Part B)", () => {
  const duoArgs = "--pair --coder codex --reviewer claude-code --duo-peer-slot=3";
  function snap(slot: number, adapterArgs: string): SlotData {
    return { ...emptySlotData(slot), process: "orch-runner", task: "task-duo-b", mode: "tmux", machine: "self-node", adapterArgs };
  }

  test("fills a BLANK snapshot entry from a start intent carrying expanded duo args", () => {
    // Harness condition: the snapshot raced the publish — slotB's row is blank,
    // but the start intent carries the controller's swapped providers + peer.
    const filled = fillBlankSnapshotArgsFromIntent(snap(4, ""), { action: "start", adapterArgs: duoArgs });
    // Invariant: the corrected row carries the swapped providers and peer slot, so
    // the downstream slotStart/auto-fill never sees empty args. If the merge were
    // dropped, filled would be null and slotB would launch with default providers.
    expect(filled).not.toBeNull();
    expect(filled!.adapterArgs).toBe(duoArgs);
    expect(filled!.adapterArgs).toContain("--duo-peer-slot=3");
    // Whitespace-only is treated as blank and filled too.
    expect(fillBlankSnapshotArgsFromIntent(snap(4, "   "), { action: "start", adapterArgs: duoArgs })?.adapterArgs).toBe(duoArgs);
  });

  test("a POPULATED snapshot entry wins — intent does not clobber it", () => {
    const existing = snap(4, "--pair --coder claude-code --reviewer codex --duo-peer-slot=3");
    // Invariant: only a delivery gap (blank args) is repaired; a snapshot that
    // already carries args is authoritative and untouched.
    expect(fillBlankSnapshotArgsFromIntent(existing, { action: "start", adapterArgs: duoArgs })).toBeNull();
  });

  test("no-ops for non-start intents, missing intent args, and missing snapshot row", () => {
    expect(fillBlankSnapshotArgsFromIntent(snap(4, ""), { action: "stop", adapterArgs: duoArgs })).toBeNull();
    expect(fillBlankSnapshotArgsFromIntent(snap(4, ""), { action: "resume", adapterArgs: duoArgs })).toBeNull();
    expect(fillBlankSnapshotArgsFromIntent(snap(4, ""), { action: "start" })).toBeNull();
    expect(fillBlankSnapshotArgsFromIntent(undefined, { action: "start", adapterArgs: duoArgs })).toBeNull();
  });
});
