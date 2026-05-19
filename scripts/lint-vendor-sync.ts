#!/usr/bin/env bun
/**
 * lint-vendor-sync.ts
 *
 * CI lint: detect byte-for-byte drift between the vendored copies under
 * `templates/dashboard/vendor/` and their upstream `node_modules/` originals.
 *
 * The dashboard markdown renderer test imports `marked` and `dompurify` from
 * `node_modules/`, while the browser loads vendored copies. The only thing
 * keeping those aligned today is the manual "To bump" ritual in
 * `templates/dashboard/vendor/README.md`. This lint makes drift impossible to
 * land silently.
 *
 * Exit code:
 *   0 — every pairing's bytes match
 *   1 — at least one pairing differs, or a side is missing
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Pair {
  /** Repo-relative path of the vendored copy (the source of truth for the browser). */
  readonly vendored: string;
  /** Repo-relative path of the upstream copy in `node_modules/`. */
  readonly upstream: string;
}

/** Adding a new vendored library is one entry. Both sides are stored as full
 *  paths because the filename extension can differ between the vendored copy
 *  and the upstream (`purify.es.js` vs `purify.es.mjs`). */
export const PAIRS: ReadonlyArray<Pair> = [
  {
    vendored: "templates/dashboard/vendor/marked.esm.js",
    upstream: "node_modules/marked/lib/marked.esm.js",
  },
  {
    vendored: "templates/dashboard/vendor/purify.es.js",
    upstream: "node_modules/dompurify/dist/purify.es.mjs",
  },
];

export type ViolationKind =
  | "missing-upstream"
  | "missing-vendored"
  | "bytes-differ";

export interface Violation {
  readonly pair: Pair;
  readonly kind: ViolationKind;
  readonly vendoredBytes?: number;
  readonly upstreamBytes?: number;
  readonly hint: string;
}

function fileSize(absPath: string): number {
  return statSync(absPath).size;
}

/** Pure check function: takes a repo root and a pairing array, returns one
 *  violation per drifting pair. Exported so tests can drive it against a tmp
 *  fixture root with synthetic pairings, no real `node_modules/` required. */
export function checkPairs(
  root: string,
  pairs: ReadonlyArray<Pair> = PAIRS,
): Violation[] {
  const violations: Violation[] = [];
  for (const pair of pairs) {
    const vendoredAbs = join(root, pair.vendored);
    const upstreamAbs = join(root, pair.upstream);
    const vendoredExists = existsSync(vendoredAbs);
    const upstreamExists = existsSync(upstreamAbs);

    if (!upstreamExists) {
      violations.push({
        pair,
        kind: "missing-upstream",
        vendoredBytes: vendoredExists ? fileSize(vendoredAbs) : undefined,
        hint:
          `Upstream not found at ${pair.upstream} — did you forget \`bun install\`?`,
      });
      continue;
    }
    if (!vendoredExists) {
      violations.push({
        pair,
        kind: "missing-vendored",
        upstreamBytes: fileSize(upstreamAbs),
        hint: `Vendored copy missing — \`cp ${pair.upstream} ${pair.vendored}\``,
      });
      continue;
    }

    const vendoredBytes = readFileSync(vendoredAbs);
    const upstreamBytes = readFileSync(upstreamAbs);
    if (!vendoredBytes.equals(upstreamBytes)) {
      violations.push({
        pair,
        kind: "bytes-differ",
        vendoredBytes: vendoredBytes.length,
        upstreamBytes: upstreamBytes.length,
        hint: `Resolve drift: \`cp ${pair.upstream} ${pair.vendored}\``,
      });
    }
  }
  return violations;
}

export function formatViolation(v: Violation): string {
  const head = `     ${v.pair.vendored}  ⇄  ${v.pair.upstream}`;
  switch (v.kind) {
    case "bytes-differ":
      return [
        head,
        `       kind:     bytes-differ`,
        `       vendored: ${v.vendoredBytes} bytes`,
        `       upstream: ${v.upstreamBytes} bytes`,
        `       fix:      ${v.hint}`,
      ].join("\n");
    case "missing-upstream":
      return [
        head,
        `       kind:     missing-upstream`,
        `       vendored: ${v.vendoredBytes ?? "(also missing)"} bytes`,
        `       fix:      ${v.hint}`,
      ].join("\n");
    case "missing-vendored":
      return [
        head,
        `       kind:     missing-vendored`,
        `       upstream: ${v.upstreamBytes} bytes`,
        `       fix:      ${v.hint}`,
      ].join("\n");
  }
}

