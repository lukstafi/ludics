import { describe, expect, test } from "bun:test";
import { normalizeLaunchAdapter, evaluateAutoStartDecisionPure, resolveQueueRequestCommand } from "./mag.ts";

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
  // New format — recognized as programmatic (returns null)
  test("new format: 'Launch task <id>' is recognized", async () => {
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
