import { describe, test, expect } from "bun:test";
import { buildAffinityLookup, type AffinityInput } from "./affinity.ts";

function task(id: string, overrides: Partial<AffinityInput> = {}): AffinityInput {
  return {
    id,
    status: "ready",
    completed: null,
    dependencies: { blocks: [], blocked_by: [], relates_to: [] },
    ...overrides,
  };
}

describe("buildAffinityLookup", () => {
  test("chained relates_to closure — slotted propagates through chain", () => {
    const tasks = [
      task("A", { dependencies: { blocks: [], blocked_by: [], relates_to: ["B"] } }),
      task("B", { dependencies: { blocks: [], blocked_by: [], relates_to: ["C"] } }),
      task("C"),
    ];
    const lookup = buildAffinityLookup(tasks, new Set(["A"]));
    expect(lookup.getTier("A")).toBe(1);
    expect(lookup.getTier("B")).toBe(1);
    expect(lookup.getTier("C")).toBe(1);
  });

  test("blocks and blocked_by contribute to components", () => {
    const tasks = [
      task("done-task", { status: "done", dependencies: { blocks: ["ready-task"], blocked_by: [], relates_to: [] } }),
      task("ready-task"),
    ];
    const lookup = buildAffinityLookup(tasks, new Set());
    expect(lookup.getTier("ready-task")).toBe(2);
  });

  test("tier precedence — slotted wins over completed in same component", () => {
    const tasks = [
      task("slotted"),
      task("completed", { status: "done", dependencies: { blocks: [], blocked_by: [], relates_to: ["slotted"] } }),
      task("related", { dependencies: { blocks: [], blocked_by: [], relates_to: ["completed"] } }),
    ];
    const lookup = buildAffinityLookup(tasks, new Set(["slotted"]));
    expect(lookup.getTier("related")).toBe(1);
    expect(lookup.getTier("completed")).toBe(1);
  });

  test("no affinity — isolated task is Tier 3", () => {
    const tasks = [
      task("isolated"),
      task("slotted"),
    ];
    const lookup = buildAffinityLookup(tasks, new Set(["slotted"]));
    expect(lookup.getTier("isolated")).toBe(3);
    expect(lookup.getTier("slotted")).toBe(1);
  });

  test("unknown relation targets tolerated", () => {
    const tasks = [
      task("A", { dependencies: { blocks: [], blocked_by: [], relates_to: ["nonexistent"] } }),
      task("B"),
    ];
    // Should not throw
    const lookup = buildAffinityLookup(tasks, new Set());
    expect(lookup.getTier("A")).toBe(3);
    expect(lookup.getTier("B")).toBe(3);
  });

  test("multiple components — each classified independently", () => {
    const tasks = [
      task("slotted", { dependencies: { blocks: [], blocked_by: [], relates_to: ["s-friend"] } }),
      task("s-friend"),
      task("done-task", { status: "done", dependencies: { blocks: [], blocked_by: [], relates_to: ["d-friend"] } }),
      task("d-friend"),
      task("alone"),
    ];
    const lookup = buildAffinityLookup(tasks, new Set(["slotted"]));
    expect(lookup.getTier("s-friend")).toBe(1);
    expect(lookup.getTier("d-friend")).toBe(2);
    expect(lookup.getTier("alone")).toBe(3);
  });

  test("completed via completed field (not status)", () => {
    const tasks = [
      task("finished", { completed: "2026-03-20T10:00Z", dependencies: { blocks: [], blocked_by: [], relates_to: ["neighbor"] } }),
      task("neighbor"),
    ];
    const lookup = buildAffinityLookup(tasks, new Set());
    expect(lookup.getTier("neighbor")).toBe(2);
  });

  test("blocked_by edges connect tasks", () => {
    const tasks = [
      task("blocker", { status: "done" }),
      task("blocked", { dependencies: { blocks: [], blocked_by: ["blocker"], relates_to: [] } }),
    ];
    const lookup = buildAffinityLookup(tasks, new Set());
    expect(lookup.getTier("blocked")).toBe(2);
  });
});
