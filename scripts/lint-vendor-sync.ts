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

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
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
