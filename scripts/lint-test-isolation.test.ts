import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkRule1,
  checkRule2,
  checkRule3,
  parseImports,
  hasIsolationSetup,
  resolveImport,
  listTestFiles,
  runCli,
  RULE_3_TARGETS,
} from "./lint-test-isolation.ts";

// ---------------------------------------------------------------------------
// Rule 1 — unconditional `delete process.env.LUDICS_HARNESS_DIR`
// ---------------------------------------------------------------------------

describe("checkRule1", () => {
  test("flags a bare unconditional delete", () => {
    const src = [
      "afterEach(() => {",
      "  delete process.env.LUDICS_HARNESS_DIR;",
      "});",
    ].join("\n");
    const issues = checkRule1(src, "t.test.ts");
    expect(issues.length).toBe(1);
    expect(issues[0]!.rule).toBe("rule-1");
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.line).toBe(2);
  });

  test("accepts same-line `=== undefined` guard", () => {
    const src = [
      "afterEach(() => {",
      "  if (ORIG === undefined) delete process.env.LUDICS_HARNESS_DIR;",
      "  else process.env.LUDICS_HARNESS_DIR = ORIG;",
      "});",
    ].join("\n");
    expect(checkRule1(src, "t.test.ts")).toEqual([]);
  });

  test("accepts two-line braced guard", () => {
    const src = [
      "afterEach(() => {",
      "  if (ORIG === undefined) {",
      "    delete process.env.LUDICS_HARNESS_DIR;",
      "  } else {",
      "    process.env.LUDICS_HARNESS_DIR = ORIG;",
      "  }",
      "});",
    ].join("\n");
    expect(checkRule1(src, "t.test.ts")).toEqual([]);
  });

  test("accepts three-line lookback with intermediate blank", () => {
    const src = [
      "afterEach(() => {",
      "  if (ORIG === undefined)",
      "  {",
      "",
      "    delete process.env.LUDICS_HARNESS_DIR;",
      "  }",
      "});",
    ].join("\n");
    expect(checkRule1(src, "t.test.ts")).toEqual([]);
  });

  test("accepts inverse `!== undefined` guard (else delete form)", () => {
    // Widely-used shape in the real suite; semantically equivalent.
    const src = [
      "afterEach(() => {",
      "  if (ORIG !== undefined) process.env.LUDICS_HARNESS_DIR = ORIG;",
      "  else delete process.env.LUDICS_HARNESS_DIR;",
      "});",
    ].join("\n");
    expect(checkRule1(src, "t.test.ts")).toEqual([]);
  });

  test("whole-file exemption when `withTestHarness(` appears anywhere", () => {
    // Even a shape that would otherwise flag is exempted when the helper is in use.
    const src = [
      "import { withTestHarness } from './test-utils.ts';",
      "const getHarness = withTestHarness(beforeEach, afterEach);",
      "",
      "afterEach(() => {",
      "  delete process.env.LUDICS_HARNESS_DIR;  // would flag without the exemption",
      "});",
    ].join("\n");
    expect(checkRule1(src, "t.test.ts")).toEqual([]);
  });

  test("flags when guard is further back than 3 non-blank lines", () => {
    const src = [
      "afterEach(() => {",
      "  if (ORIG === undefined) {",
      "    someStatement();",
      "    anotherStatement();",
      "    yetAnother();",
      "    delete process.env.LUDICS_HARNESS_DIR;",
      "  }",
      "});",
    ].join("\n");
    const issues = checkRule1(src, "t.test.ts");
    expect(issues.length).toBe(1);
    expect(issues[0]!.line).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — `process.env.X = Y ?? undefined`
// ---------------------------------------------------------------------------

describe("checkRule2", () => {
  test("flags `process.env.X = Y ?? undefined`", () => {
    const src = "process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR ?? undefined;";
    const issues = checkRule2(src, "t.test.ts");
    expect(issues.length).toBe(1);
    expect(issues[0]!.rule).toBe("rule-2");
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.line).toBe(1);
  });

  test("accepts the canonical conditional-restore pattern", () => {
    const src = [
      "if (orig === undefined) delete process.env.LUDICS_HARNESS_DIR;",
      "else process.env.LUDICS_HARNESS_DIR = orig;",
    ].join("\n");
    expect(checkRule2(src, "t.test.ts")).toEqual([]);
  });

  test("does not flag `?? undefined` outside a process.env LHS", () => {
    const src = [
      "const name = rawName ?? undefined;",
      "const config: Config = provided ?? undefined;",
      "fn(param ?? undefined);",
    ].join("\n");
    expect(checkRule2(src, "t.test.ts")).toEqual([]);
  });

  test("flags every offending line, with correct line numbers", () => {
    const src = [
      "// header",
      "process.env.FOO = orig1 ?? undefined;",
      "const safe = x ?? undefined;",
      "process.env.BAR = orig2 ?? undefined;",
    ].join("\n");
    const issues = checkRule2(src, "t.test.ts");
    expect(issues.map((i) => i.line)).toEqual([2, 4]);
  });
});

// ---------------------------------------------------------------------------
// parseImports / hasIsolationSetup / resolveImport
// ---------------------------------------------------------------------------

describe("parseImports", () => {
  test("extracts relative and bare import paths; skips `import type`", () => {
    const src = [
      "import { a } from './a.ts';",
      "import type { T } from './types.ts';",
      "import { b } from '../b';",
      "import 'polyfill';",
      "const c = 1;",
    ].join("\n");
    expect(parseImports(src)).toEqual(["./a.ts", "../b"]);
  });
});

describe("hasIsolationSetup", () => {
  test("true if source sets LUDICS_HARNESS_DIR", () => {
    expect(
      hasIsolationSetup("process.env.LUDICS_HARNESS_DIR = join(TMP, 'x');"),
    ).toBe(true);
  });
  test("true if source calls withTestHarness(", () => {
    expect(hasIsolationSetup("const g = withTestHarness(beforeEach, afterEach);")).toBe(true);
  });
  test("false when neither token is present", () => {
    expect(hasIsolationSetup("const x = 1;")).toBe(false);
  });
});

describe("resolveImport", () => {
  test("resolves an extensionless relative import to the .ts file", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/foo.test.ts": "",
      "src/foo.ts": "",
    });
    try {
      expect(resolveImport("src/foo.test.ts", "./foo", dir)).toBe("src/foo.ts");
    } finally {
      cleanup();
    }
  });

  test("resolves a `.ts` relative import verbatim", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/a/b.test.ts": "",
      "src/a/b.ts": "",
    });
    try {
      expect(resolveImport("src/a/b.test.ts", "./b.ts", dir)).toBe("src/a/b.ts");
    } finally {
      cleanup();
    }
  });

  test("resolves `../` into sibling directory", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/adapters/m.test.ts": "",
      "src/config.ts": "",
    });
    try {
      expect(resolveImport("src/adapters/m.test.ts", "../config.ts", dir)).toBe("src/config.ts");
    } finally {
      cleanup();
    }
  });

  test("returns null for bare package imports", () => {
    const { dir, cleanup } = makeRepoFixture({ "src/t.test.ts": "" });
    try {
      expect(resolveImport("src/t.test.ts", "bun:test", dir)).toBeNull();
      expect(resolveImport("src/t.test.ts", "yaml", dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null when no candidate exists", () => {
    const { dir, cleanup } = makeRepoFixture({ "src/t.test.ts": "" });
    try {
      expect(resolveImport("src/t.test.ts", "./missing.ts", dir)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// checkRule3 — standalone (no runCli)
// ---------------------------------------------------------------------------

describe("checkRule3", () => {
  function rule3(opts: {
    file: string;
    source: string;
    directImports: string[];
    neighbours?: Record<string, string[]>;
    allowlist?: Set<string>;
    resolver?: (importer: string, rawPath: string) => string | null;
  }) {
    const neighbours = new Map<string, string[]>(Object.entries(opts.neighbours ?? {}));
    const resolver =
      opts.resolver ??
      ((_importer: string, raw: string) => {
        // Default test resolver: treat any path ending in `.ts` as repo-relative
        // after stripping leading `./`. `../config.ts` → `config.ts` keeps the
        // tests simple since we pick our own repo-relative names in fixtures.
        if (raw.startsWith(".")) {
          const stripped = raw.replace(/^(\.\.?\/)+/, "");
          return stripped.endsWith(".ts") ? stripped : stripped + ".ts";
        }
        return null;
      });
    return checkRule3({
      file: opts.file,
      source: opts.source,
      directImports: opts.directImports,
      neighbourImports: neighbours,
      targets: RULE_3_TARGETS,
      allowlist: opts.allowlist ?? new Set(),
      resolve: resolver,
    });
  }

  test("positive: direct import of a target module", () => {
    const issues = rule3({
      file: "src/x.test.ts",
      source: "import { harnessDir } from './config.ts';",
      directImports: ["./config.ts"],
      resolver: () => "src/config.ts",
    });
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("src/config.ts");
  });

  test("positive: one-level transitive via a helper", () => {
    // Mirrors gh-ludics-306: test → helper → base.ts.
    const resolver = (importer: string, raw: string): string | null => {
      if (importer === "src/adapters/m.test.ts" && raw === "./manual.ts")
        return "src/adapters/manual.ts";
      if (importer === "src/adapters/manual.ts" && raw === "./base.ts")
        return "src/adapters/base.ts";
      return null;
    };
    const issues = rule3({
      file: "src/adapters/m.test.ts",
      source: "import { start } from './manual.ts';",
      directImports: ["./manual.ts"],
      neighbours: { "src/adapters/manual.ts": ["./base.ts"] },
      resolver,
    });
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("src/adapters/base.ts");
    expect(issues[0]!.message).toContain("src/adapters/manual.ts");
  });

  test("negative: file sets LUDICS_HARNESS_DIR (lexical presence sufficient)", () => {
    const issues = rule3({
      file: "src/x.test.ts",
      source: [
        "import { harnessDir } from './config.ts';",
        "beforeEach(() => { process.env.LUDICS_HARNESS_DIR = '/tmp/x'; });",
      ].join("\n"),
      directImports: ["./config.ts"],
      resolver: () => "src/config.ts",
    });
    expect(issues).toEqual([]);
  });

  test("negative: file uses withTestHarness", () => {
    const issues = rule3({
      file: "src/x.test.ts",
      source: [
        "import { harnessDir } from './config.ts';",
        "const getHarness = withTestHarness(beforeEach, afterEach);",
      ].join("\n"),
      directImports: ["./config.ts"],
      resolver: () => "src/config.ts",
    });
    expect(issues).toEqual([]);
  });

  test("negative: file is on the allowlist", () => {
    const issues = rule3({
      file: "src/adapters/task-launch.test.ts",
      source: "import { foo } from './config.ts';",
      directImports: ["./config.ts"],
      allowlist: new Set(["src/adapters/task-launch.test.ts"]),
      resolver: () => "src/config.ts",
    });
    expect(issues).toEqual([]);
  });

  test("negative: imports don't reach any target module", () => {
    const resolver = (_importer: string, raw: string): string | null => {
      if (raw === "./helper.ts") return "src/helper.ts";
      if (raw === "./inert.ts") return "src/inert.ts";
      return null;
    };
    const issues = rule3({
      file: "src/x.test.ts",
      source: "import { h } from './helper.ts';",
      directImports: ["./helper.ts"],
      neighbours: { "src/helper.ts": ["./inert.ts"] },
      resolver,
    });
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listTestFiles
// ---------------------------------------------------------------------------

describe("listTestFiles", () => {
  test("recurses and filters to *.test.ts", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/a.test.ts": "",
      "src/a.ts": "",
      "src/sub/b.test.ts": "",
      "src/sub/b.ts": "",
      "src/.hidden/skip.test.ts": "",
    });
    try {
      const files = listTestFiles(join(dir, "src")).map((p) => p.replace(dir, ""));
      expect(files.some((p) => p.endsWith("/a.test.ts"))).toBe(true);
      expect(files.some((p) => p.endsWith("/b.test.ts"))).toBe(true);
      expect(files.some((p) => p.endsWith("/a.ts"))).toBe(false);
      // Hidden dirs are skipped.
      expect(files.some((p) => p.includes(".hidden"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// runCli — end-to-end with temp fixtures
// ---------------------------------------------------------------------------

/**
 * Build a repo-root-style fixture. `files` maps repo-relative paths to file
 * contents (parent dirs auto-created). Returns the absolute fixture root.
 */
function makeRepoFixture(files: Record<string, string>): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "lint-test-iso-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function driveRunCli(repoRoot: string, allowlist?: Set<string>): {
  exitCode: number;
  err: string[];
  out: string[];
  errorCount: number;
  warningCount: number;
} {
  const err: string[] = [];
  const out: string[] = [];
  const result = runCli({
    srcDir: join(repoRoot, "src"),
    repoRoot,
    allowlist,
    writeErr: (m) => err.push(m),
    writeOut: (m) => out.push(m),
  });
  return {
    exitCode: result.exitCode,
    err,
    out,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
  };
}

describe("runCli", () => {
  test("clean fixture: no errors, exit 0, success line on stdout", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/safe.test.ts": [
        "import { foo } from './foo.ts';",
        "beforeEach(() => { process.env.LUDICS_HARNESS_DIR = '/tmp/x'; });",
      ].join("\n"),
      "src/foo.ts": "export const foo = 1;",
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(0);
      expect(r.errorCount).toBe(0);
      expect(r.warningCount).toBe(0);
      expect(r.out.some((l) => l.includes("No test-isolation"))).toBe(true);
      expect(r.err).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("mixed errors + warnings: exit 1, correct counts, stderr formatting", () => {
    const { dir, cleanup } = makeRepoFixture({
      // rule-1 error
      "src/r1.test.ts": [
        "afterEach(() => {",
        "  delete process.env.LUDICS_HARNESS_DIR;",
        "});",
      ].join("\n"),
      // rule-2 error
      "src/r2.test.ts": [
        "afterEach(() => {",
        "  process.env.LUDICS_HARNESS_DIR = ORIG ?? undefined;",
        "});",
      ].join("\n"),
      // rule-3 warning (direct)
      "src/r3.test.ts": "import { harnessDir } from './config.ts';\n",
      "src/config.ts": "export function harnessDir(){}",
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(1);
      expect(r.errorCount).toBe(2);
      expect(r.warningCount).toBe(1);
      // Error lines include file:line and rule name.
      expect(
        r.err.some((l) => l.includes("src/r1.test.ts:2") && l.includes("rule-1")),
      ).toBe(true);
      expect(
        r.err.some((l) => l.includes("src/r2.test.ts:2") && l.includes("rule-2")),
      ).toBe(true);
      expect(
        r.err.some((l) => l.includes("src/r3.test.ts") && l.includes("rule-3")),
      ).toBe(true);
      // Error prefix vs warning prefix is distinguishable.
      expect(r.err.filter((l) => l.startsWith("❌")).length).toBe(2);
      expect(r.err.filter((l) => l.startsWith("⚠")).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("transitive rule-3 warning fires through a one-level helper", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/adapters/m.test.ts": "import { start } from './manual.ts';\n",
      "src/adapters/manual.ts": "import { adapterStateDir } from './base.ts';\n",
      "src/adapters/base.ts": "export function adapterStateDir(){}",
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(0);
      expect(r.errorCount).toBe(0);
      expect(r.warningCount).toBe(1);
      expect(
        r.err.some(
          (l) =>
            l.includes("src/adapters/m.test.ts") &&
            l.includes("src/adapters/base.ts") &&
            l.includes("src/adapters/manual.ts"),
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("allowlisted file is exempt from rule 3", () => {
    const { dir, cleanup } = makeRepoFixture({
      "src/adapters/task-launch.test.ts": "import { x } from './task-launch.ts';\n",
      "src/adapters/task-launch.ts": "import { harnessDir } from '../config.ts';\n",
      "src/config.ts": "export function harnessDir(){}",
    });
    try {
      const r = driveRunCli(dir, new Set(["src/adapters/task-launch.test.ts"]));
      expect(r.exitCode).toBe(0);
      expect(r.warningCount).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("scan excludes `src/test-setup.ts` and `src/test-utils.ts`", () => {
    // These files contain the canonical implementation; flagging them is circular.
    // `*.test.ts` extension matters for the walker — we use a parallel .test.ts
    // sibling to prove the scan ran, then confirm the helpers' content wouldn't
    // matter even if it were unsafe by omitting them from the reported set.
    const { dir, cleanup } = makeRepoFixture({
      // If this were scanned, it'd flag rule 1. But it's excluded by name.
      "src/test-utils.ts": [
        "afterEach(() => { delete process.env.LUDICS_HARNESS_DIR; });",
      ].join("\n"),
      "src/test-setup.ts": [
        "process.env.LUDICS_HARNESS_DIR = ORIG ?? undefined;",
      ].join("\n"),
      // Plus a clean test to confirm the walker did run.
      "src/safe.test.ts": "beforeEach(() => { process.env.LUDICS_HARNESS_DIR = '/tmp/y'; });",
    });
    try {
      const r = driveRunCli(dir);
      expect(r.exitCode).toBe(0);
      expect(r.errorCount).toBe(0);
      expect(r.warningCount).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — drive the real CLI against the real repo
// ---------------------------------------------------------------------------

describe("integration", () => {
  test("lint-test-isolation exits 0 on current repo", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-test-isolation.ts")],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error(result.stderr.toString());
      console.error(result.stdout.toString());
    }
    expect(result.exitCode).toBe(0);
  });
});
