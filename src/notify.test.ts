import { describe, expect, test } from "bun:test";
import { buildProposalNotificationActions, chunkNotificationActions } from "./notify.ts";

describe("buildProposalNotificationActions", () => {
  test("includes launch, revise, and abandon buttons", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "project-x",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    expect(actions.map((action) => String(action.label))).toEqual([
      "launch",
      "revise",
      "abandon",
    ]);
    expect(String(actions[0]!.body)).toBe("Launch task task-042");
    expect(String(actions[1]!.body)).toBe("Revise proposal for task-042");
    expect(String(actions[2]!.body)).toBe("Abandon task task-042");
  });
});

describe("chunkNotificationActions", () => {
  test("proposal actions fit in one chunk", () => {
    const actions = buildProposalNotificationActions("task-042", "project-x", "incoming-topic", {});
    const chunks = chunkNotificationActions(actions, 3);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(3);
    expect(chunks.flat().map((action) => String(action.label))).toEqual(
      actions.map((action) => String(action.label)),
    );
  });
});

describe("buildProposalNotificationActions — t3code-only format", () => {
  test("action bodies contain no adapter or project references", () => {
    const actions = buildProposalNotificationActions(
      "task-042",
      "some-project",
      "incoming-topic",
      { Authorization: "Bearer token" },
    );

    for (const action of actions) {
      const body = String(action.body);
      // Must not contain adapter-specific launch patterns
      expect(body).not.toMatch(/Launch \w+ for/);
      // Must not contain "in project" suffix
      expect(body).not.toContain("in project");
    }

    // Verify exact modern format
    expect(String(actions[0]!.body)).toBe("Launch task task-042");
  });
});
