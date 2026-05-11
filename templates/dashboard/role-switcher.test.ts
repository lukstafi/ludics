// task-b43bd578 — pure-cascade unit tests for role-switcher.js.
// AC 14 names this transformation and pins its behaviour independently
// of the DOM.

import { describe, expect, test } from "bun:test";

import { applyRoleChange, fromWireBody, PROVIDERS } from "./role-switcher.js";

describe("PROVIDERS (browser-side copy)", () => {
  test("lists exactly claude-code and codex (in this order)", () => {
    expect([...PROVIDERS]).toEqual(["claude-code", "codex"]);
  });
});

describe("applyRoleChange — N=2 cascade (AC 14 bullets 1–2)", () => {
  test("swap: codex coder ← claude-code coder (swap, claude-code → reviewer)", () => {
    const before = { "claude-code": "coder", "codex": "reviewer" };
    const after = applyRoleChange(before, "codex", "coder");
    expect(after).toEqual({ "claude-code": "reviewer", "codex": "coder" });
  });

  test("promotion to vacant reviewer: codex none → coder; claude-code was coder, reviewer vacant → claude-code becomes reviewer", () => {
    const before = { "claude-code": "coder", "codex": "none" };
    const after = applyRoleChange(before, "codex", "coder");
    expect(after).toEqual({ "claude-code": "reviewer", "codex": "coder" });
  });

  test("symmetric promotion (reviewer side): claude-code reviewer + codex none → setRole(codex, reviewer) → claude-code becomes coder", () => {
    const before = { "claude-code": "reviewer", "codex": "none" };
    const after = applyRoleChange(before, "codex", "reviewer");
    expect(after).toEqual({ "claude-code": "coder", "codex": "reviewer" });
  });
});

describe("applyRoleChange — N=3 demotion-to-none (AC 14 bullet 3)", () => {
  // The proposal pins the N>2 branch even though the live UI today has N=2.
  // Hypothetical 3rd provider "cursor" holding reviewer forces the
  // displaced previous-coder to "none" because rOther is already taken.
  test("setRole(codex, coder) with claude-code coder + cursor reviewer + codex none → claude-code becomes none, cursor unchanged", () => {
    const before = { "claude-code": "coder", "codex": "none", "cursor": "reviewer" };
    const after = applyRoleChange(before, "codex", "coder");
    expect(after).toEqual({
      "claude-code": "none",
      "codex": "coder",
      "cursor": "reviewer",
    });
  });

  test("symmetric N=3 demotion: setRole(codex, reviewer) with claude-code reviewer + cursor coder + codex none → claude-code becomes none, cursor unchanged", () => {
    const before = { "claude-code": "reviewer", "codex": "none", "cursor": "coder" };
    const after = applyRoleChange(before, "codex", "reviewer");
    expect(after).toEqual({
      "claude-code": "none",
      "codex": "reviewer",
      "cursor": "coder",
    });
  });
});

describe("applyRoleChange — release to none (AC 6 / AC 14 bullet 4)", () => {
  test("setRole(claude-code, 'none') clears only claude-code; other provider unchanged", () => {
    const before = { "claude-code": "coder", "codex": "reviewer" };
    const after = applyRoleChange(before, "claude-code", "none");
    expect(after["claude-code"]).toBe("none");
    // Negative assertion at the persistent seam: the other provider's
    // role must not change. This guards against an accidental cascade
    // that back-fills the vacated coder slot.
    expect(after["codex"]).toBe("reviewer");
  });

  test("setRole on a 3-provider state with role=none does not displace anyone", () => {
    const before = { "claude-code": "coder", "codex": "reviewer", "cursor": "none" };
    const after = applyRoleChange(before, "claude-code", "none");
    expect(after).toEqual({
      "claude-code": "none",
      "codex": "reviewer",
      "cursor": "none",
    });
  });
});

