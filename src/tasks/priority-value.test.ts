import { describe, test, expect } from "bun:test";
import { priorityValue } from "./markdown.ts";

describe("priorityValue", () => {
  test("orders S < A < B < C", () => {
    expect(priorityValue("S")).toBeLessThan(priorityValue("A"));
    expect(priorityValue("A")).toBeLessThan(priorityValue("B"));
    expect(priorityValue("B")).toBeLessThan(priorityValue("C"));
  });

  test("returns exact values: S=0, A=1, B=2, C=3", () => {
    expect(priorityValue("S")).toBe(0);
    expect(priorityValue("A")).toBe(1);
    expect(priorityValue("B")).toBe(2);
    expect(priorityValue("C")).toBe(3);
  });

  test("unknown priority sorts last (returns 9)", () => {
    expect(priorityValue("X")).toBe(9);
    expect(priorityValue("X")).toBeGreaterThan(priorityValue("C"));
  });

  test("empty string sorts last", () => {
    expect(priorityValue("")).toBeGreaterThan(priorityValue("C"));
  });
});
