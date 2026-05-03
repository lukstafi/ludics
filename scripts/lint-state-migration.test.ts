import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTypeFields,
  loadSnapshot,
  writeSnapshot,
  buildSnapshot,
  checkShapes,
  parseDiff,
  locateFunctionBody,
  hasFunctionBodyDiff,
  findChangedTestFiles,
  enforceCoChange,
  enforceMigratorTestPairing,
  formatViolation,
  parseArgv,
  PERSISTED_TYPES,
  MIGRATOR_SITES,
  SNAPSHOT_PATH,
  type PersistedType,
  type ShapeViolation,
} from "./lint-state-migration.ts";

const repoRoot = join(import.meta.dir, "..");

function makeFixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join("/tmp", "lint-state-migration-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// extractTypeFields — regex-over-source extractor
// ---------------------------------------------------------------------------

describe("extractTypeFields", () => {
  test("pulls top-level fields from an exported interface", () => {
    const src = `export interface Foo {\n  a: string;\n  b: number;\n  c?: string;\n}\n`;
    expect(extractTypeFields(src, "Foo")).toEqual(["a", "b", "c"]);
  });

  test("pulls fields from a non-exported interface (TmuxSlotState shape)", () => {
    const src = `interface Foo {\n  a: string;\n  b: number;\n}\n`;
    expect(extractTypeFields(src, "Foo")).toEqual(["a", "b"]);
  });

  test("returns null when type is not present", () => {
    expect(extractTypeFields(`export interface Bar {\n  x: string;\n}`, "Foo")).toBeNull();
  });

  test("skips // line comments inside the body", () => {
    const src = `export interface Foo {\n  // a: string;\n  b: number;\n}\n`;
    expect(extractTypeFields(src, "Foo")).toEqual(["b"]);
  });

  test("skips JSDoc-style /* */ and * lines inside the body", () => {
    const src = [
      "export interface Foo {",
      "  /**",
      "   * docstring describing b — must not be picked up",
      "   * a: number;",
      "   */",
      "  b: number;",
      "}",
    ].join("\n");
    expect(extractTypeFields(src, "Foo")).toEqual(["b"]);
  });

  test("does NOT bleed nested-object members into the top-level field set", () => {
    // gh-ludics-479: regression for the OrchestrationState.staleBaseLastWarned
    // shape — `coder` and `reviewer` are nested members and must not appear
    // in the top-level extraction. Without this guard the lint would report
    // phantom fields.
    const src = [
      "export interface Foo {",
      "  outer: string;",
      "  staleBaseLastWarned?: {",
      "    coder?: { round: number; count: number };",
      "    reviewer?: { round: number; count: number };",
      "  };",
      "  trailing: number;",
      "}",
    ].join("\n");
    expect(extractTypeFields(src, "Foo")).toEqual(["outer", "staleBaseLastWarned", "trailing"]);
  });

  test("inline string-union RHS counts only the field name", () => {
    const src = `export interface Foo {\n  a: "x" | "y";\n  b: number;\n}\n`;
    expect(extractTypeFields(src, "Foo")).toEqual(["a", "b"]);
  });

  test("returns sorted output regardless of declaration order", () => {
    const src = `export interface Foo {\n  c: string;\n  a: number;\n  b: boolean;\n}\n`;
    expect(extractTypeFields(src, "Foo")).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// loadSnapshot / writeSnapshot — deterministic alphabetical ordering
// ---------------------------------------------------------------------------

describe("loadSnapshot / writeSnapshot", () => {
  test("round-trip preserves alphabetical key + value ordering regardless of input order", () => {
    const { root, cleanup } = makeFixture({});
    try {
      // Insert in reverse alpha to prove the writer sorts.
      writeSnapshot(root, {
        Zeta: ["zz", "aa", "mm"],
        Alpha: ["c", "a", "b"],
      });
      const text = readFileSync(join(root, SNAPSHOT_PATH), "utf-8");
      // Keys: Alpha before Zeta.
      expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Zeta"));
      const round = loadSnapshot(root)!;
      expect(Object.keys(round)).toEqual(["Alpha", "Zeta"]);
      expect(round.Alpha).toEqual(["a", "b", "c"]);
      expect(round.Zeta).toEqual(["aa", "mm", "zz"]);
      // Trailing newline (mirrors lint-vendor-sync snapshot conventions).
      expect(text.endsWith("\n")).toBe(true);
    } finally { cleanup(); }
  });

  test("returns null when snapshot is absent", () => {
    const { root, cleanup } = makeFixture({});
    try {
      expect(loadSnapshot(root)).toBeNull();
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// checkShapes — per-violation-kind detection
// ---------------------------------------------------------------------------

describe("checkShapes", () => {
  const types: ReadonlyArray<PersistedType> = [
    { typeName: "Foo", sourcePath: "src/foo.ts" },
  ];

  test("returns [] when source matches snapshot", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.ts": `export interface Foo {\n  a: string;\n  b: number;\n}\n`,
    });
    try {
      const violations = checkShapes(root, types, { Foo: ["a", "b"] });
      expect(violations).toEqual([]);
    } finally { cleanup(); }
  });

  test("emits field-added when source has a field the snapshot lacks", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.ts": `export interface Foo {\n  a: string;\n  b: number;\n  c: boolean;\n}\n`,
    });
    try {
      const violations = checkShapes(root, types, { Foo: ["a", "b"] });
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("field-added");
      expect(violations[0]!.fields).toEqual(["c"]);
      expect(violations[0]!.hint).toContain("c");
    } finally { cleanup(); }
  });

  test("emits field-removed when snapshot has a field the source lacks", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.ts": `export interface Foo {\n  a: string;\n}\n`,
    });
    try {
      const violations = checkShapes(root, types, { Foo: ["a", "b"] });
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("field-removed");
      expect(violations[0]!.fields).toEqual(["b"]);
      expect(violations[0]!.hint).toContain("b");
    } finally { cleanup(); }
  });

  test("emits both field-added and field-removed when both occur (rename)", () => {
    // Mirrors gh-ludics-409's staleBaseLastWarnedRound/Count → staleBaseLastWarned
    // rename: same diff drops two fields and adds one.
    const { root, cleanup } = makeFixture({
      "src/foo.ts": `export interface Foo {\n  staleBaseLastWarned?: object;\n}\n`,
    });
    try {
      const violations = checkShapes(root, types, {
        Foo: ["staleBaseLastWarnedCount", "staleBaseLastWarnedRound"],
      });
      const kinds = violations.map((v) => v.kind).sort();
      expect(kinds).toEqual(["field-added", "field-removed"]);
    } finally { cleanup(); }
  });

  test("emits type-missing when source lacks the type", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.ts": `export interface Bar {\n  x: string;\n}\n`,
    });
    try {
      const violations = checkShapes(root, types, { Foo: ["a"] });
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("type-missing");
    } finally { cleanup(); }
  });

  test("emits snapshot-missing-type for an allowlisted type absent from snapshot", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.ts": `export interface Foo {\n  a: string;\n}\n`,
    });
    try {
      const violations = checkShapes(root, types, {});
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("snapshot-missing-type");
      expect(violations[0]!.fields).toEqual(["a"]);
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// PERSISTED_TYPES + MIGRATOR_SITES sanity — point at real declarations.
// ---------------------------------------------------------------------------

describe("PERSISTED_TYPES + MIGRATOR_SITES", () => {
  test("every PERSISTED_TYPES entry resolves to a real source file with the named type", () => {
    for (const t of PERSISTED_TYPES) {
      const abs = join(repoRoot, t.sourcePath);
      expect(existsSync(abs)).toBe(true);
      const source = readFileSync(abs, "utf-8");
      expect(extractTypeFields(source, t.typeName)).not.toBeNull();
    }
  });

  test("every MIGRATOR_SITES entry's function exists in its source file", () => {
    for (const [typeName, site] of Object.entries(MIGRATOR_SITES)) {
      const abs = join(repoRoot, site.path);
      expect(existsSync(abs)).toBe(true);
      const source = readFileSync(abs, "utf-8");
      const pattern = new RegExp(`(?:export\\s+)?function\\s+${site.fnName}\\s*\\(`);
      expect(pattern.test(source)).toBe(true);
      // Each PERSISTED_TYPES entry has a MIGRATOR_SITES mapping.
      expect(PERSISTED_TYPES.find((t) => t.typeName === typeName)).toBeTruthy();
    }
  });

  test("source contains literal SILENT-DRIFT WARNING block (floor test for AC #5)", () => {
    const source = readFileSync(join(import.meta.dir, "lint-state-migration.ts"), "utf-8");
    expect(source).toContain("SILENT-DRIFT WARNING");
  });
});

// ---------------------------------------------------------------------------
// Diff parsing + function-body match
// ---------------------------------------------------------------------------

describe("parseDiff", () => {
  test("extracts file path and hunk lines from unified diff", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,0 +11 @@",
      "+  newField: string;",
      "",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files.length).toBe(1);
    expect(files[0]!.path).toBe("src/foo.ts");
    expect(files[0]!.hunks.length).toBe(1);
    expect(files[0]!.hunks[0]!.newStart).toBe(11);
    expect(files[0]!.hunks[0]!.lines.some((l) => l.includes("newField"))).toBe(true);
  });

  test("handles multiple files in a single diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -2 +2 @@",
      "+added",
      "",
    ].join("\n");
    const files = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("locateFunctionBody", () => {
  test("finds 1-based body range for a top-level export function", () => {
    const src = [
      "// header",
      "export function migrateState(state: State, slot: number): State {",
      "  state.foo = 'x';",
      "  return state;",
      "}",
      "",
    ].join("\n");
    const range = locateFunctionBody(src, "migrateState")!;
    expect(range.startLine).toBe(2);
    expect(range.endLine).toBe(5);
  });

  test("returns null when the function is absent", () => {
    expect(locateFunctionBody("function other() {}", "missing")).toBeNull();
  });
});

describe("hasFunctionBodyDiff", () => {
  test("returns true when a + line falls inside the function body range", () => {
    const src = [
      "function migrateState(s: State): State {",
      "  s.foo = 'x';",
      "  return s;",
      "}",
    ].join("\n");
    const diff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      "@@ -1,4 +1,5 @@",
      " function migrateState(s: State): State {",
      "+  s.bar ??= 1;",
      "   s.foo = 'x';",
      "   return s;",
      " }",
      "",
    ].join("\n");
    expect(hasFunctionBodyDiff(parseDiff(diff), "src/state.ts", "migrateState", src)).toBe(true);
  });

  test("returns false when the diff only touches lines outside the function body", () => {
    // Source has migrateState followed by a separate function `other`.
    const src = [
      "function migrateState(s: State): State {",
      "  return s;",
      "}",
      "function other() {",
      "  console.log('hi');",
      "}",
    ].join("\n");
    const diff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      "@@ -5,0 +5,1 @@",
      "+  console.log('extra');",
      "",
    ].join("\n");
    expect(hasFunctionBodyDiff(parseDiff(diff), "src/state.ts", "migrateState", src)).toBe(false);
  });

  test("returns true for a pure comment-line addition inside the body (AC #7 no-op convention)", () => {
    const src = [
      "function migrateState(s: State): State {",
      "  // gh-ludics-XXX: newField is additive — no legacy on-disk shape",
      "  return s;",
      "}",
    ].join("\n");
    const diff = [
      "diff --git a/src/state.ts b/src/state.ts",
      "--- a/src/state.ts",
      "+++ b/src/state.ts",
      "@@ -1,3 +1,4 @@",
      " function migrateState(s: State): State {",
      "+  // gh-ludics-XXX: newField is additive — no legacy on-disk shape",
      "   return s;",
      " }",
      "",
    ].join("\n");
    expect(hasFunctionBodyDiff(parseDiff(diff), "src/state.ts", "migrateState", src)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findChangedTestFiles + enforceCoChange
// ---------------------------------------------------------------------------

describe("findChangedTestFiles", () => {
  test("matches *.migrate*.test.ts and state*.test.ts", () => {
    const diff = [
      "diff --git a/src/orchestration/state.migrate.test.ts b/src/orchestration/state.migrate.test.ts",
      "+++ b/src/orchestration/state.migrate.test.ts",
      "@@ -0,0 +1 @@",
      "+test('migrate', () => {});",
      "diff --git a/src/orchestration/state.harnessdir.test.ts b/src/orchestration/state.harnessdir.test.ts",
      "+++ b/src/orchestration/state.harnessdir.test.ts",
      "@@ -0,0 +1 @@",
      "+test('h', () => {});",
      "diff --git a/src/unrelated.test.ts b/src/unrelated.test.ts",
      "+++ b/src/unrelated.test.ts",
      "@@ -0,0 +1 @@",
      "+test('u', () => {});",
      "",
    ].join("\n");
    const matches = findChangedTestFiles(parseDiff(diff));
    expect(matches).toContain("src/orchestration/state.migrate.test.ts");
    expect(matches).toContain("src/orchestration/state.harnessdir.test.ts");
  });

  test("matches a sibling test file in the same directory as a migrator site", () => {
    const diff = [
      "diff --git a/src/orchestration/random.test.ts b/src/orchestration/random.test.ts",
      "+++ b/src/orchestration/random.test.ts",
      "@@ -0,0 +1 @@",
      "+test('a', () => {});",
      "",
    ].join("\n");
    const matches = findChangedTestFiles(parseDiff(diff));
    // src/orchestration/state.ts is a migrator site; sibling file matches.
    expect(matches).toContain("src/orchestration/random.test.ts");
  });

  test("ignores changed files that are neither tests nor in a migrator-site dir", () => {
    const diff = [
      "diff --git a/scripts/foo.test.ts b/scripts/foo.test.ts",
      "+++ b/scripts/foo.test.ts",
      "@@ -0,0 +1 @@",
      "+test('a', () => {});",
      "",
    ].join("\n");
    expect(findChangedTestFiles(parseDiff(diff))).toEqual([]);
  });
});

describe("enforceCoChange", () => {
  const stateSrc = [
    "export function migrateState(state: State, slot: number): State {",
    "  return state;",
    "}",
  ].join("\n");

  const fooViolation: ShapeViolation = {
    kind: "field-added",
    typeName: "OrchestrationState",
    sourcePath: "src/orchestration/state.ts",
    fields: ["newField"],
    hint: "",
  };

  test("returns [] when both migrator body AND a test file are touched", () => {
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -1,3 +1,4 @@",
      " export function migrateState(state: State, slot: number): State {",
      "+  state.newField ??= true;",
      "   return state;",
      " }",
      "diff --git a/src/orchestration/state.migrate.test.ts b/src/orchestration/state.migrate.test.ts",
      "+++ b/src/orchestration/state.migrate.test.ts",
      "@@ -0,0 +1 @@",
      "+test('newField backfill', () => {});",
      "",
    ].join("\n");
    const co = enforceCoChange(
      [fooViolation],
      parseDiff(diff),
      (p) => p === "src/orchestration/state.ts" ? stateSrc.replace("return state;", "  state.newField ??= true;\n  return state;") : null,
    );
    expect(co).toEqual([]);
  });

  test("emits missing=test when only the migrator body is touched", () => {
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -1,3 +1,4 @@",
      " export function migrateState(state: State, slot: number): State {",
      "+  state.newField ??= true;",
      "   return state;",
      " }",
      "",
    ].join("\n");
    const co = enforceCoChange(
      [fooViolation],
      parseDiff(diff),
      (p) => p === "src/orchestration/state.ts" ? stateSrc.replace("return state;", "  state.newField ??= true;\n  return state;") : null,
    );
    expect(co.length).toBe(1);
    expect(co[0]!.missing).toBe("test");
  });

  test("emits missing=migrator when only a test file is touched", () => {
    const diff = [
      "diff --git a/src/orchestration/state.migrate.test.ts b/src/orchestration/state.migrate.test.ts",
      "+++ b/src/orchestration/state.migrate.test.ts",
      "@@ -0,0 +1 @@",
      "+test('newField backfill', () => {});",
      "",
    ].join("\n");
    const co = enforceCoChange([fooViolation], parseDiff(diff), () => stateSrc);
    expect(co.length).toBe(1);
    expect(co[0]!.missing).toBe("migrator");
  });

  test("emits missing=both when neither side is touched", () => {
    const co = enforceCoChange([fooViolation], [], () => stateSrc);
    expect(co.length).toBe(1);
    expect(co[0]!.missing).toBe("both");
  });

  test("MUTATION: function-name match is load-bearing (renamed migrator → still missing=migrator)", () => {
    // Same file is touched, but the body diff lands in migrateStateXYZ, NOT
    // in the actual migrator function. The lint must still report
    // "missing migrator" — proves the function-name match is what clears the
    // violation, not just a same-file edit.
    const renamedSrc = [
      "export function migrateState(state: State, slot: number): State {",
      "  return state;",
      "}",
      "export function migrateStateXYZ(state: State): State {",
      "  state.newField ??= true;",
      "  return state;",
      "}",
    ].join("\n");
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -4,0 +5,1 @@",
      "+  state.newField ??= true;",
      "diff --git a/src/orchestration/state.migrate.test.ts b/src/orchestration/state.migrate.test.ts",
      "+++ b/src/orchestration/state.migrate.test.ts",
      "@@ -0,0 +1 @@",
      "+test('newField backfill', () => {});",
      "",
    ].join("\n");
    const co = enforceCoChange([fooViolation], parseDiff(diff), () => renamedSrc);
    expect(co.length).toBe(1);
    expect(co[0]!.missing).toBe("migrator");
  });
});

// ---------------------------------------------------------------------------
// enforceMigratorTestPairing — reverse-direction asymmetry (proposal AC #9 —
// "migrator change with no test fixture" must fire even when shape is clean)
// ---------------------------------------------------------------------------

describe("enforceMigratorTestPairing", () => {
  const stateSrcAfterEdit = [
    "export function migrateState(state: State, slot: number): State {",
    "  state.foo = 'x';",  // body line that the diff hunk references
    "  return state;",
    "}",
  ].join("\n");

  test("emits missing=test when a migrator body is touched and no test file is touched", () => {
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -1,3 +1,4 @@",
      " export function migrateState(state: State, slot: number): State {",
      "+  state.foo = 'x';",
      "   return state;",
      " }",
      "",
    ].join("\n");
    const out = enforceMigratorTestPairing(parseDiff(diff), (p) =>
      p === "src/orchestration/state.ts" ? stateSrcAfterEdit : null,
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.missing).toBe("test");
    expect(out[0]!.migratorSite.fnName).toBe("migrateState");
    expect(out[0]!.hint).toContain("migrateState");
  });

  test("returns [] when migrator body is touched AND a test file is touched", () => {
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -1,3 +1,4 @@",
      " export function migrateState(state: State, slot: number): State {",
      "+  state.foo = 'x';",
      "   return state;",
      " }",
      "diff --git a/src/orchestration/state.migrate.test.ts b/src/orchestration/state.migrate.test.ts",
      "+++ b/src/orchestration/state.migrate.test.ts",
      "@@ -0,0 +1 @@",
      "+test('x', () => {});",
      "",
    ].join("\n");
    const out = enforceMigratorTestPairing(parseDiff(diff), (p) =>
      p === "src/orchestration/state.ts" ? stateSrcAfterEdit : null,
    );
    expect(out).toEqual([]);
  });

  test("returns [] when no migrator body is touched (refactor outside any MIGRATOR_SITES function)", () => {
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -100,0 +101 @@",
      "+const UNRELATED = 1;",
      "",
    ].join("\n");
    const out = enforceMigratorTestPairing(parseDiff(diff), (p) =>
      p === "src/orchestration/state.ts" ? stateSrcAfterEdit : null,
    );
    expect(out).toEqual([]);
  });

  test("dedupes by (path, fnName) — migrateState shared by two types emits one violation", () => {
    // OrchestrationState and OrchestrationConfig both map to migrateState in
    // src/orchestration/state.ts. A single body diff must produce ONE
    // violation, not two — otherwise the lint would double-count this case.
    const diff = [
      "diff --git a/src/orchestration/state.ts b/src/orchestration/state.ts",
      "+++ b/src/orchestration/state.ts",
      "@@ -1,3 +1,4 @@",
      " export function migrateState(state: State, slot: number): State {",
      "+  state.foo = 'x';",
      "   return state;",
      " }",
      "",
    ].join("\n");
    const out = enforceMigratorTestPairing(parseDiff(diff), (p) =>
      p === "src/orchestration/state.ts" ? stateSrcAfterEdit : null,
    );
    // Exactly one violation for migrateState, not two.
    const migrateStateHits = out.filter((v) => v.migratorSite.fnName === "migrateState");
    expect(migrateStateHits.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatViolation
// ---------------------------------------------------------------------------

describe("formatViolation", () => {
  test("field-added message names the type, source path, and field", () => {
    const msg = formatViolation({
      kind: "field-added",
      typeName: "OrchestrationState",
      sourcePath: "src/orchestration/state.ts",
      fields: ["newField"],
      hint: "Touch migrateState",
    });
    expect(msg).toContain("OrchestrationState");
    expect(msg).toContain("src/orchestration/state.ts");
    expect(msg).toContain("newField");
    expect(msg).toContain("field-added");
  });

  test("co-change-missing message names the migrator function and missing kind", () => {
    const msg = formatViolation({
      kind: "co-change-missing",
      typeName: "OrchestrationState",
      missing: "test",
      migratorSite: { path: "src/orchestration/state.ts", fnName: "migrateState" },
      hint: "Add a test",
    });
    expect(msg).toContain("co-change-missing");
    expect(msg).toContain("migrateState");
    expect(msg).toContain("test");
  });
});

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

describe("parseArgv", () => {
  test("--update flag is recognised regardless of position", () => {
    expect(parseArgv(["--update"], "/default").update).toBe(true);
    expect(parseArgv(["/tmp/root", "--update"], "/default")).toEqual({
      root: "/tmp/root", update: true, env: process.env,
    });
    expect(parseArgv(["--update", "/tmp/root"], "/default").root).toBe("/tmp/root");
  });

  test("first positional non-flag argv is the root override", () => {
    expect(parseArgv(["/tmp/x"], "/default").root).toBe("/tmp/x");
  });

  test("defaults to provided root when no positional given", () => {
    expect(parseArgv([], "/default").root).toBe("/default");
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive the real script
// ---------------------------------------------------------------------------

describe("CLI integration", () => {
  test("exits 0 against the live repo (proves checked-in snapshot is current)", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-state-migration.ts")],
      cwd: repoRoot, stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error("STDOUT:", result.stdout.toString());
      console.error("STDERR:", result.stderr.toString());
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("match the snapshot");
  });

  test("exits non-zero with named-field error when tmp fixture has unpaired drift", () => {
    // Build a real git tmp repo with a drifted source and no matching
    // migrator/test diff. Drift the snapshot to force a violation.
    const { root, cleanup } = makeFixture({
      "src/orchestration/state.ts": [
        "export function migrateState(state: any, slot: number) { return state; }",
        "export interface OrchestrationState {",
        "  slot: number;",
        "  newField: string;",  // ← extra field, snapshot doesn't have it
        "}",
        "export interface OrchestrationConfig { timeouts: object; }",
      ].join("\n"),
      "src/orchestration/deferred-cleanup.ts": [
        "export function loadDeferredCleanups() { return []; }",
        "export interface CleanupEntry { slot: number; }",
      ].join("\n"),
      "src/slots/preempt.ts": [
        "export function readStash() { return null; }",
        "export interface PreemptStash { slotNum: number; }",
      ].join("\n"),
      "src/sessions/sweep-state.ts": [
        "export function loadSessionSweepState() { return { version: 1, sessions: {} }; }",
        "export interface SessionSweepState { version: 1; sessions: object; }",
      ].join("\n"),
      "src/slots/types.ts": [
        "export interface SlotData { slot: number; }",
      ].join("\n"),
      "src/slots/json.ts": [
        "export function normalizeTaskId(s: string) { return s; }",
      ].join("\n"),
      "src/adapters/tmux-adapter.ts": [
        "export function readTmuxSlotState() { return null; }",
        "interface TmuxSlotState { slot: number; }",
      ].join("\n"),
      [SNAPSHOT_PATH]: JSON.stringify({
        OrchestrationState: ["slot"],  // missing newField → field-added
        OrchestrationConfig: ["timeouts"],
        CleanupEntry: ["slot"],
        PreemptStash: ["slotNum"],
        SessionSweepState: ["sessions", "version"],
        SlotData: ["slot"],
        TmuxSlotState: ["slot"],
      }, null, 2) + "\n",
    });
    try {
      // Initialize the fixture as a git repo with one base commit so
      // resolveBase / gitDiff can still execute (no merge-base resolves;
      // working-tree mode kicks in, returning empty diff → unpaired
      // co-change-missing).
      spawnSync({ cmd: ["git", "init", "-q"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "config", "user.email", "t@t.t"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "config", "user.name", "t"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "add", "-A"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "commit", "-q", "-m", "base"], cwd: root });

      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-state-migration.ts"), root],
        cwd: repoRoot, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_BASE: "" },
      });
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("OrchestrationState");
      expect(stderr).toContain("newField");
      expect(stderr).toContain("field-added");
    } finally { cleanup(); }
  });

  test("exits non-zero when migrator body is touched but no test diff (reverse-direction asymmetry)", () => {
    // Proposal AC: "migrator change with no test fixture" must exit 1 even
    // when the snapshot is clean. Build a real git fixture where the
    // committed source matches the snapshot (clean shape), then modify
    // migrateState's body in the working tree without touching any test
    // file. The lint must inspect the working-tree diff and fail.
    const baseSrc = [
      "export function migrateState(state: any, slot: number) { return state; }",
      "export interface OrchestrationState { slot: number; }",
      "export interface OrchestrationConfig { timeouts: object; }",
    ].join("\n");
    const { root, cleanup } = makeFixture({
      "src/orchestration/state.ts": baseSrc,
      "src/orchestration/deferred-cleanup.ts":
        "export function loadDeferredCleanups() { return []; }\nexport interface CleanupEntry { slot: number; }\n",
      "src/slots/preempt.ts":
        "export function readStash() { return null; }\nexport interface PreemptStash { slotNum: number; }\n",
      "src/sessions/sweep-state.ts":
        "export function loadSessionSweepState() { return { version: 1, sessions: {} }; }\nexport interface SessionSweepState {\n  version: 1;\n  sessions: object;\n}\n",
      "src/slots/types.ts": "export interface SlotData { slot: number; }\n",
      "src/slots/json.ts": "export function normalizeTaskId(s: string) { return s; }\n",
      "src/adapters/tmux-adapter.ts":
        "export function readTmuxSlotState() { return null; }\ninterface TmuxSlotState { slot: number; }\n",
      [SNAPSHOT_PATH]: JSON.stringify({
        OrchestrationState: ["slot"],
        OrchestrationConfig: ["timeouts"],
        CleanupEntry: ["slot"],
        PreemptStash: ["slotNum"],
        SessionSweepState: ["sessions", "version"],
        SlotData: ["slot"],
        TmuxSlotState: ["slot"],
      }, null, 2) + "\n",
    });
    try {
      // Init git, commit baseline.
      spawnSync({ cmd: ["git", "init", "-q"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "config", "user.email", "t@t.t"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "config", "user.name", "t"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "add", "-A"], cwd: root });
      const c1 = spawnSync({ cmd: ["git", "-C", root, "commit", "-q", "-m", "base"], cwd: root });
      expect(c1.exitCode).toBe(0);
      const baseSha = spawnSync({
        cmd: ["git", "-C", root, "rev-parse", "HEAD"], cwd: root, stdout: "pipe",
      }).stdout.toString().trim();
      // Modify ONLY the migrator body — no test file touched. Source still
      // declares the same field set, so the snapshot stays clean. The reverse
      // asymmetry is the only thing that can fire.
      writeFileSync(join(root, "src/orchestration/state.ts"), [
        "export function migrateState(state: any, slot: number) {",
        "  // gh-ludics-XXX: refactor — no field change",
        "  return state;",
        "}",
        "export interface OrchestrationState { slot: number; }",
        "export interface OrchestrationConfig { timeouts: object; }",
      ].join("\n"));

      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-state-migration.ts"), root],
        cwd: repoRoot, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_BASE: baseSha },
      });
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("migrateState");
      expect(stderr).toContain("co-change-missing");
      // Sanity: the message should NOT name a shape violation kind because
      // the snapshot was clean — only the migrator/test pairing fired.
      expect(stderr).not.toContain("field-added");
      expect(stderr).not.toContain("field-removed");
    } finally { cleanup(); }
  });

  test("exits 0 when migrator body is touched AND a test file is touched (paired reverse direction)", () => {
    // Symmetric companion to the previous test — proves the exit code in
    // the reverse direction is genuinely contingent on the test pairing,
    // not just on whether the snapshot is dirty.
    const baseSrc = [
      "export function migrateState(state: any, slot: number) { return state; }",
      "export interface OrchestrationState { slot: number; }",
      "export interface OrchestrationConfig { timeouts: object; }",
    ].join("\n");
    const { root, cleanup } = makeFixture({
      "src/orchestration/state.ts": baseSrc,
      "src/orchestration/state.migrate.test.ts":
        "import { test } from 'bun:test';\ntest('placeholder', () => {});\n",
      "src/orchestration/deferred-cleanup.ts":
        "export function loadDeferredCleanups() { return []; }\nexport interface CleanupEntry { slot: number; }\n",
      "src/slots/preempt.ts":
        "export function readStash() { return null; }\nexport interface PreemptStash { slotNum: number; }\n",
      "src/sessions/sweep-state.ts":
        "export function loadSessionSweepState() { return { version: 1, sessions: {} }; }\nexport interface SessionSweepState {\n  version: 1;\n  sessions: object;\n}\n",
      "src/slots/types.ts": "export interface SlotData { slot: number; }\n",
      "src/slots/json.ts": "export function normalizeTaskId(s: string) { return s; }\n",
      "src/adapters/tmux-adapter.ts":
        "export function readTmuxSlotState() { return null; }\ninterface TmuxSlotState { slot: number; }\n",
      [SNAPSHOT_PATH]: JSON.stringify({
        OrchestrationState: ["slot"],
        OrchestrationConfig: ["timeouts"],
        CleanupEntry: ["slot"],
        PreemptStash: ["slotNum"],
        SessionSweepState: ["sessions", "version"],
        SlotData: ["slot"],
        TmuxSlotState: ["slot"],
      }, null, 2) + "\n",
    });
    try {
      spawnSync({ cmd: ["git", "init", "-q"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "config", "user.email", "t@t.t"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "config", "user.name", "t"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "add", "-A"], cwd: root });
      spawnSync({ cmd: ["git", "-C", root, "commit", "-q", "-m", "base"], cwd: root });
      const baseSha = spawnSync({
        cmd: ["git", "-C", root, "rev-parse", "HEAD"], cwd: root, stdout: "pipe",
      }).stdout.toString().trim();
      // Touch migrator body AND the test file in the same working-tree edit.
      writeFileSync(join(root, "src/orchestration/state.ts"), [
        "export function migrateState(state: any, slot: number) {",
        "  // refactor",
        "  return state;",
        "}",
        "export interface OrchestrationState { slot: number; }",
        "export interface OrchestrationConfig { timeouts: object; }",
      ].join("\n"));
      writeFileSync(join(root, "src/orchestration/state.migrate.test.ts"),
        "import { test } from 'bun:test';\ntest('placeholder', () => {});\ntest('refactor', () => {});\n");

      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-state-migration.ts"), root],
        cwd: repoRoot, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_BASE: baseSha },
      });
      expect(result.exitCode).toBe(0);
    } finally { cleanup(); }
  });

  test("--update against a tmp fixture rewrites only that fixture's snapshot (path isolation)", () => {
    // Capture the live snapshot's bytes BEFORE the test runs.
    const livePath = join(repoRoot, SNAPSHOT_PATH);
    const liveBefore = readFileSync(livePath);
    const { root, cleanup } = makeFixture({
      "src/orchestration/state.ts": [
        "export function migrateState() {}",
        "export interface OrchestrationState {",
        "  slot: number;",
        "  phase: string;",
        "}",
        "export interface OrchestrationConfig {",
        "  timeouts: object;",
        "}",
      ].join("\n"),
      "src/orchestration/deferred-cleanup.ts":
        "export function loadDeferredCleanups() {}\nexport interface CleanupEntry { slot: number; }\n",
      "src/slots/preempt.ts":
        "export function readStash() {}\nexport interface PreemptStash { slotNum: number; }\n",
      "src/sessions/sweep-state.ts":
        "export function loadSessionSweepState() {}\nexport interface SessionSweepState { version: 1; }\n",
      "src/slots/types.ts": "export interface SlotData { slot: number; }\n",
      "src/slots/json.ts": "export function normalizeTaskId() {}\n",
      "src/adapters/tmux-adapter.ts":
        "export function readTmuxSlotState() {}\ninterface TmuxSlotState { slot: number; }\n",
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-state-migration.ts"), root, "--update"],
        cwd: repoRoot, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      // Tmp fixture's snapshot was written with the synthetic field set.
      const fixtureSnap = JSON.parse(readFileSync(join(root, SNAPSHOT_PATH), "utf-8"));
      expect(fixtureSnap.OrchestrationState).toEqual(["phase", "slot"]);
      // Live repo's snapshot is byte-identical to before (no clobber).
      const liveAfter = readFileSync(livePath);
      expect(liveAfter.equals(liveBefore)).toBe(true);
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot — bootstrapping
// ---------------------------------------------------------------------------

describe("buildSnapshot", () => {
  test("captures field sets from the live repo for every PERSISTED_TYPES entry", () => {
    const snap = buildSnapshot(repoRoot);
    for (const t of PERSISTED_TYPES) {
      expect(snap[t.typeName]).toBeTruthy();
      expect(Array.isArray(snap[t.typeName])).toBe(true);
      expect(snap[t.typeName]!.length).toBeGreaterThan(0);
    }
  });
});
