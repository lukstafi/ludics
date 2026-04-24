import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeLaunchAdapter, evaluateAutoStartDecisionPure, resolveQueueRequestCommand, orchPidForSlotMode, mergeRequirements, briefingPrecomputeContext } from "./mag.ts";
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

describe("stale settled sentinel detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mag-stale-settled-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Mirror of the production clearStaleSettled() in src/mag.ts, with "now" and
  // grace window parameterized so tests can drive the timestamp guard
  // deterministically. Default grace of 90s matches the production default
  // (keepalive_interval=60s × 1.5).
  function clearStaleSettled(
    currentHash: string | null,
    opts: { nowMs?: number; graceMs?: number } = {},
  ): boolean {
    const nowMs = opts.nowMs ?? Date.now();
    const graceMs = opts.graceMs ?? 90_000;

    const sentinelPath = join(tmpDir, "settled");
    const hashPath = join(tmpDir, "last-pane.hash");
    if (!existsSync(sentinelPath)) return false;

    // Timestamp guard (mirrors production)
    try {
      const content = readFileSync(sentinelPath, "utf-8").trim();
      const epoch = parseInt(content, 10);
      if (Number.isFinite(epoch) && epoch > 0) {
        const ageMs = nowMs - epoch * 1000;
        if (ageMs < graceMs) return false;
      }
    } catch { /* fall through */ }

    if (currentHash === null) return false;
    let previousHash: string | null = null;
    try { previousHash = readFileSync(hashPath, "utf-8").trim() || null; } catch { /* ignore */ }
    if (previousHash !== null && currentHash !== previousHash) {
      try { unlinkSync(sentinelPath); } catch { /* ignore */ }
      writeFileSync(hashPath, currentHash);
      return true; // sentinel was stale
    } else if (previousHash === null) {
      writeFileSync(hashPath, currentHash);
    }
    return false;
  }

  // Existing tests seed sentinel content "1234" (epoch 1970-01-01) — that age
  // is trivially past the 90s grace window under any realistic Date.now(), so
  // the new guard does not short-circuit these cases.

  test("clears settled when pane hash has changed", () => {
    writeFileSync(join(tmpDir, "settled"), "1234");
    writeFileSync(join(tmpDir, "last-pane.hash"), "oldhash");
    const cleared = clearStaleSettled("newhash");
    expect(cleared).toBe(true);
    expect(existsSync(join(tmpDir, "settled"))).toBe(false);
  });

  test("keeps settled when pane hash unchanged", () => {
    writeFileSync(join(tmpDir, "settled"), "1234");
    writeFileSync(join(tmpDir, "last-pane.hash"), "samehash");
    const cleared = clearStaleSettled("samehash");
    expect(cleared).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);
  });

  test("keeps settled on first observation (no prior hash)", () => {
    writeFileSync(join(tmpDir, "settled"), "1234");
    const cleared = clearStaleSettled("firsthash");
    expect(cleared).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);
    expect(readFileSync(join(tmpDir, "last-pane.hash"), "utf-8")).toBe("firsthash");
  });

  test("no-op when settled does not exist", () => {
    const cleared = clearStaleSettled("anyhash");
    expect(cleared).toBe(false);
  });

  test("no-op when pane hash is null (tmux capture failed)", () => {
    writeFileSync(join(tmpDir, "settled"), "1234");
    const cleared = clearStaleSettled(null);
    expect(cleared).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);
  });

  // gh-ludics-308: timestamp-guard regression tests

  test("keeps settled when sentinel is young despite hash change", () => {
    const now = Date.now();
    writeFileSync(join(tmpDir, "settled"), String(Math.floor(now / 1000)));
    writeFileSync(join(tmpDir, "last-pane.hash"), "oldhash");
    const cleared = clearStaleSettled("newhash", { nowMs: now });
    expect(cleared).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);
    // Prior hash is untouched — guard returns before any write
    expect(readFileSync(join(tmpDir, "last-pane.hash"), "utf-8")).toBe("oldhash");
  });

  test("clears settled when sentinel is old and hash changed", () => {
    const now = Date.now();
    const oldEpoch = Math.floor((now - 5 * 60_000) / 1000); // 5 minutes ago
    writeFileSync(join(tmpDir, "settled"), String(oldEpoch));
    writeFileSync(join(tmpDir, "last-pane.hash"), "oldhash");
    const cleared = clearStaleSettled("newhash", { nowMs: now });
    expect(cleared).toBe(true);
    expect(existsSync(join(tmpDir, "settled"))).toBe(false);
    expect(readFileSync(join(tmpDir, "last-pane.hash"), "utf-8")).toBe("newhash");
  });

  test("keeps settled when sentinel is old but hash unchanged", () => {
    const now = Date.now();
    const oldEpoch = Math.floor((now - 5 * 60_000) / 1000);
    writeFileSync(join(tmpDir, "settled"), String(oldEpoch));
    writeFileSync(join(tmpDir, "last-pane.hash"), "samehash");
    const cleared = clearStaleSettled("samehash", { nowMs: now });
    expect(cleared).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);
  });

  test("keeps settled on first observation regardless of sentinel age", () => {
    const now = Date.now();
    const oldEpoch = Math.floor((now - 5 * 60_000) / 1000);
    writeFileSync(join(tmpDir, "settled"), String(oldEpoch));
    // No prior hash written
    const cleared = clearStaleSettled("firsthash", { nowMs: now });
    expect(cleared).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);
    expect(readFileSync(join(tmpDir, "last-pane.hash"), "utf-8")).toBe("firsthash");
  });

  test("respects non-default keepalive interval (grace scales)", () => {
    const now = Date.now();
    // Sentinel written 100 seconds ago
    const epoch = Math.floor((now - 100_000) / 1000);
    writeFileSync(join(tmpDir, "settled"), String(epoch));
    writeFileSync(join(tmpDir, "last-pane.hash"), "oldhash");

    // keepalive_interval=120 → grace=180s → 100s is still within grace
    const keptWithLargerGrace = clearStaleSettled("newhash", { nowMs: now, graceMs: 180_000 });
    expect(keptWithLargerGrace).toBe(false);
    expect(existsSync(join(tmpDir, "settled"))).toBe(true);

    // keepalive_interval=40 → grace=60s → 100s is past grace, clears on hash change
    const clearedWithSmallerGrace = clearStaleSettled("newhash", { nowMs: now, graceMs: 60_000 });
    expect(clearedWithSmallerGrace).toBe(true);
    expect(existsSync(join(tmpDir, "settled"))).toBe(false);
  });
});

// Note: dequeueQueueHead was removed during rebase onto main — its CAS-preserving
// role is now fulfilled by src/queue.ts:queuePopExpected, which has its own
// coverage in src/queue.test.ts ("queuePopExpected" describe) including mismatch-
// without-mutation, malformed-JSON head, and empty-queue cases.

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
