import { describe, expect, test, beforeEach } from "bun:test";
import { resolveSkillCommand, hasRegisteredAction, clearSkillQueueCache } from "./skill-queue-registry.ts";

// The registry reads real skills/*.md files.  Tests run from the project root,
// so ludicsRoot() falls back to process.cwd() which points here.

beforeEach(() => {
  clearSkillQueueCache();
});

describe("hasRegisteredAction", () => {
  test("returns true for all 14 known queue actions", () => {
    const known = [
      "briefing", "suggest", "elaborate", "health-check", "learn",
      "sync-learnings", "feedback-digest", "draft-proposal", "revise-proposal",
      "split-task", "preempt", "verify-completion", "adopt-sessions",
      "process-suggestions",
    ];
    for (const action of known) {
      expect(hasRegisteredAction(action), `expected "${action}" to be registered`).toBe(true);
    }
  });

  test("returns false for programmatic-only actions", () => {
    expect(hasRegisteredAction("message")).toBe(false);
    expect(hasRegisteredAction("adapter-followup")).toBe(false);
    expect(hasRegisteredAction("complete-task")).toBe(false);
  });

  test("returns false for unknown actions", () => {
    expect(hasRegisteredAction("nonexistent-action")).toBe(false);
    expect(hasRegisteredAction("")).toBe(false);
  });
});

describe("resolveSkillCommand — no-arg skills", () => {
  test("briefing → /ludics-briefing", () => {
    expect(resolveSkillCommand("briefing", {})).toBe("/ludics-briefing");
  });

  test("suggest → /ludics-suggest", () => {
    expect(resolveSkillCommand("suggest", {})).toBe("/ludics-suggest");
  });

  test("health-check → /ludics-health-check", () => {
    expect(resolveSkillCommand("health-check", {})).toBe("/ludics-health-check");
  });

  test("learn → /ludics-learn", () => {
    expect(resolveSkillCommand("learn", {})).toBe("/ludics-learn");
  });

  test("sync-learnings → /ludics-sync-learnings", () => {
    expect(resolveSkillCommand("sync-learnings", {})).toBe("/ludics-sync-learnings");
  });

  test("adopt-sessions → /ludics-adopt-sessions", () => {
    expect(resolveSkillCommand("adopt-sessions", {})).toBe("/ludics-adopt-sessions");
  });
});

describe("resolveSkillCommand — single-arg skills", () => {
  test("elaborate with task", () => {
    expect(resolveSkillCommand("elaborate", { task: "task-042" })).toBe("/ludics-elaborate task-042");
  });

  test("draft-proposal with task", () => {
    expect(resolveSkillCommand("draft-proposal", { task: "task-042" })).toBe("/ludics-draft-proposal task-042");
  });

  test("split-task with task", () => {
    expect(resolveSkillCommand("split-task", { task: "task-042" })).toBe("/ludics-split-task task-042");
  });

  test("verify-completion with task", () => {
    expect(resolveSkillCommand("verify-completion", { task: "task-042" })).toBe("/ludics-verify-completion task-042");
  });

  test("feedback-digest with repo (no queue-args declared, repo ignored)", () => {
    expect(resolveSkillCommand("feedback-digest", { repo: "owner/repo" })).toBe("/ludics-feedback-digest");
  });

  test("feedback-digest without repo returns command only", () => {
    expect(resolveSkillCommand("feedback-digest", {})).toBe("/ludics-feedback-digest");
  });
});

describe("resolveSkillCommand — multi-arg skills", () => {
  test("revise-proposal with task and feedback", () => {
    expect(resolveSkillCommand("revise-proposal", { task: "task-042", feedback: "needs more detail" }))
      .toBe("/ludics-revise-proposal task-042 needs more detail");
  });

  test("revise-proposal with task only (optional feedback omitted)", () => {
    expect(resolveSkillCommand("revise-proposal", { task: "task-042" }))
      .toBe("/ludics-revise-proposal task-042");
  });

  test("preempt with task and autonomy", () => {
    expect(resolveSkillCommand("preempt", { task: "task-042", autonomy: "auto" }))
      .toBe("/ludics-preempt task-042 auto");
  });

  test("preempt without autonomy uses default 'suggest'", () => {
    expect(resolveSkillCommand("preempt", { task: "task-042" }))
      .toBe("/ludics-preempt task-042 suggest");
  });
});

describe("resolveSkillCommand — required args", () => {
  test("process-suggestions with task", () => {
    expect(resolveSkillCommand("process-suggestions", { task: "task-042" }))
      .toBe("/ludics-process-suggestions task-042");
  });

  test("process-suggestions without task returns null (required arg missing)", () => {
    expect(resolveSkillCommand("process-suggestions", {})).toBeNull();
  });

  test("process-suggestions with empty task string returns null", () => {
    expect(resolveSkillCommand("process-suggestions", { task: "" })).toBeNull();
  });
});

describe("resolveSkillCommand — unknown actions", () => {
  test("returns null for programmatic-only actions", () => {
    expect(resolveSkillCommand("message", {})).toBeNull();
    expect(resolveSkillCommand("adapter-followup", { task: "task-042" })).toBeNull();
    expect(resolveSkillCommand("complete-task", { task: "task-042" })).toBeNull();
  });

  test("returns null for truly unknown actions", () => {
    expect(resolveSkillCommand("nonexistent", {})).toBeNull();
    expect(resolveSkillCommand("", {})).toBeNull();
  });
});

describe("resolveSkillCommand — cache behaviour", () => {
  test("repeated calls return the same result (cache hit)", () => {
    const first = resolveSkillCommand("suggest", {});
    const second = resolveSkillCommand("suggest", {});
    expect(first).toBe("/ludics-suggest");
    expect(second).toBe(first);
  });

  test("clearSkillQueueCache allows re-loading registry", () => {
    const before = resolveSkillCommand("suggest", {});
    clearSkillQueueCache();
    const after = resolveSkillCommand("suggest", {});
    expect(before).toBe(after);
  });
});
