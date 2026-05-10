import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import {
  IN_SCOPE_GLOBS,
  collectInScopeFiles,
  countTriggerRows,
  findDescribeBlocks,
  findMatchingBrace,
  findSpawnIndices,
  findTriggers,
  hasPragmaAbove,
  lintCorpus,
  lintFile,
  spawnCoversTrigger,
} from "./lint-test-spawn-coverage.ts";

const root = join(import.meta.dir, "..");

// The lint scans `scripts/*.test.ts` — including this file. To prevent the
// synthetic-source fixtures below from being seen as real triggers when the
// lint reads this file's bytes, we interpolate the keywords from uppercase
// constants. The trigger regex is case-sensitive and matches lowercase
// `test|it` only, so `${TEST}(...` in the source bytes does NOT match,
// while at runtime the strings resolve to lowercase `test(...` for the
// recognizer to find as intended. (Without this, the live-corpus assertion
// would fail with dozens of self-induced violations.)
const TEST = "test";
const IT = "it";

// ---------------------------------------------------------------------------
// IN_SCOPE_GLOBS — single literal, scoped to scripts/*.test.ts only
// ---------------------------------------------------------------------------

describe("IN_SCOPE_GLOBS", () => {
  test("is exactly scripts/*.test.ts (no src/, templates/, docs/ extension)", () => {
    expect(IN_SCOPE_GLOBS).toEqual(["scripts/*.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// findMatchingBrace — balanced-brace walker (skips strings, templates, comments)
// ---------------------------------------------------------------------------

describe("findMatchingBrace", () => {
  test("finds the matching `}` for a flat block", () => {
    const src = "x = { foo: 1 }";
    const start = src.indexOf("{");
    expect(findMatchingBrace(src, start)).toBe(src.lastIndexOf("}"));
  });

  test("skips `{` / `}` inside double-quoted strings", () => {
    const src = 'x = { s: "{not a brace}" }';
    const start = src.indexOf("{");
    expect(findMatchingBrace(src, start)).toBe(src.length - 1);
  });

  test("skips `{` / `}` inside template literals (and substitution interiors)", () => {
    const src = "x = { s: `${a}` }";
    const start = src.indexOf("{");
    expect(findMatchingBrace(src, start)).toBe(src.length - 1);
  });

  test("skips `{` / `}` inside line and block comments", () => {
    const src = "x = { // }\n /* } */ y: 1 }";
    const start = src.indexOf("{");
    expect(findMatchingBrace(src, start)).toBe(src.length - 1);
  });

  test("returns -1 when startIdx is not `{`", () => {
    expect(findMatchingBrace("abc", 0)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// findDescribeBlocks — describe(…) callsite discovery
// ---------------------------------------------------------------------------

describe("findDescribeBlocks", () => {
  test("locates a single describe block with body offsets", () => {
    const src = ['describe("a", () => {', "  const x = 1;", "});"].join("\n");
    const blocks = findDescribeBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(src[blocks[0]!.bodyStart]).toBe("{");
    expect(src[blocks[0]!.bodyEnd]).toBe("}");
  });

  test("locates nested describes (each registered separately)", () => {
    const src = [
      'describe("outer", () => {',
      '  describe("inner", () => {',
      "    const x = 1;",
      "  });",
      "});",
    ].join("\n");
    const blocks = findDescribeBlocks(src);
    expect(blocks).toHaveLength(2);
    const [first, second] = blocks;
    const outer = first!.bodyEnd > second!.bodyEnd ? first! : second!;
    const inner = outer === first ? second! : first!;
    expect(outer.bodyStart < inner.bodyStart).toBe(true);
    expect(outer.bodyEnd > inner.bodyEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findTriggers — recognizer narrowness
// ---------------------------------------------------------------------------

describe("findTriggers — Q2 narrowness", () => {
  test(`recognizes ${TEST}("exits 0|1|non-zero …")`, () => {
    const src = [
      `${TEST}("exits 0 on a clean tree", () => {});`,
      `${TEST}("exits 1 with a violation", () => {});`,
      `${TEST}("exits non-zero on bad input", () => {});`,
    ].join("\n");
    const triggers = findTriggers(src);
    expect(triggers).toHaveLength(3);
    expect(triggers.map((t) => t.testName)).toEqual([
      "exits 0 on a clean tree",
      "exits 1 with a violation",
      "exits non-zero on bad input",
    ]);
  });

  test(`recognizes ${IT}("exits 0 …") alongside test (Q4 alias)`, () => {
    const src = `${IT}("exits 0 against an empty fixture", () => {});`;
    const triggers = findTriggers(src);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.testName).toBe("exits 0 against an empty fixture");
  });

  test(`does NOT recognize "exits after grace window …" (no leading numeric)`, () => {
    // Mutation evidence: if the recognizer were widened to `exits\s+\w+`,
    // this assertion fires. Falsifies the runner.lifecycle false-positive
    // class structurally.
    const src = `${TEST}("exits after grace window when tmux sibling state is missing", () => {});`;
    expect(findTriggers(src)).toEqual([]);
  });

  test(`does NOT recognize "exits early when …"`, () => {
    const src = `${TEST}("exits early when t3code sibling state has a mismatched PID", () => {});`;
    expect(findTriggers(src)).toEqual([]);
  });

  test(`does NOT recognize "returns exit 0 …" synonym (intentional narrow scope)`, () => {
    const src = `${TEST}("returns exit 0 against an empty fixture", () => {});`;
    expect(findTriggers(src)).toEqual([]);
  });

  test(`does NOT recognize "fails CI when …" synonym`, () => {
    const src = `${TEST}("fails CI when descriptor is missing", () => {});`;
    expect(findTriggers(src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findSpawnIndices — Q3 allowlist
// ---------------------------------------------------------------------------

describe("findSpawnIndices — Q3 allowlist", () => {
  test("matches Bun.spawnSync(", () => {
    expect(findSpawnIndices("const p = Bun.spawnSync({});")).toHaveLength(1);
  });

  test("matches Bun.spawn( (async form)", () => {
    expect(findSpawnIndices("const p = Bun.spawn({});")).toHaveLength(1);
  });

  test("matches Bun.$", () => {
    expect(findSpawnIndices("await Bun.$`ls`;")).toHaveLength(1);
  });

  test("matches execFileSync(", () => {
    expect(findSpawnIndices("execFileSync('git', []);")).toHaveLength(1);
  });

  test("matches execSync(", () => {
    expect(findSpawnIndices("execSync('git status');")).toHaveLength(1);
  });

  test("matches standalone spawnSync( (Node-style import)", () => {
    expect(
      findSpawnIndices(
        'import { spawnSync } from "child_process";\nspawnSync("ls", []);',
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("matches standalone spawn( (Node-style import)", () => {
    expect(
      findSpawnIndices(
        'import { spawn } from "child_process";\nspawn("ls", []);',
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// hasPragmaAbove — escape-hatch logic
// ---------------------------------------------------------------------------

describe("hasPragmaAbove", () => {
  test("returns true when pragma is on the line immediately above", () => {
    const src = [
      "// lint:allow-no-spawn",
      `${TEST}("exits 1 when foo", () => {});`,
    ].join("\n");
    const idx = src.indexOf(`${TEST}(`);
    expect(hasPragmaAbove(src, idx)).toBe(true);
  });

  test("returns true with intervening blank lines", () => {
    const src = [
      "// lint:allow-no-spawn",
      "",
      "",
      `${TEST}("exits 1 when foo", () => {});`,
    ].join("\n");
    const idx = src.indexOf(`${TEST}(`);
    expect(hasPragmaAbove(src, idx)).toBe(true);
  });

  test("returns false when other code is between pragma and trigger", () => {
    const src = [
      "// lint:allow-no-spawn",
      "const x = 1;",
      `${TEST}("exits 1 when foo", () => {});`,
    ].join("\n");
    const idx = src.indexOf(`${TEST}(`);
    expect(hasPragmaAbove(src, idx)).toBe(false);
  });

  test("returns false when no pragma is above", () => {
    const src = [
      `describe('x', () => {`,
      `${TEST}("exits 1 when foo", () => {});`,
      "});",
    ].join("\n");
    const idx = src.indexOf(`${TEST}(`);
    expect(hasPragmaAbove(src, idx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawnCoversTrigger — ancestor-only scope rule
// ---------------------------------------------------------------------------

describe("spawnCoversTrigger", () => {
  test("file-scope spawn always covers any trigger (no enclosing describe)", () => {
    expect(spawnCoversTrigger(0, 100, [])).toBe(true);
  });

  test("ancestor-describe spawn covers nested-describe trigger", () => {
    const blocks = [{ bodyStart: 0, bodyEnd: 100 }];
    expect(spawnCoversTrigger(5, 50, blocks)).toBe(true);
  });

  test("sibling-describe spawn does NOT cover trigger in another describe", () => {
    const blocks = [
      { bodyStart: 0, bodyEnd: 50 },
      { bodyStart: 60, bodyEnd: 100 },
    ];
    expect(spawnCoversTrigger(5, 70, blocks)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lintFile — full AC matrix
// ---------------------------------------------------------------------------

describe("lintFile — AC matrix", () => {
  test("Positive — flagged: in-process resolver inside CLI exit code describe", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when foo", () => {`,
      `    const result = runLint([]);`,
      `    expect(result.exitCode).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    const violations = lintFile("synthetic.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.testName).toBe("exits 1 when foo");
    expect(violations[0]!.line).toBe(2);
  });

  test("Positive — flagged for it(...) (Q4 alias)", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  ${IT}("exits 0 against an empty fixture", () => {`,
      `    expect(runLint([]).exitCode).toBe(0);`,
      `  });`,
      `});`,
    ].join("\n");
    const violations = lintFile("synthetic.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.testName).toBe("exits 0 against an empty fixture");
  });

  test("Negative — describe contains Bun.spawnSync (PR #518 round-2 shape)", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when bar", () => {`,
      `    const proc = Bun.spawnSync({});`,
      `    expect(proc.exitCode).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — describe contains Bun.$", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when baz", async () => {`,
      "    await Bun.$`bun run scripts/lint.ts`;",
      `    expect(true).toBe(true);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — describe contains Bun.spawn( (async form, Q3 sync+async)", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when qux", async () => {`,
      `    const proc = Bun.spawn({});`,
      `    await proc.exited;`,
      `    expect(proc.exitCode).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — describe contains execFileSync from child_process", () => {
    const src = [
      `import { execFileSync } from "child_process";`,
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when qq", () => {`,
      `    const out = execFileSync('bun', ['run']);`,
      `    expect(out).toBeTruthy();`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — describe contains standalone spawnSync from child_process", () => {
    const src = [
      `import { spawnSync } from "child_process";`,
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when ww", () => {`,
      `    const proc = spawnSync('bun', []);`,
      `    expect(proc.status).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — test.each(...) is intentionally NOT recognized (v1 scope)", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  ${TEST}.each([[1], [2]])("exits 1 when %p", (n) => {`,
      `    expect(n).toBeGreaterThan(0);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test(`Negative — trigger excludes "exits after grace window …" (Q2)`, () => {
    // Mutation evidence: even with zero spawns in the enclosing describe,
    // an "exits after …"-style runner test does NOT fire. Falsifies the
    // runner.lifecycle false-positive class structurally — if the
    // recognizer were widened to `exits\s+\w+`, this assertion flips.
    const src = [
      `describe("runner lifecycle", () => {`,
      `  ${TEST}("exits after grace window when tmux sibling state is missing", () => {`,
      `    const out = runOrchestration({});`,
      `    expect(out.phase).toBe('ended');`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test(`Negative — trigger excludes "returns exit 0 …" synonym`, () => {
    const src = [
      `describe("CLI", () => {`,
      `  ${TEST}("returns exit 0 against an empty fixture", () => {`,
      `    expect(runLint([]).exitCode).toBe(0);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — pragma suppresses the immediately-following row", () => {
    const src = [
      `describe("CLI exit code", () => {`,
      `  // lint:allow-no-spawn`,
      `  ${TEST}("exits 1 when no spawn", () => {`,
      `    expect(runLint([]).exitCode).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Positive — pragma does NOT suppress a non-immediately-following row", () => {
    // Mutation evidence: if the pragma were treated as a block-wide
    // suppressor, the assertion `length === 1` and the second-test name
    // check below would fail. The pragma's single-row scope is what's
    // being enforced here.
    const src = [
      `describe("CLI exit code", () => {`,
      `  // lint:allow-no-spawn`,
      `  ${TEST}("exits 1 when first", () => {`,
      `    expect(runLint([]).exitCode).toBe(1);`,
      `  });`,
      `  ${TEST}("exits 0 when second", () => {`,
      `    expect(runLint([]).exitCode).toBe(0);`,
      `  });`,
      `});`,
    ].join("\n");
    const violations = lintFile("synthetic.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.testName).toBe("exits 0 when second");
  });

  test("Negative — nested describes, ancestor describe contains Bun.spawnSync", () => {
    const src = [
      `describe("outer", () => {`,
      `  const proc = Bun.spawnSync({});`,
      `  describe("inner", () => {`,
      `    ${TEST}("exits 1 when nested", () => {`,
      `      expect(proc.exitCode).toBe(1);`,
      `    });`,
      `  });`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Negative — top-level test with file-body spawn (no enclosing describe)", () => {
    const src = [
      `const proc = Bun.spawnSync({});`,
      `${TEST}("exits 1 when top level", () => {`,
      `  expect(proc.exitCode).toBe(1);`,
      `});`,
    ].join("\n");
    expect(lintFile("synthetic.ts", src)).toEqual([]);
  });

  test("Positive — sibling-describe spawn does NOT cover a trigger in another describe", () => {
    // Falsifies a too-lenient "any spawn anywhere in the file is enough"
    // implementation. The spawn lives inside a sibling describe; the
    // trigger lives in a different describe with no spawn. Per Q4-extended
    // scope rule, this MUST flag.
    const src = [
      `describe("smoke", () => {`,
      `  const proc = Bun.spawnSync({});`,
      `  ${TEST}("exits 0 when smoke", () => {`,
      `    expect(proc.exitCode).toBe(0);`,
      `  });`,
      `});`,
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when foo", () => {`,
      `    expect(runLint([]).exitCode).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    const violations = lintFile("synthetic.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.testName).toBe("exits 1 when foo");
  });

  test("violation row carries file, line, and full test-name literal", () => {
    const src = [
      `// header line 1`,
      `// header line 2`,
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when fabricated", () => {`,
      `    expect(runLint([]).exitCode).toBe(1);`,
      `  });`,
      `});`,
    ].join("\n");
    const violations = lintFile("a.test.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe("a.test.ts");
    expect(violations[0]!.line).toBe(4);
    expect(violations[0]!.testName).toBe("exits 1 when fabricated");
  });
});

// ---------------------------------------------------------------------------
// Live-corpus smoke + floor-count meta-test
// ---------------------------------------------------------------------------

describe("live corpus", () => {
  test("running the lint over the live scripts/*.test.ts set yields zero violations", () => {
    // After the pragma applications mandated by the AC, the live tree
    // MUST be clean. If a future PR introduces an unwrapped exits-named
    // test without a spawn or pragma, this assertion fires.
    const files = collectInScopeFiles(root);
    const violations = lintCorpus(files, (rel) =>
      readFileSync(join(root, rel), "utf-8"),
    );
    expect(violations).toEqual([]);
  });

  test("floor-count: at least 30 trigger rows across at least 10 files (silent-drift guard)", () => {
    // SILENT-DRIFT WARNING: a refactor that consolidates exit-code tests
    // behind a helper or renames them would let this lint pass vacuously
    // (zero triggers ⇒ zero violations). This floor-count assertion fires
    // if the trigger recognizer drops to near-zero matches against the
    // live `scripts/*.test.ts` set.
    const files = collectInScopeFiles(root);
    const { totalRows, filesWithRows } = countTriggerRows(files, (rel) =>
      readFileSync(join(root, rel), "utf-8"),
    );
    expect(totalRows).toBeGreaterThanOrEqual(30);
    expect(filesWithRows).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// CLI exit-code contract — the lint's own self-test must spawn the CLI
// (otherwise it would fail its own check, which is the right invariant).
// Mirrors the failure-path tamper-and-restore harness in
// scripts/lint-skill-shell.test.ts.
// ---------------------------------------------------------------------------

describe("CLI exit code", () => {
  const scriptPath = join(root, "scripts", "lint-test-spawn-coverage.ts");

  test("exits 0 against the live corpus (post-PR pragma applications)", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("✅");
  });

  test("exits 1 with the AC stderr shape on a tampered in-scope test file", () => {
    // Harness condition: temporarily plant a synthetic test file under
    // scripts/ that contains a violating exits-named row with no spawn
    // in its describe block. Spawn the CLI, then unlink.
    //
    // Invariant being enforced: the AC's CLI-surface wording — exit 1 on
    // any violation, with stderr matching the expected shape (❌ summary
    // + per-violation `file:line test("…")` row + remediation prompt
    // naming the three fixes). Mutation-testing this path catches a
    // future refactor that drops `process.exit(1)`, swallows the ❌
    // summary, omits the test-name literal, or drops a remediation phrase.
    const target = join(
      root,
      "scripts",
      "__lint_test_spawn_coverage_probe__.test.ts",
    );
    const probe = [
      `import { describe, test, expect } from "bun:test";`,
      `describe("CLI exit code", () => {`,
      `  ${TEST}("exits 1 when probe fires", () => {`,
      `    expect(1).toBe(1);`,
      `  });`,
      `});`,
      ``,
    ].join("\n");
    try {
      writeFileSync(target, probe);
      const proc = Bun.spawnSync({
        cmd: ["bun", "run", scriptPath],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(1);
      const stderr = proc.stderr.toString();
      // ❌ summary line — without it, the violation list is unattributed.
      expect(stderr).toContain("❌");
      // Per-violation row shape: `<file>:<line> test("<name>")`.
      expect(stderr).toContain(
        "scripts/__lint_test_spawn_coverage_probe__.test.ts",
      );
      expect(stderr).toContain(`test("exits 1 when probe fires")`);
      // Remediation prompt — anchor on each of the three sanctioned
      // fixes so a future edit that strips one path is caught.
      expect(stderr).toContain("Bun.spawnSync");
      expect(stderr).toContain("rename the test");
      expect(stderr).toContain("// lint:allow-no-spawn");
    } finally {
      try {
        unlinkSync(target);
      } catch {
        // best-effort cleanup — if unlink fails the next run will overwrite.
      }
    }
  });
});
