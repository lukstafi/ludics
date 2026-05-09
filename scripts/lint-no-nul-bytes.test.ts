import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLint } from "./lint-no-nul-bytes.ts";

function makeFixture(files: Record<string, string | Buffer>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-no-nul-bytes-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// NUL bytes are constructed via Buffer.from([0]) rather than appearing as a
// literal in this source — both because the lint we ship would flag this
// file otherwise (AC #2 final bullet) and because keeping the test source
// itself clean is exactly the post-fix invariant the lint pins.
const NUL = Buffer.from([0]);

describe("runLint", () => {
  test("exitCode 0 with empty offenders on a clean ASCII fixture", () => {
    const { root, cleanup } = makeFixture({
      "src/foo.ts": "export const x = 1;\n",
      "docs/notes.md": "# Notes\n\nPlain ASCII content.\n",
      "config.json": '{"name":"x"}\n',
      "ci.yaml": "name: ci\n",
      "ci.yml": "name: ci\n",
      "ui/page.tsx": "export default function P() { return null; }\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("exitCode 1 with offender paths when a .ts file contains a NUL byte", () => {
    const dirty = Buffer.concat([
      Buffer.from("export const NEVER = /^"),
      NUL,
      Buffer.from("NEVER_MATCH/;\n"),
    ]);
    const { root, cleanup } = makeFixture({
      "src/dirty.ts": dirty,
      "src/clean.ts": "export const ok = 1;\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/dirty.ts"]);
    } finally {
      cleanup();
    }
  });

  test("non-ASCII UTF-8 (em-dash, accents) is clean — invariant is NUL-only, not ASCII-only", () => {
    // AC #2 explicit case: an over-eager rewrite toward an ASCII-only check
    // would flag valid multibyte UTF-8. Em-dash `—` is 0xE2 0x80 0x94 in
    // UTF-8; accented `é` is 0xC3 0xA9. Neither byte is 0x00, so both must
    // pass.
    const { root, cleanup } = makeFixture({
      "docs/non-ascii.md": "# Title — subtitle\n\nCafé, naïve, façade — résumé.\n",
      "src/non-ascii.ts": "// éàü — ASCII-printable replacement is /^__NEVER__$/\nexport const s = 'café';\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("scans every advertised text extension (.ts, .tsx, .md, .json, .yaml, .yml)", () => {
    // Each extension gets its own NUL-bearing fixture so a missing entry in
    // TEXT_EXTENSIONS would surface as a missing offender.
    const dirty = Buffer.concat([Buffer.from("prefix"), NUL, Buffer.from("suffix\n")]);
    const { root, cleanup } = makeFixture({
      "a.ts": dirty,
      "b.tsx": dirty,
      "c.md": dirty,
      "d.json": dirty,
      "e.yaml": dirty,
      "f.yml": dirty,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual([
        "a.ts",
        "b.tsx",
        "c.md",
        "d.json",
        "e.yaml",
        "f.yml",
      ]);
    } finally {
      cleanup();
    }
  });

  test("ignores NUL bytes in non-listed extensions (e.g. .png)", () => {
    // Extension policy is the boundary between "tracked text" and "anything
    // else" — a binary fixture under a non-listed extension must not be
    // flagged.
    const dirty = Buffer.concat([Buffer.from("PNG"), NUL, NUL, Buffer.from("data")]);
    const { root, cleanup } = makeFixture({
      "assets/icon.png": dirty,
      "src/clean.ts": "export const ok = 1;\n",
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("scans dot-directories (matches GNU grep -r semantics; codex P2 on PR #468)", () => {
    const dirty = Buffer.concat([Buffer.from("hidden"), NUL, Buffer.from("\n")]);
    const { root, cleanup } = makeFixture({
      "src/.hidden/dirty.ts": dirty,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/.hidden/dirty.ts"]);
    } finally {
      cleanup();
    }
  });

  test("skips node_modules/, bin/, dist/, .git/", () => {
    const dirty = Buffer.concat([Buffer.from("vendored"), NUL, Buffer.from("\n")]);
    const { root, cleanup } = makeFixture({
      "node_modules/pkg/index.ts": dirty,
      "bin/build.ts": dirty,
      "dist/out.js.ts": dirty,
      ".git/HEAD.md": dirty,
      "src/clean.ts": "export const ok = 1;\n",
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
    const dirty = Buffer.concat([Buffer.from("x"), NUL, Buffer.from("\n")]);
    const { root, cleanup } = makeFixture({
      "src/zeta.ts": dirty,
      "src/alpha.md": dirty,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/alpha.md", "src/zeta.ts"]);
    } finally {
      cleanup();
    }
  });

  test("returns exit 0 against an empty fixture", () => {
    const { root, cleanup } = makeFixture({});
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(0);
      expect(result.offenders).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("catches a NUL byte past the leading 8KB (whole-file scan, not git's heuristic window)", () => {
    // git's text/binary detection only inspects the first ~8KB of a blob, so
    // a NUL byte deeper in a long file may render textually in some tools
    // but still trip `git diff --numstat`. The lint scans the whole file.
    const padding = Buffer.alloc(16384, 0x41); // 16KB of 'A'
    const dirty = Buffer.concat([padding, NUL, Buffer.from("trailing\n")]);
    const { root, cleanup } = makeFixture({
      "src/long.ts": dirty,
    });
    try {
      const result = runLint(root);
      expect(result.exitCode).toBe(1);
      expect(result.offenders).toEqual(["src/long.ts"]);
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
      "src/clean.ts": "export const x = 1;\n",
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-no-nul-bytes.ts"), root],
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
    const dirty = Buffer.concat([Buffer.from("/^"), NUL, Buffer.from("NEVER/\n")]);
    const { root, cleanup } = makeFixture({
      "src/dirty.ts": dirty,
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-no-nul-bytes.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      // stderr should name the offending repo-relative path so reviewers can
      // act on it without re-running the lint locally.
      expect(result.stderr.toString()).toContain("src/dirty.ts");
    } finally {
      cleanup();
    }
  });

  test("exits 0 against the real repo (no current offenders, including docs/swe-textbook.shape.test.ts)", () => {
    // AC #5: real-repo passes. The historical offender
    // docs/swe-textbook.shape.test.ts (15767 bytes, 0 NUL bytes today) is
    // part of the scanned set; if it ever regresses, this assertion fails.
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-no-nul-bytes.ts")],
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
