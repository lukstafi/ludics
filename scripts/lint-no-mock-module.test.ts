import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLint } from "./lint-no-mock-module.ts";

function makeFixture(files: Record<string, string>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-no-mock-module-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("runLint", () => {
  test("returns exitCode 0 with empty offenders when no test files use mock.module", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.test.ts": "import { test } from 'bun:test';\ntest('x', () => {});\n",
      "src/bar.ts": "// not a test file\nmock.module('something', () => ({}));\n",
      "templates/foo/x.test.ts": "import { spyOn } from 'bun:test';\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns exitCode 1 with offender paths when a *.test.ts uses mock.module", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.test.ts": [
        "import { test, mock } from 'bun:test';",
        "mock.module('./bar', () => ({ bar: 1 }));",
        "test('x', () => {});",
      ].join("\n"),
      "src/clean.test.ts": "import { test } from 'bun:test';\ntest('y', () => {});\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/foo.test.ts"]);
    } finally {
      cleanup();
    }
  });

  test("scans templates/ in addition to src/", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/foo.test.ts": "import { mock } from 'bun:test';\nmock.module('x', () => ({}));\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["templates/dashboard/foo.test.ts"]);
    } finally {
      cleanup();
    }
  });

  test("ignores `mock.module(` in non-test files (matches grep one-liner semantics)", () => {
    const { root, cleanup } = makeFixture({
      "src/some-helper.ts": "// mock.module() — banned but this is not a *.test.ts file\nmock.module('x', () => ({}));\n",
      "src/clean.test.ts": "import { test } from 'bun:test';\ntest('y', () => {});\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("aggregates multiple offenders and sorts paths", () => {
    const { root, cleanup } = makeFixture({
      "src/zeta.test.ts": "import { mock } from 'bun:test';\nmock.module('z', () => ({}));\n",
      "src/alpha.test.ts": "import { mock } from 'bun:test';\nmock.module('a', () => ({}));\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/alpha.test.ts", "src/zeta.test.ts"]);
    } finally {
      cleanup();
    }
  });

  test("scans dot-directories (matches grep -r semantics; codex P2 on PR #468)", () => {
    // GNU `grep -r 'mock\.module(' src/ templates/ --include='*.test.ts'`
    // recurses into hidden dirs by default. The TS rewrite must match that
    // behavior — skipping dot-dirs would silently weaken the policy and let
    // an offending `*.test.ts` under `src/.something/` go unnoticed.
    const { root, cleanup } = makeFixture({
      "src/.hidden/foo.test.ts": [
        "import { mock } from 'bun:test';",
        "mock.module('./bar', () => ({ bar: 1 }));",
      ].join("\n"),
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/.hidden/foo.test.ts"]);
    } finally {
      cleanup();
    }
  });

  test("returns exit 0 when neither src/ nor templates/ exist", () => {
    const { root, cleanup } = makeFixture({});
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive the real script against tmp-fixture roots so the
// `import.meta.main` exit-code branches are observable.
// ---------------------------------------------------------------------------

describe("CLI integration", () => {
  test("exits 0 against a tmp fixture with no offenders (drives import.meta.main)", () => {
    const { root, cleanup } = makeFixture({
      "src/clean.test.ts": "import { test } from 'bun:test';\ntest('x', () => {});\n",
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-no-mock-module.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        console.error(result.stderr.toString());
        console.error(result.stdout.toString());
      }
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("exits non-zero against a tmp fixture with an offender", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.test.ts": [
        "import { test, mock } from 'bun:test';",
        "mock.module('./bar', () => ({ bar: 1 }));",
        "test('x', () => {});",
      ].join("\n"),
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-no-mock-module.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  test("exits 0 against the real repo (no current offenders)", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-no-mock-module.ts")],
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
