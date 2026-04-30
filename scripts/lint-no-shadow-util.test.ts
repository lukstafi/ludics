import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  extractCanonicalNames,
  findShadowsInFile,
  runCli,
} from "./lint-no-shadow-util.ts";

// ---------------------------------------------------------------------------
// extractCanonicalNames — dynamic name discovery from util.ts source
// ---------------------------------------------------------------------------

describe("extractCanonicalNames", () => {
  test("returns the seven canonical names from a synthetic util.ts", () => {
    const src = [
      'import { existsSync } from "fs";',
      'export { readJsonFile, writeJsonFile } from "../json.ts";',
      "",
      "export function isoNow(): string { return ''; }",
      "export function nowEpoch(): number { return 0; }",
      "export function makeId(prefix: string): string { return prefix; }",
      "export function slugify(value: string): string { return value; }",
      "export function ludicsSelfCommand(args: string[]): string[] { return args; }",
      "export function sleepMs(ms: number): Promise<void> { return Promise.resolve(); }",
      "export function setsidWrap(command: string[]): string[] { return command; }",
    ].join("\n");
    const names = extractCanonicalNames(src);
    expect(names).toEqual(
      new Set([
        "isoNow",
        "nowEpoch",
        "makeId",
        "slugify",
        "ludicsSelfCommand",
        "sleepMs",
        "setsidWrap",
      ]),
    );
  });

  test("ignores `export { ... } from` re-exports", () => {
    const src = [
      'export { readJsonFile, writeJsonFile } from "../json.ts";',
      "export function isoNow(): string { return ''; }",
    ].join("\n");
    const names = extractCanonicalNames(src);
    expect(names).toEqual(new Set(["isoNow"]));
    // Critically, `readJsonFile` and `writeJsonFile` are NOT picked up — they
    // would over-flag every consumer if they were.
    expect(names.has("readJsonFile")).toBe(false);
  });

  test("dynamic discovery picks up an eighth helper added later", () => {
    const src = [
      "export function isoNow(): string { return ''; }",
      "export function newHelper(): void {}",
    ].join("\n");
    const names = extractCanonicalNames(src);
    expect(names.has("newHelper")).toBe(true);
  });

  test("dynamic discovery picks up `export async function` helpers", () => {
    // Without the `async` arm, an `export async function` added to util.ts
    // would silently fall out of the canonical set — duplicates of it
    // elsewhere would not be flagged. This test pins the async arm so a
    // future regex narrowing would fail here.
    const src = [
      "export function isoNow(): string { return ''; }",
      "export async function fetchSomething(): Promise<void> {}",
    ].join("\n");
    const names = extractCanonicalNames(src);
    expect(names.has("fetchSomething")).toBe(true);
  });

  test("does not match indented or method-form definitions", () => {
    const src = [
      "  export function notAtStart(): void {}", // leading spaces — not a top-level export
      "obj.isoNow = function (): string { return ''; };",
      "const slugify = (value: string) => value;",
    ].join("\n");
    expect(extractCanonicalNames(src).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findShadowsInFile — per-file scan
// ---------------------------------------------------------------------------

describe("findShadowsInFile", () => {
  const names = new Set(["isoNow", "makeId"]);

  test("flags `function isoNow(`", () => {
    const src = [
      "// header",
      "function isoNow(): string {",
      "  return '';",
      "}",
    ].join("\n");
    expect(findShadowsInFile(src, names)).toEqual([{ line: 2, name: "isoNow" }]);
  });

  test("flags `export function makeId(` (export prefix)", () => {
    const src = "export function makeId(p: string): string { return p; }";
    expect(findShadowsInFile(src, names)).toEqual([{ line: 1, name: "makeId" }]);
  });

  test("does NOT flag method-form `obj.isoNow = function`", () => {
    const src = "obj.isoNow = function (): string { return ''; };";
    expect(findShadowsInFile(src, names)).toEqual([]);
  });

  test("does NOT flag commented-out `// function isoNow(`", () => {
    const src = "// function isoNow(): string { return ''; }";
    expect(findShadowsInFile(src, names)).toEqual([]);
  });

  test("does NOT flag call sites `isoNow()`", () => {
    const src = "const t = isoNow();";
    expect(findShadowsInFile(src, names)).toEqual([]);
  });

  test("does NOT flag arrow-form `const isoNow = () =>`", () => {
    const src = "const isoNow = (): string => '';";
    expect(findShadowsInFile(src, names)).toEqual([]);
  });

  test("does NOT flag a function whose name is not in the canonical set", () => {
    const src = "function helper(): void {}";
    expect(findShadowsInFile(src, names)).toEqual([]);
  });

  test("flags multiple shadows in the same file", () => {
    const src = [
      "function isoNow(): string { return ''; }",
      "function makeId(p: string): string { return p; }",
    ].join("\n");
    expect(findShadowsInFile(src, names)).toEqual([
      { line: 1, name: "isoNow" },
      { line: 2, name: "makeId" },
    ]);
  });

  test("flags an INDENTED shadow (inside another scope or just formatted with indent)", () => {
    // Without leading-whitespace tolerance, a redefinition could bypass the
    // rule by simply indenting the line — e.g., wrapping it inside another
    // function. This test pins the `^\s*` tolerance.
    const src = [
      "function outer() {",
      "  function isoNow(): string { return 'shadow'; }",
      "  return isoNow();",
      "}",
    ].join("\n");
    expect(findShadowsInFile(src, names)).toEqual([
      { line: 2, name: "isoNow" },
    ]);
  });

  test("flags an `async function` shadow (canonical name matched ignoring async modifier)", () => {
    // Names like `fetchSomething` could legitimately be added as async
    // helpers in util.ts; the shadow scan must accept the `async` modifier
    // for parity with extractCanonicalNames.
    const namesAsync = new Set(["fetchSomething"]);
    const src = "async function fetchSomething(): Promise<void> {}";
    expect(findShadowsInFile(src, namesAsync)).toEqual([
      { line: 1, name: "fetchSomething" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// runCli — end-to-end on a temp tree
// ---------------------------------------------------------------------------

function makeTempTree(): string {
  return mkdtempSync("/tmp/lint-no-shadow-util-");
}

function writeUtil(srcDir: string): string {
  const utilDir = join(srcDir, "orchestration");
  mkdirSync(utilDir, { recursive: true });
  const utilPath = join(utilDir, "util.ts");
  const utilSource = [
    "export function isoNow(): string {",
    "  return new Date().toISOString();",
    "}",
    "",
    "export function makeId(prefix: string): string {",
    "  return prefix;",
    "}",
    "",
  ].join("\n");
  writeFileSync(utilPath, utilSource);
  return utilPath;
}

describe("runCli", () => {
  test("exits 0 on a clean tree (only util.ts defines the helpers)", () => {
    const root = makeTempTree();
    try {
      const srcDir = join(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const utilPath = writeUtil(srcDir);
      mkdirSync(join(srcDir, "consumer"), { recursive: true });
      writeFileSync(
        join(srcDir, "consumer", "uses-util.ts"),
        [
          'import { isoNow } from "../orchestration/util.ts";',
          "export const x = isoNow();",
        ].join("\n"),
      );

      const errs: string[] = [];
      const outs: string[] = [];
      const result = runCli({
        srcDir,
        utilPath,
        repoRoot: root,
        writeErr: (m) => errs.push(m),
        writeOut: (m) => outs.push(m),
      });
      expect(result.exitCode).toBe(0);
      expect(result.offenseCount).toBe(0);
      expect(result.issues).toEqual([]);
      expect(errs).toEqual([]);
      expect(outs.length).toBe(1);
      expect(outs[0]!).toMatch(/✅/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exits 1 with path:line on a planted shadow", () => {
    const root = makeTempTree();
    try {
      const srcDir = join(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const utilPath = writeUtil(srcDir);
      mkdirSync(join(srcDir, "rogue"), { recursive: true });
      writeFileSync(
        join(srcDir, "rogue", "shadow.ts"),
        [
          "// some comment",
          "function isoNow(): string {",
          "  return 'fake';",
          "}",
          "export const x = isoNow();",
        ].join("\n"),
      );

      const errs: string[] = [];
      const outs: string[] = [];
      const result = runCli({
        srcDir,
        utilPath,
        repoRoot: root,
        writeErr: (m) => errs.push(m),
        writeOut: (m) => outs.push(m),
      });
      expect(result.exitCode).toBe(1);
      expect(result.offenseCount).toBe(1);
      expect(result.issues).toEqual([
        { file: "src/rogue/shadow.ts", line: 2, name: "isoNow" },
      ]);
      // Offense line must include `path:line` and the canonical name.
      const offenseMessage = errs.find((m) => m.includes("src/rogue/shadow.ts:2"));
      expect(offenseMessage).toBeDefined();
      expect(offenseMessage!).toContain("isoNow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes util.ts itself (otherwise it would self-flag)", () => {
    const root = makeTempTree();
    try {
      const srcDir = join(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const utilPath = writeUtil(srcDir);

      const result = runCli({
        srcDir,
        utilPath,
        repoRoot: root,
        writeErr: () => {},
        writeOut: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.issues).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes *.test.ts files (fixtures legitimately redefine helpers)", () => {
    const root = makeTempTree();
    try {
      const srcDir = join(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const utilPath = writeUtil(srcDir);
      mkdirSync(join(srcDir, "consumer"), { recursive: true });
      writeFileSync(
        join(srcDir, "consumer", "fixture.test.ts"),
        [
          "function isoNow(): string {",
          "  return 'fixture-stub';",
          "}",
          "export const stub = isoNow;",
        ].join("\n"),
      );

      const result = runCli({
        srcDir,
        utilPath,
        repoRoot: root,
        writeErr: () => {},
        writeOut: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.issues).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags multiple offenses across multiple files", () => {
    const root = makeTempTree();
    try {
      const srcDir = join(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const utilPath = writeUtil(srcDir);
      mkdirSync(join(srcDir, "a"), { recursive: true });
      mkdirSync(join(srcDir, "b"), { recursive: true });
      writeFileSync(
        join(srcDir, "a", "f.ts"),
        "function isoNow(): string { return ''; }\n",
      );
      writeFileSync(
        join(srcDir, "b", "g.ts"),
        "function makeId(p: string): string { return p; }\n",
      );

      const result = runCli({
        srcDir,
        utilPath,
        repoRoot: root,
        writeErr: () => {},
        writeOut: () => {},
      });
      expect(result.exitCode).toBe(1);
      expect(result.offenseCount).toBe(2);
      expect(result.issues.map((i) => i.file).sort()).toEqual([
        "src/a/f.ts",
        "src/b/g.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
