import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeLaunchAdapter, evaluateAutoStartDecisionPure, resolveQueueRequestCommand, orchPidForSlotMode, mergeRequirements } from "./mag.ts";

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
