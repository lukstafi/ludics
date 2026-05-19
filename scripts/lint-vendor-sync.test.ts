import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPairs, formatViolation, PAIRS, DEFAULT_FRESHEN_CMD, type Pair } from "./lint-vendor-sync.ts";

/** Build a tmp repo-root layout with the listed files (parent dirs auto-created).
 *  Hermetic: nothing in `node_modules/` of the real repo is read. */
function makeFixture(files: Record<string, string | Buffer>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-vendor-sync-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TEST_PAIRS: ReadonlyArray<Pair> = [
  {
    vendored: "templates/dashboard/vendor/foo.js",
    upstream: "node_modules/foo/dist/foo.mjs",
  },
  {
    vendored: "templates/dashboard/vendor/bar.js",
    upstream: "node_modules/bar/dist/bar.mjs",
  },
];

describe("checkPairs", () => {
  test("returns [] when all pairings have byte-identical copies", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/foo.js": "FOO BYTES\n",
      "node_modules/foo/dist/foo.mjs": "FOO BYTES\n",
      "templates/dashboard/vendor/bar.js": "BAR BYTES\n",
      "node_modules/bar/dist/bar.mjs": "BAR BYTES\n",
    });
    try {
      expect(checkPairs(root, TEST_PAIRS)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns one bytes-differ violation when one pairing's bytes differ", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/foo.js": "FOO BYTES\n",
      "node_modules/foo/dist/foo.mjs": "FOO BYTES\n",
      "templates/dashboard/vendor/bar.js": "BAR BYTES OLD\n",
      "node_modules/bar/dist/bar.mjs": "BAR BYTES NEW\n",
    });
    try {
      const violations = checkPairs(root, TEST_PAIRS);
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("bytes-differ");
      expect(violations[0]!.pair.vendored).toBe("templates/dashboard/vendor/bar.js");
      expect(violations[0]!.vendoredBytes).toBe("BAR BYTES OLD\n".length);
      expect(violations[0]!.upstreamBytes).toBe("BAR BYTES NEW\n".length);
      expect(violations[0]!.hint).toContain(
        "cp node_modules/bar/dist/bar.mjs templates/dashboard/vendor/bar.js",
      );
    } finally {
      cleanup();
    }
  });

  test("flags single-byte drift (e.g., trailing newline) — proves it's bytes, not size", () => {
    // Same length is not enough: byte-for-byte must catch a single-character
    // change that preserves length, the exact silent-drift case the lint exists
    // to surface.
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/foo.js": "abc",
      "node_modules/foo/dist/foo.mjs": "abd",
      "templates/dashboard/vendor/bar.js": "X",
      "node_modules/bar/dist/bar.mjs": "X",
    });
    try {
      const violations = checkPairs(root, TEST_PAIRS);
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("bytes-differ");
      expect(violations[0]!.vendoredBytes).toBe(3);
      expect(violations[0]!.upstreamBytes).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("returns missing-upstream violation with bun-install hint when upstream absent", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/foo.js": "FOO\n",
      "node_modules/foo/dist/foo.mjs": "FOO\n",
      "templates/dashboard/vendor/bar.js": "BAR\n",
      // bar upstream intentionally omitted
    });
    try {
      const violations = checkPairs(root, TEST_PAIRS);
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("missing-upstream");
      expect(violations[0]!.pair.upstream).toBe("node_modules/bar/dist/bar.mjs");
      expect(violations[0]!.hint).toContain("bun install");
      expect(violations[0]!.upstreamBytes).toBeUndefined();
      expect(violations[0]!.vendoredBytes).toBe("BAR\n".length);
    } finally {
      cleanup();
    }
  });

  test("returns missing-vendored violation when vendored copy absent", () => {
    const { root, cleanup } = makeFixture({
      // foo vendored intentionally omitted
      "node_modules/foo/dist/foo.mjs": "FOO\n",
      "templates/dashboard/vendor/bar.js": "BAR\n",
      "node_modules/bar/dist/bar.mjs": "BAR\n",
    });
    try {
      const violations = checkPairs(root, TEST_PAIRS);
      expect(violations.length).toBe(1);
      expect(violations[0]!.kind).toBe("missing-vendored");
      expect(violations[0]!.pair.vendored).toBe("templates/dashboard/vendor/foo.js");
      expect(violations[0]!.upstreamBytes).toBe("FOO\n".length);
      expect(violations[0]!.hint).toContain(
        "cp node_modules/foo/dist/foo.mjs templates/dashboard/vendor/foo.js",
      );
    } finally {
      cleanup();
    }
  });

  test("aggregates multiple violations across pairs", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/foo.js": "FOO OLD\n",
      "node_modules/foo/dist/foo.mjs": "FOO NEW\n",
      "templates/dashboard/vendor/bar.js": "BAR OLD\n",
      "node_modules/bar/dist/bar.mjs": "BAR NEW\n",
    });
    try {
      const violations = checkPairs(root, TEST_PAIRS);
      expect(violations.length).toBe(2);
      expect(violations.every((v) => v.kind === "bytes-differ")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("formatViolation", () => {
  test("bytes-differ message names both paths, both byte counts, and a cp fix", () => {
    const msg = formatViolation({
      pair: TEST_PAIRS[0]!,
      kind: "bytes-differ",
      vendoredBytes: 100,
      upstreamBytes: 110,
      hint: "Resolve drift: `cp node_modules/foo/dist/foo.mjs templates/dashboard/vendor/foo.js`",
    });
    expect(msg).toContain("templates/dashboard/vendor/foo.js");
    expect(msg).toContain("node_modules/foo/dist/foo.mjs");
    expect(msg).toContain("100");
    expect(msg).toContain("110");
    expect(msg).toContain("cp node_modules/foo/dist/foo.mjs templates/dashboard/vendor/foo.js");
  });

  test("missing-upstream message hints at bun install", () => {
    const msg = formatViolation({
      pair: TEST_PAIRS[1]!,
      kind: "missing-upstream",
      vendoredBytes: 50,
      hint: "Upstream not found at node_modules/bar/dist/bar.mjs — did you forget `bun install`?",
    });
    expect(msg).toContain("missing-upstream");
    expect(msg).toContain("bun install");
  });
});

// ---------------------------------------------------------------------------
// PAIRS sanity — the real declarations point at currently-existing files.
// ---------------------------------------------------------------------------

describe("PAIRS", () => {
  test("declares both vendored and upstream sides as repo-relative paths", () => {
    expect(PAIRS.length).toBeGreaterThan(0);
    for (const p of PAIRS) {
      expect(p.vendored).toMatch(/^templates\/dashboard\/vendor\//);
      expect(p.upstream).toMatch(/^node_modules\//);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive the real script against the real repo.
// ---------------------------------------------------------------------------

describe("CLI integration", () => {
  test("exits 0 against the current repo (vendored copies match upstream)", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-vendor-sync.ts")],
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

  test("exits 0 against a tmp fixture root where every PAIR matches", () => {
    // Mirror the real PAIRS shape so the script's hardcoded paths resolve
    // inside the tmp root.
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "MARKED IDENTICAL\n",
      "node_modules/marked/lib/marked.esm.js": "MARKED IDENTICAL\n",
      "templates/dashboard/vendor/purify.es.js": "PURIFY IDENTICAL\n",
      "node_modules/dompurify/dist/purify.es.mjs": "PURIFY IDENTICAL\n",
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-vendor-sync.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("byte-for-byte");
    } finally {
      cleanup();
    }
  });

  test("exits non-zero when a tmp fixture has one drifting PAIR (drives import.meta.main)", () => {
    // The "exits 1 on drift" AC is what this lint exists to enforce; without a
    // CLI-path test instantiating drift, the claim rests on inspection of the
    // import.meta.main block. This harness builds the same path layout PAIRS
    // expects, makes one upstream byte-different from its vendored copy, and
    // proves the real script returns a non-zero exit code.
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "MARKED VENDORED\n",
      "node_modules/marked/lib/marked.esm.js": "MARKED UPSTREAM\n", // ← drift
      "templates/dashboard/vendor/purify.es.js": "PURIFY IDENTICAL\n",
      "node_modules/dompurify/dist/purify.es.mjs": "PURIFY IDENTICAL\n",
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-vendor-sync.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("vendor-sync");
      // Failure-message AC (proposal): both paths, both byte counts, and the
      // exact cp command must appear in the rendered output.
      expect(stderr).toContain("templates/dashboard/vendor/marked.esm.js");
      expect(stderr).toContain("node_modules/marked/lib/marked.esm.js");
      expect(stderr).toContain("MARKED VENDORED\n".length.toString());
      expect(stderr).toContain("MARKED UPSTREAM\n".length.toString());
      expect(stderr).toContain(
        "cp node_modules/marked/lib/marked.esm.js templates/dashboard/vendor/marked.esm.js",
      );
    } finally {
      cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // gh-ludics-531: freshen step (`bun install --frozen-lockfile`) before lint
  // runs. The production gate is strict — `argRoot` OR `CI` skip the freshen,
  // unconditionally — so these tests drive the bare no-arg CLI path via a
  // `PATH`-shimmed fake `bun`. The fake intercepts `install --frozen-lockfile`
  // and either succeeds (positive case) or fails with a sentinel stderr
  // (hard-fail case), without touching the host's real `node_modules/`.
  //
  // Three cases pinned here:
  //   (1) Bare no-argRoot CLI invocation freshens before checkPairs (fake
  //       install records its argv to a sentinel + exits 0).
  //   (2) Failed freshen is a HARD error: non-zero exit + diagnostic +
  //       captured stderr, and checkPairs is NEVER reached (ordering pin).
  //   (3) argRoot DOES skip the freshen (poisoned-bun gate proof).
  //   (4) CI=1 DOES skip the freshen (gate symmetry).
  // -------------------------------------------------------------------------

  /** Build a tmp PATH-shim directory containing a fake `bun` script that
   *  intercepts `install --frozen-lockfile` per `behaviour`, and delegates
   *  anything else to the real bun (so `realBunPath run script.ts` continues
   *  to work). Returns the dir + a cleanup hook. */
  function makeFakeBun(behaviour: { kind: "ok"; sentinelPath: string } | { kind: "fail"; stderr: string }): {
    fakeBinDir: string;
    cleanup: () => void;
  } {
    const fakeBinDir = mkdtempSync(join(tmpdir(), "lint-vendor-sync-fakebun-"));
    const fakeBunPath = join(fakeBinDir, "bun");
    const realBunPath = process.execPath;
    let body: string;
    if (behaviour.kind === "ok") {
      // Record the argv so the test can assert the spawned command was
      // exactly `bun install --frozen-lockfile`.
      body = `#!/bin/sh
if [ "$1" = "install" ] && [ "$2" = "--frozen-lockfile" ]; then
  printf 'bun %s %s\\n' "$1" "$2" > ${JSON.stringify(behaviour.sentinelPath)}
  exit 0
fi
# Any other invocation: passthrough so \`bun run ...\` still works for the lint
# script itself when the parent invokes us by absolute path is unaffected.
exec ${JSON.stringify(realBunPath)} "$@"
`;
    } else {
      body = `#!/bin/sh
if [ "$1" = "install" ]; then
  printf '%s\\n' ${JSON.stringify(behaviour.stderr)} >&2
  exit 1
fi
exec ${JSON.stringify(realBunPath)} "$@"
`;
    }
    writeFileSync(fakeBunPath, body, { mode: 0o755 });
    return {
      fakeBinDir,
      cleanup: () => rmSync(fakeBinDir, { recursive: true, force: true }),
    };
  }

  test("bare no-argRoot CLI freshens with `bun install --frozen-lockfile` before checkPairs (PATH-shim pins existence)", () => {
    // This is the AC4 positive regression: invoke the script with NO
    // positional arg (so production gate evaluates `!argRoot && !CI` → true),
    // and prove the spawn fires with the AC-mandated flag. The PATH-shimmed
    // fake bun records the argv to a sentinel file; removing the freshen
    // call from `import.meta.main` would leave the sentinel unwritten and
    // this assertion would fail.
    const sentinelDir = mkdtempSync(join(tmpdir(), "lint-vendor-sync-sentinel-"));
    const sentinel = join(sentinelDir, "FRESHEN_INVOKED");
    const { fakeBinDir, cleanup: cleanupBin } = makeFakeBun({
      kind: "ok",
      sentinelPath: sentinel,
    });
    const realBunPath = process.execPath;
    try {
      const result = spawnSync({
        // NO third arg → argRoot undefined → freshen gate fires.
        cmd: [realBunPath, "run", join(import.meta.dir, "lint-vendor-sync.ts")],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // PATH-shim: fake bun shadows the real one for the child process
          // (and any subprocess it spawns by bare name `bun`). The outer
          // realBunPath invocation is absolute so it bypasses PATH lookup.
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          // Explicitly unset CI so the gate has nothing else to skip on.
          CI: "",
        },
      });
      if (result.exitCode !== 0) {
        console.error(result.stderr.toString());
        console.error(result.stdout.toString());
      }
      expect(result.exitCode).toBe(0);
      // The freshen step actually executed: the fake install wrote the
      // sentinel. If a future refactor removes the spawn (or moves it after
      // an early-exit path), the sentinel won't appear.
      expect(existsSync(sentinel)).toBe(true);
      // Byte-exact argv recorded by the fake: any drift in the default
      // install command (e.g. dropping `--frozen-lockfile`) flips this.
      expect(readFileSync(sentinel, "utf8")).toBe(
        "bun install --frozen-lockfile\n",
      );
      // checkPairs also ran (after the freshen): the success message in
      // stdout proves we reached the post-freshen branch.
      expect(result.stdout.toString()).toContain("byte-for-byte");
    } finally {
      cleanupBin();
      rmSync(sentinelDir, { recursive: true, force: true });
    }
  });

  test("failed freshen is a HARD error: non-zero exit + 'vendor sync indeterminate' diagnostic + captured stderr + checkPairs NEVER runs", () => {
    // AC2: when `bun install --frozen-lockfile` fails (offline / broken
    // install / lockfile mismatch), the lint exits non-zero with the AC's
    // exact diagnostic sentence, propagates the install stderr, and
    // critically does NOT fall through to checkPairs — so the developer
    // can't be misled by a passing byte-compare against a stale install.
    const { fakeBinDir, cleanup: cleanupBin } = makeFakeBun({
      kind: "fail",
      stderr: "fake registry unreachable",
    });
    const realBunPath = process.execPath;
    try {
      const result = spawnSync({
        cmd: [realBunPath, "run", join(import.meta.dir, "lint-vendor-sync.ts")],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          CI: "",
        },
      });
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      // The exact AC2 diagnostic sentence.
      expect(stderr).toContain(
        "could not refresh node_modules; vendor sync indeterminate",
      );
      // Captured `bun install` stderr propagates.
      expect(stderr).toContain("fake registry unreachable");
      // Ordering pin: checkPairs did NOT run. Its success message
      // ("byte-for-byte") and its violation banner ("vendor-sync violation")
      // are both absent — proving the freshen-failure short-circuits BEFORE
      // any byte compare.
      expect(stderr).not.toContain("vendor-sync violation");
      expect(result.stdout.toString()).not.toContain("byte-for-byte");
    } finally {
      cleanupBin();
    }
  });

  test("argRoot skips the freshen (gate proof via PATH-shimmed poisoned `bun`)", () => {
    // If a future refactor breaks the `argRoot` gate, the freshen step
    // would run against the host's real `node_modules/` — the exact
    // non-hermetic behaviour the AC forbids. Use a poisoned fake bun that
    // exits non-zero with a sentinel stderr: if the freshen runs, the lint
    // exits non-zero AND prints the sentinel; if the gate holds, the lint
    // skips the freshen and exits 0 against the tmp fixture.
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "M\n",
      "node_modules/marked/lib/marked.esm.js": "M\n",
      "templates/dashboard/vendor/purify.es.js": "P\n",
      "node_modules/dompurify/dist/purify.es.mjs": "P\n",
    });
    const { fakeBinDir, cleanup: cleanupBin } = makeFakeBun({
      kind: "fail",
      stderr: "POISONED_BUN_INSTALL_RAN_UNEXPECTEDLY",
    });
    const realBunPath = process.execPath;
    try {
      const result = spawnSync({
        cmd: [
          realBunPath,
          "run",
          join(import.meta.dir, "lint-vendor-sync.ts"),
          root, // argRoot present → gate should skip freshen
        ],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          CI: "",
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain(
        "POISONED_BUN_INSTALL_RAN_UNEXPECTEDLY",
      );
    } finally {
      cleanup();
      cleanupBin();
    }
  });

  test("CI=1 skips the freshen (gate symmetry, also pins production behaviour on CI)", () => {
    // The other half of the AC1 gate: when `process.env.CI` is set, the
    // freshen MUST be skipped (CI's own `Install dependencies` step is
    // authoritative; a second spawn is pure overhead). Same poisoned-bun
    // mechanism as the argRoot test, but here we drive the no-argRoot
    // path with CI=1 instead.
    const { fakeBinDir, cleanup: cleanupBin } = makeFakeBun({
      kind: "fail",
      stderr: "POISONED_BUN_INSTALL_RAN_UNEXPECTEDLY",
    });
    const realBunPath = process.execPath;
    try {
      const result = spawnSync({
        cmd: [realBunPath, "run", join(import.meta.dir, "lint-vendor-sync.ts")],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          CI: "1", // CI gate fires → freshen skipped
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain(
        "POISONED_BUN_INSTALL_RAN_UNEXPECTEDLY",
      );
    } finally {
      cleanupBin();
    }
  });

  test("DEFAULT_FRESHEN_CMD carries the AC-mandated `--frozen-lockfile` flag", () => {
    // Pins the production install command's shape: any future refactor that
    // drops `--frozen-lockfile` from the default would let `bun install`
    // rewrite the lockfile (one of the failure modes the AC closes).
    expect(DEFAULT_FRESHEN_CMD).toEqual(["bun", "install", "--frozen-lockfile"]);
  });

  test("exits non-zero with bun-install hint when upstream is missing", () => {
    // Failure-message AC (proposal): missing upstream → message names the
    // pair AND points at `bun install` rather than `cp`.
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "MARKED\n",
      // marked upstream intentionally omitted
      "templates/dashboard/vendor/purify.es.js": "PURIFY\n",
      "node_modules/dompurify/dist/purify.es.mjs": "PURIFY\n",
    });
    try {
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-vendor-sync.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("bun install");
    } finally {
      cleanup();
    }
  });
});
