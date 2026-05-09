#!/usr/bin/env bun
/**
 * lint-no-nul-bytes.ts
 *
 * CI lint: tracked text files (`.ts`, `.tsx`, `.md`, `.json`, `.yaml`, `.yml`)
 * must not contain a NUL byte (`0x00`). A literal NUL inside a TypeScript
 * source file (e.g. a `/^\0NEVER_MATCH/` regex sentinel) flips git's
 * text/binary detection — `git diff --numstat` reports `- -` and the file
 * becomes opaque in PR review. The historical offender was
 * `docs/swe-textbook.shape.test.ts`; commit `9f911db` replaced the
 * NUL-bearing closer with a `sliceToEnd(body, opener)` helper. This lint
 * pins the post-fix invariant so it cannot regress silently.
 *
 * Update the `TEXT_EXTENSIONS` set when introducing a new tracked text
 * extension (e.g. `.toml`, `.html`). The check is whole-file, so a NUL byte
 * past the first ~8KB is also caught (git's heuristic only inspects the
 * leading bytes).
 *
 * Exit code:
 *   0 — every scanned file is NUL-free
 *   1 — one or more offending files found (paths printed to stderr)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, sep } from "path";

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".json", ".yaml", ".yml"]);

// Build-output and vendored trees that aren't part of the repo's source. We
// don't skip dot-directories in general — that matches the GNU-grep
// semantics documented in `lint-no-mock-module.ts` (codex P2 on PR #468) so
// an offending file under e.g. `src/.something/` cannot hide. `.git/` is
// listed explicitly because git's object store contains pack files that
// happen to have no scanned extension today, and we'd rather be defensive
// than rely on the extension filter.
const SKIP_DIR_NAMES = new Set(["node_modules", "bin", "dist", ".git"]);

function hasTextExtension(name: string): boolean {
  for (const ext of TEXT_EXTENSIONS) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}

/** Recursively walk `dir` and return every text-extension file (absolute paths). */
export function listTextFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      const full = join(cur, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && hasTextExtension(entry)) out.push(full);
    }
  }
  return out.sort();
}

export interface RunLintResult {
  exitCode: number;
  /** Repo-relative paths (forward slashes) of files containing a NUL byte. */
  offenders: string[];
}

/**
 * Scan every text-extension file under `root` for a NUL byte. Returns the
 * offending repo-relative paths and an exitCode of 1 if any are found.
 */
export function runLint(root: string): RunLintResult {
  const offenders: string[] = [];
  for (const abs of listTextFiles(root)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      continue;
    }
    if (bytes.includes(0)) {
      offenders.push(relative(root, abs).split(sep).join("/"));
    }
  }
  offenders.sort();
  return { exitCode: offenders.length > 0 ? 1 : 0, offenders };
}

if (import.meta.main) {
  // Optional first positional arg overrides the root directory, which lets
  // tests exercise the real CLI exit-code paths against a tmp fixture.
  const argRoot = process.argv[2];
  const root = argRoot ? argRoot : join(import.meta.dir, "..");
  const { exitCode, offenders } = runLint(root);

  if (exitCode === 0) {
    console.log("✅  No NUL bytes in tracked text files.");
    process.exit(0);
  }

  console.error(
    `\n❌  ${offenders.length} text file${offenders.length === 1 ? "" : "s"} contain${offenders.length === 1 ? "s" : ""} a NUL byte:`,
  );
  for (const f of offenders) {
    console.error(`     - ${f}`);
  }
  console.error(
    "\n     A NUL byte flips git's text/binary detection (`git diff --numstat` reports `- -`).",
  );
  console.error(
    "     If a regex sentinel needs to 'never match,' use an ASCII-printable token like",
  );
  console.error(
    "     /^__NEVER_MATCH_SENTINEL__$/ or refactor to a `sliceToEnd(body, opener)` helper.\n",
  );
  process.exit(1);
}