/** Default install command run by `freshenNodeModules`. `--frozen-lockfile` is
 *  mandatory: this command must never mutate `bun.lock`, only resolve it. */
export const DEFAULT_FRESHEN_CMD: ReadonlyArray<string> = [
  "bun",
  "install",
  "--frozen-lockfile",
];

/** Spawns `bun install --frozen-lockfile` to bring `node_modules/` in line with
 *  the locked resolution before `checkPairs` runs. The drift this closes is
 *  documented in gh-ludics-531: stale local `node_modules/` masks vendored-vs-
 *  upstream skew because the byte compare passes against the leftover install,
 *  while CI starts cold and surfaces the failure on an unrelated PR.
 *
 *  Test seam: `LUDICS_VENDOR_SYNC_INSTALL_CMD` (a JSON-encoded string array)
 *  swaps the spawned argv. Only used by `lint-vendor-sync.test.ts` to drive
 *  this code path without invoking the real `bun install` against the host. */
export function freshenNodeModules(
  cwd: string,
): { ok: true } | { ok: false; stderr: string } {
  const override = process.env.LUDICS_VENDOR_SYNC_INSTALL_CMD;
  let cmd: string[];
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
        return {
          ok: false,
          stderr: `LUDICS_VENDOR_SYNC_INSTALL_CMD must be a JSON array of strings, got: ${override}`,
        };
      }
      cmd = parsed;
    } catch (e) {
      return { ok: false, stderr: `LUDICS_VENDOR_SYNC_INSTALL_CMD JSON parse error: ${String(e)}` };
    }
  } else {
    cmd = [...DEFAULT_FRESHEN_CMD];
  }
  try {
    const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      return { ok: false, stderr: result.stderr?.toString() ?? "" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, stderr: String(e) };
  }
}

if (import.meta.main) {
  // Optional first positional arg overrides the repo root, which lets tests
  // exercise the real CLI exit-code paths against a temp directory built with
  // the same `templates/dashboard/vendor/...` + `node_modules/...` shape that
  // PAIRS expects. Mirrors `lint-template-safety.ts`'s argv override.
  const argRoot = process.argv[2];
  const repoRoot = join(import.meta.dir, "..");
  const root = argRoot ? argRoot : repoRoot;
  // Freshen `node_modules/` before comparing so a stale local install can't
  // mask drift between the vendored copies and the actually-locked resolution
  // (gh-ludics-531). The gate skips the freshen when:
  //   - `process.env.CI` is set: CI's `Install dependencies` step already
  //     produced a fresh, frozen-lockfile install, so a second spawn is pure
  //     overhead on the critical path.
  //   - `argRoot` is provided: hermetic tests drive a tmp fixture root and
  //     must not mutate the host's `node_modules/`.
  // The `LUDICS_VENDOR_SYNC_INSTALL_CMD` env var force-enables the freshen
  // step with a swapped command — the test seam that drives this branch
  // without invoking real `bun install`.
  const forceFreshen = !!process.env.LUDICS_VENDOR_SYNC_INSTALL_CMD;
  const shouldFreshen = forceFreshen || (!argRoot && !process.env.CI);
  if (shouldFreshen) {
    const freshen = freshenNodeModules(argRoot ?? repoRoot);
    if (!freshen.ok) {
      console.error(
        "❌  could not refresh node_modules; vendor sync indeterminate",
      );
      if (freshen.stderr) {
        console.error(freshen.stderr);
      }
      console.error(
        "\n     `bun install --frozen-lockfile` failed before the lint could run.\n" +
        "     This usually means: offline / no registry access, a broken bun\n" +
        "     install, or a lockfile that doesn't match `package.json`.\n" +
        "     Fix the install error above, then re-run `bun run lint:vendor-sync`.\n",
      );
      process.exit(1);
    }
  }
  const violations = checkPairs(root);
  if (violations.length === 0) {
    console.log(
      "✅  All vendored files match their node_modules upstreams byte-for-byte.",
    );
    process.exit(0);
  }
  const noun = violations.length === 1 ? "violation" : "violations";
  console.error(
    `\n❌  ${violations.length} vendor-sync ${noun}:\n`,
  );
  for (const v of violations) {
    console.error(formatViolation(v));
  }
  console.error(
    "\n     The vendored copy is what the browser loads; the npm copy is what tests\n" +
    "     import. They MUST stay byte-identical so a version bump can't ship a\n" +
    "     skewed renderer to the dashboard while tests pass against the npm side.\n" +
    "     See templates/dashboard/vendor/README.md for the bump ritual.\n",
  );
  process.exit(1);
}
