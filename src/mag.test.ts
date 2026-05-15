import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeLaunchAdapter, evaluateAutoStartDecisionPure, resolveQueueRequestCommand, orchPidForSlotMode, mergeRequirements, briefingPrecomputeContext, clearStaleSettled, setQueueHold, isQueueHeld, applyQueueFeedPrefix, runMag, clearAutoProposalDebounce, autoProposalDebounceFile } from "./mag.ts";
import type { RunGit } from "./git-runner.ts";

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
