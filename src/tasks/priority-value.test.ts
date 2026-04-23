import { describe, test, expect } from "bun:test";
import { priorityValue } from "./markdown.ts";

describe("priorityValue", () => {
  test("orders S < A < B < C < D", () => {
    expect(priorityValue("S")).toBeLessThan(priorityValue("A"));
    expect(priorityValue("A")).toBeLessThan(priorityValue("B"));
    expect(priorityValue("B")).toBeLessThan(priorityValue("C"));
    expect(priorityValue("C")).toBeLessThan(priorityValue("D"));
  });

  test("returns exact values: S=0, A=1, B=2, C=3, D=4", () => {
    expect(priorityValue("S")).toBe(0);
    expect(priorityValue("A")).toBe(1);
    expect(priorityValue("B")).toBe(2);
    expect(priorityValue("C")).toBe(3);
    expect(priorityValue("D")).toBe(4);
  });

  test("unknown priority sorts last (returns 9)", () => {
    expect(priorityValue("X")).toBe(9);
    expect(priorityValue("X")).toBeGreaterThan(priorityValue("D"));
    expect(priorityValue("D")).toBeLessThan(priorityValue("X"));
  });

  test("empty string sorts last", () => {
    expect(priorityValue("")).toBeGreaterThan(priorityValue("D"));
  });
});
