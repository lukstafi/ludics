// task-b43bd578 — pure-cascade unit tests for role-switcher.js.
// AC 14 names this transformation and pins its behaviour independently
// of the DOM.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyRoleChange, createInFlightSequencer, createRoleSwitcherElement, fromWireBody, HIGH_END_CLASSES, PROVIDERS, ROLES, roleHeldByClaudeCode, toWireBody } from "./role-switcher.js";

describe("PROVIDERS (browser-side copy)", () => {
  test("lists exactly claude-code and codex (in this order)", () => {
    expect([...PROVIDERS]).toEqual(["claude-code", "codex"]);
  });
});

describe("ROLES (browser-side copy)", () => {
  test("lists exactly coder and reviewer (in this order)", () => {
    expect([...ROLES]).toEqual(["coder", "reviewer"]);
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
// createRoleSwitcherElement (AC 1, AC 3). Bun's test runtime has no DOM; rather
// than a polyfill dep, a minimal hand-rolled `document` stub (below, in the
// task-13dee93b class sub-select describe) drives the DOM constructor directly.
// The live HTTP smoke probe (AC 19) exercises construction end-to-end against a
// real browser-like fetcher.
//
// AC 12 (pre-redesign) pinned a "Defaults for new sessions" label. That label
// was removed in the per-role-select redesign; the assertion was dropped
// rather than carried as a stale pin.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createInFlightSequencer — pins the stale-response guard. Addresses the
// Codex P2 review on PR #523: without sequencing, an older POST response
// can resolve after a newer click and overwrite the newer state. The
// sequencer is per-instance (so multiple role-switcher elements don't
// share state) and monotonic.
// ---------------------------------------------------------------------------

describe("createInFlightSequencer — stale-response guard", () => {
  test("issues monotonically increasing ids", () => {
    const seq = createInFlightSequencer();
    expect(seq.begin()).toBe(1);
    expect(seq.begin()).toBe(2);
    expect(seq.begin()).toBe(3);
  });

  test("isLatest is true only for the most recently issued id", () => {
    const seq = createInFlightSequencer();
    const a = seq.begin();
    const b = seq.begin();
    expect(seq.isLatest(a)).toBe(false);
    expect(seq.isLatest(b)).toBe(true);
  });

  test("isLatest of an unissued id is false", () => {
    const seq = createInFlightSequencer();
    expect(seq.isLatest(999)).toBe(false);
    seq.begin();
    expect(seq.isLatest(999)).toBe(false);
  });

  test("each instance has its own counter (no shared module-level state)", () => {
    const a = createInFlightSequencer();
    const b = createInFlightSequencer();
    expect(a.begin()).toBe(1);
    expect(b.begin()).toBe(1);
    expect(a.begin()).toBe(2);
    // b's counter unaffected by a's increments.
    expect(b.begin()).toBe(2);
  });

  test("out-of-order resolution scenario: older click's response is dropped after newer click started", () => {
    // Simulates the bug Codex flagged. Two clicks fire in order; their
    // POST responses resolve out of order (older response arrives last).
    const seq = createInFlightSequencer();
    const click1 = seq.begin();        // user clicks button A
    const click2 = seq.begin();        // user clicks button B before A's POST resolves
    // POST for click2 resolves first (newer wins).
    expect(seq.isLatest(click2)).toBe(true);
    // POST for click1 resolves second — handler must drop it.
    expect(seq.isLatest(click1)).toBe(false);
  });
});

describe("role-switcher.js source-level pins (AC 1, AC 3)", () => {
  let source = "";
  test("source file readable", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    source = readFileSync(join(__dirname, "role-switcher.js"), "utf-8");
    expect(source.length).toBeGreaterThan(0);
  });

  test("AC 1: element class is 'role-switcher' and built via document.createElement", () => {
    expect(source).toMatch(/className\s*=\s*"role-switcher"/);
    expect(source).toMatch(/document\.createElement\("div"\)/);
  });

  test("AC 3 (post-redesign): one <select> per role, classed .role-select, with C:/R: prefixes", () => {
    // Two selects, one per role, each with three options (— + two providers).
    expect(source).toMatch(/document\.createElement\("select"\)/);
    expect(source).toMatch(/sel\.className\s*=\s*"role-select"/);
    // C: / R: prefixes are the user-visible mnemonic for which dropdown is which.
    expect(source).toContain('coder: "C"');
    expect(source).toContain('reviewer: "R"');
    // The none option uses an em-dash so the prefix still reads naturally.
    expect(source).toMatch(/`\$\{prefix\}: —`/);
    // aria-label per select keeps screen-reader semantics after the section
    // label was dropped.
    expect(source).toContain('role === "coder" ? "Coder" : "Reviewer"');
  });

  test("handleChange guards both success AND failure paths with sequencer.isLatest", () => {
    // Codex P2 fix carried over from the button era: rapid changes resolve
    // out of order; older responses (success or thrown error) must be
    // dropped. Pin both arms so a partial revert can't silently regress
    // the failure path.
    const matches = source.match(/if \(!sequencer\.isLatest\(myId\)\) return;/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // Must obtain its myId BEFORE awaiting onSubmit.
    expect(source).toMatch(/const myId\s*=\s*sequencer\.begin\(\);\s*\n\s*try\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// task-13dee93b — per-role high-end class sub-select (pure, DOM-independent).
// ---------------------------------------------------------------------------

describe("HIGH_END_CLASSES (browser-side copy)", () => {
  test("is exactly opus + fable, and PROVIDERS is unchanged (AC7)", () => {
    expect([...HIGH_END_CLASSES]).toEqual(["claude-opus", "claude-fable"]);
    // The class choice must NOT have leaked into the provider universe.
    expect([...PROVIDERS]).toEqual(["claude-code", "codex"]);
  });
});

describe("roleHeldByClaudeCode — class sub-select enablement rule", () => {
  test("true only when claude-code holds that role", () => {
    const state = { "claude-code": "coder", "codex": "reviewer" };
    expect(roleHeldByClaudeCode("coder", state)).toBe(true);
    expect(roleHeldByClaudeCode("reviewer", state)).toBe(false); // codex holds reviewer
  });

  test("false when the role is held by codex or is vacant", () => {
    expect(roleHeldByClaudeCode("coder", { "claude-code": "none", "codex": "coder" })).toBe(false);
    expect(roleHeldByClaudeCode("reviewer", { "claude-code": "coder", "codex": "none" })).toBe(false);
  });
});

describe("toWireBody — carries provider state + class fields", () => {
  test("emits provider nulls + both class fields", () => {
    const state = { "claude-code": "coder", "codex": "reviewer" };
    const body = toWireBody(state, { coder: "claude-fable", reviewer: "claude-opus" });
    expect(body).toEqual({
      coder: "claude-code",
      reviewer: "codex",
      coderClass: "claude-fable",
      reviewerClass: "claude-opus",
    });
  });

  test("defaults absent/invalid class values to claude-opus (preserves the choice across reload)", () => {
    const state = { "claude-code": "none", "codex": "none" };
    expect(toWireBody(state, {})).toEqual({
      coder: null,
      reviewer: null,
      coderClass: "claude-opus",
      reviewerClass: "claude-opus",
    });
    expect(toWireBody(state, { coder: "bogus" }).coderClass).toBe("claude-opus");
  });
});

// ---------------------------------------------------------------------------
// task-13dee93b AC4 — DOM-level test of the class sub-select interaction.
// Bun has no DOM; a minimal hand-rolled `document` stub records change
// listeners so we can drive the sub-select end-to-end. This enforces the GUI
// invariant: a user can pick Opus/Fable from the role-switcher and have that
// choice submitted (a future edit removing the sub-select or disconnecting its
// change handler would fail here, not silently pass the pure-helper tests).
// ---------------------------------------------------------------------------

function makeFakeEl(tagName: string): any {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    tagName,
    className: "",
    dataset: {} as Record<string, string>,
    children: [] as any[],
    value: "",
    disabled: false,
    textContent: "",
    _attrs: {} as Record<string, string>,
    appendChild(c: any) { this.children.push(c); return c; },
    setAttribute(k: string, v: string) { this._attrs[k] = v; },
    removeAttribute(k: string) { delete this._attrs[k]; },
    getAttribute(k: string) { return this._attrs[k]; },
    addEventListener(t: string, cb: () => void) { (listeners[t] ||= []).push(cb); },
    dispatch(t: string) { (listeners[t] || []).forEach((cb) => cb()); },
  };
}

function findChild(root: any, className: string, role: string): any {
  return root.children.find((c: any) => c.className === className && c.dataset.role === role);
}

describe("createRoleSwitcherElement — class sub-select DOM interaction (AC4)", () => {
  let prevDoc: unknown;
  beforeEach(() => {
    prevDoc = (globalThis as any).document;
    (globalThis as any).document = { createElement: (tag: string) => makeFakeEl(tag) };
  });
  afterEach(() => {
    (globalThis as any).document = prevDoc;
  });

  test("coder class-select is enabled + set to the initial class; codex-held reviewer's is disabled", () => {
    const root = createRoleSwitcherElement(
      { "claude-code": "coder", "codex": "reviewer" },
      () => Promise.resolve({}),
      { coder: "claude-opus" },
    );
    const coderClassSel = findChild(root, "class-select", "coder");
    const reviewerClassSel = findChild(root, "class-select", "reviewer");
    expect(coderClassSel).toBeTruthy();
    expect(coderClassSel.disabled).toBe(false); // claude-code holds coder
    expect(coderClassSel.value).toBe("claude-opus");
    // reviewer is held by codex → its class sub-select is disabled (meaningless).
    expect(reviewerClassSel.disabled).toBe(true);
  });

  test("changing the coder class-select to claude-fable submits coderClass with the provider state", async () => {
    let captured: any = null;
    const onSubmit = (body: any) => { captured = body; return Promise.resolve(body); };
    const root = createRoleSwitcherElement(
      { "claude-code": "coder", "codex": "reviewer" },
      onSubmit,
      { coder: "claude-opus", reviewer: "claude-opus" },
    );
    const coderClassSel = findChild(root, "class-select", "coder");

    // User picks Fable and the select fires `change`.
    coderClassSel.value = "claude-fable";
    coderClassSel.dispatch("change");
    // onSubmit is invoked synchronously inside the handler (before its await),
    // but await a tick for robustness against future refactors.
    await Promise.resolve();

    expect(captured).not.toBeNull();
    expect(captured.coderClass).toBe("claude-fable"); // the GUI choice was submitted
    // The existing provider role-state rides along in the same POST body.
    expect(captured.coder).toBe("claude-code");
    expect(captured.reviewer).toBe("codex");
    expect(captured.reviewerClass).toBe("claude-opus"); // untouched
  });
});
