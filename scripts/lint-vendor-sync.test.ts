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
  // runs. Three cases pinned here:
  //   (1) The spawn fires when neither argRoot nor CI are set and the test
  //       seam forces the spawn with a fake install command.
  //   (2) A failing freshen is a HARD error: non-zero exit + the diagnostic
  //       sentence the AC mandates + the captured stderr.
  //   (3) argRoot WITHOUT the test-seam env var does NOT spawn — the gate
  //       that protects existing hermetic tests stays intact.
  // -------------------------------------------------------------------------
  test("freshen step runs `bun install --frozen-lockfile` before checkPairs (LUDICS_VENDOR_SYNC_INSTALL_CMD seam pins existence)", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "MARKED\n",
      "node_modules/marked/lib/marked.esm.js": "MARKED\n",
      "templates/dashboard/vendor/purify.es.js": "PURIFY\n",
      "node_modules/dompurify/dist/purify.es.mjs": "PURIFY\n",
    });
    const sentinel = join(root, "FRESHEN_INVOKED");
    try {
      // Fake `bun install --frozen-lockfile`: records its argv into a file so
      // the test can assert the freshen step ran with the AC-mandated flag.
      const installCmd = JSON.stringify([
        "sh",
        "-c",
        `printf '%s %s %s' "$0" "$1" "$2" > "${sentinel}"`,
        "bun",
        "install",
        "--frozen-lockfile",
      ]);
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-vendor-sync.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LUDICS_VENDOR_SYNC_INSTALL_CMD: installCmd },
      });
      if (result.exitCode !== 0) {
        console.error(result.stderr.toString());
        console.error(result.stdout.toString());
      }
      expect(result.exitCode).toBe(0);
      // The freshen step actually executed: the fake install wrote the sentinel.
      // If a future refactor removes the spawn, the sentinel won't appear and
      // this assertion fails — that's the invariant the AC names.
      expect(existsSync(sentinel)).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe(
        "bun install --frozen-lockfile",
      );
    } finally {
      cleanup();
    }
  });

  test("offline / failed install is a HARD error: non-zero exit + 'vendor sync indeterminate' diagnostic + captured stderr", () => {
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "MARKED\n",
      "node_modules/marked/lib/marked.esm.js": "MARKED\n",
      "templates/dashboard/vendor/purify.es.js": "PURIFY\n",
      "node_modules/dompurify/dist/purify.es.mjs": "PURIFY\n",
    });
    try {
      // Simulate offline / registry-unreachable by making the install command
      // print to stderr and exit non-zero.
      const installCmd = JSON.stringify([
        "sh",
        "-c",
        "printf 'fake registry unreachable\\n' >&2; exit 1",
      ]);
      const result = spawnSync({
        cmd: ["bun", "run", join(import.meta.dir, "lint-vendor-sync.ts"), root],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LUDICS_VENDOR_SYNC_INSTALL_CMD: installCmd },
      });
      // Hard fail: exit non-zero. A silent skip would have let checkPairs run
      // and (since fixtures match) returned 0 — that's the failure mode the
      // AC excludes.
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr).toContain(
        "could not refresh node_modules; vendor sync indeterminate",
      );
      // Captured stderr from the failing install propagates so the developer
      // can act on the underlying error.
      expect(stderr).toContain("fake registry unreachable");
    } finally {
      cleanup();
    }
  });

  test("argRoot without test-seam env var does NOT spawn — hermetic-test gate intact", () => {
    // If a future refactor breaks the `argRoot` gate, the freshen step would
    // run with the real `bun install --frozen-lockfile` against the host's
    // node_modules — the exact non-hermetic behaviour the AC forbids. Using
    // a fake install via the env-var seam would mask the regression, so this
    // test must NOT set LUDICS_VENDOR_SYNC_INSTALL_CMD. Instead, we install
    // a poisoned `bun` on PATH that exits non-zero with a known stderr
    // sentinel: if the freshen runs, the lint exits non-zero AND prints the
    // sentinel; if the gate holds, neither happens.
    const { root, cleanup } = makeFixture({
      "templates/dashboard/vendor/marked.esm.js": "M\n",
      "node_modules/marked/lib/marked.esm.js": "M\n",
      "templates/dashboard/vendor/purify.es.js": "P\n",
      "node_modules/dompurify/dist/purify.es.mjs": "P\n",
    });
    const fakeBinDir = mkdtempSync(join(tmpdir(), "lint-vendor-sync-fakebin-"));
    const fakeBunPath = join(fakeBinDir, "bun");
    const realBunPath = process.execPath;
    // Fake bun: if invoked with `install` as first arg, exit non-zero with a
    // sentinel stderr. Otherwise delegate to real bun (so `bun run script.ts`
    // still works for the lint itself).
    writeFileSync(
      fakeBunPath,
      `#!/bin/sh
if [ "$1" = "install" ]; then
  printf 'POISONED_BUN_INSTALL_RAN_UNEXPECTEDLY\\n' >&2
  exit 99
fi
exec ${JSON.stringify(realBunPath)} "$@"
`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync({
        cmd: [
          realBunPath,
          "run",
          join(import.meta.dir, "lint-vendor-sync.ts"),
          root,
        ],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          // No LUDICS_VENDOR_SYNC_INSTALL_CMD, no CI: the gate must rely
          // solely on argRoot to skip the freshen.
          CI: "",
          LUDICS_VENDOR_SYNC_INSTALL_CMD: "",
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).not.toContain(
        "POISONED_BUN_INSTALL_RAN_UNEXPECTEDLY",
      );
    } finally {
      cleanup();
      rmSync(fakeBinDir, { recursive: true, force: true });
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