describe("applyRoleChange — ≤1-coder / ≤1-reviewer invariant (AC 4 / AC 14 bullet 5)", () => {
  function countRoles(state: Record<string, string>) {
    let c = 0, r = 0;
    for (const v of Object.values(state)) {
      if (v === "coder") c++;
      else if (v === "reviewer") r++;
    }
    return { c, r };
  }

  const scenarios = [
    {
      name: "N=2 swap",
      before: { "claude-code": "coder", "codex": "reviewer" },
      args: ["codex", "coder"] as const,
    },
    {
      name: "N=2 promotion to vacant reviewer",
      before: { "claude-code": "coder", "codex": "none" },
      args: ["codex", "coder"] as const,
    },
    {
      name: "N=3 demotion to none",
      before: { "claude-code": "coder", "codex": "none", "cursor": "reviewer" },
      args: ["codex", "coder"] as const,
    },
    {
      name: "release to none",
      before: { "claude-code": "coder", "codex": "reviewer" },
      args: ["claude-code", "none"] as const,
    },
  ];

  for (const sc of scenarios) {
    test(`invariant holds after ${sc.name}`, () => {
      const after = applyRoleChange(sc.before, sc.args[0], sc.args[1]);
      const { c, r } = countRoles(after);
      expect(c).toBeLessThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(1);
    });
  }
});

describe("applyRoleChange — purity / non-mutation", () => {
  test("output is a fresh object (identity differs)", () => {
    const before = { "claude-code": "coder", "codex": "reviewer" };
    const after = applyRoleChange(before, "codex", "coder");
    expect(after).not.toBe(before);
  });

  test("input state is unchanged after the call (deep-equality)", () => {
    const before = { "claude-code": "coder", "codex": "reviewer" };
    const snapshot = JSON.parse(JSON.stringify(before));
    applyRoleChange(before, "codex", "coder");
    expect(before).toEqual(snapshot);
  });
});

describe("fromWireBody — null ↔ none mapping", () => {
  test("both providers covered; explicit roles round-trip", () => {
    expect(fromWireBody({ coder: "codex", reviewer: "claude-code" })).toEqual({
      "claude-code": "reviewer",
      "codex": "coder",
    });
  });

  test("nulls map to 'none' for unmentioned providers", () => {
    expect(fromWireBody({ coder: null, reviewer: "codex" })).toEqual({
      "claude-code": "none",
      "codex": "reviewer",
    });
  });

  test("both null → both none", () => {
    expect(fromWireBody({ coder: null, reviewer: null })).toEqual({
      "claude-code": "none",
      "codex": "none",
    });
  });
});

// ---------------------------------------------------------------------------
// createRoleSwitcherElement source-level pins (AC 1, AC 3, AC 12).
// Bun's test runtime has no DOM and we don't want to add a polyfill dep
// just for this test. The live HTTP smoke probe (AC 19) exercises the DOM
// construction end-to-end against a real browser-like fetcher; here we pin
// the source-level invariants that the DOM constructor must encode.
// ---------------------------------------------------------------------------

describe("role-switcher.js source-level pins (AC 1, AC 3, AC 12)", () => {
  let source = "";
  test("source file readable", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    source = readFileSync(join(__dirname, "role-switcher.js"), "utf-8");
    expect(source.length).toBeGreaterThan(0);
  });

  test("AC 12: 'Defaults for new sessions' label appears as rendered text and aria-label", () => {
    // Two distinct uses — aria-label (for screen readers) AND a visible
    // <span> textContent — both pinned to catch single-source removal.
    const occurrences = (source.match(/Defaults for new sessions/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(source).toContain('setAttribute("aria-label", "Defaults for new sessions")');
    expect(source).toMatch(/label\.textContent\s*=\s*"Defaults for new sessions"/);
  });

  test("AC 1: element class is 'role-switcher' and built via document.createElement", () => {
    expect(source).toMatch(/className\s*=\s*"role-switcher"/);
    expect(source).toMatch(/document\.createElement\("div"\)/);
  });

  test("AC 3: three buttons per provider with role values coder/reviewer/none, classed .role-btn with .active toggle", () => {
    expect(source).toContain('"coder", "reviewer", "none"');
    expect(source).toMatch(/btn\.className\s*=\s*"role-btn"/);
    expect(source).toMatch(/classList\.toggle\("active",/);
  });
});
