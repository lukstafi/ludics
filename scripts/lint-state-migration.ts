#!/usr/bin/env bun
/**
 * lint-state-migration.ts
 *
 * CI lint: detect drift between persisted-shape TypeScript types and the
 * checked-in `state.shape.snapshot.json`, and require any field touch to be
 * accompanied by both a migrator/read-boundary body diff and a legacy-fixture
 * test diff in the same commit.
 *
 * Operationalises gh-ludics-479 (Action 2). The reviewer paragraph in
 * `skills/orchestration/pair-reviewer-plan-review.md` is the catch-all; this
 * lint catches the highest-traffic surface mechanically on round one.
 *
 * Exit code (symmetric — both directions are fatal):
 *   0 — every allowlisted type's field set matches its snapshot, OR a
 *       mismatch is paired with the required migrator-body and test-file
 *       touches.
 *   1 — any unpaired violation: added/changed field with no migrator change,
 *       OR snapshot drift with no co-changes at all.
 */

// SILENT-DRIFT WARNING (gh-ludics-479):
// `extractTypeFields` is a regex-over-source extractor. Its safety claim —
// "every persisted-shape type's field set is recorded" — depends on the
// declarations matching the literal patterns below. Recognised forms:
//
//   `export interface <TypeName> {`     ← OrchestrationState, OrchestrationConfig,
//                                         CleanupEntry, PreemptStash,
//                                         SessionSweepState, SlotData
//   `interface <TypeName> {`            ← TmuxSlotState (non-exported)
//
// Field-line pattern: `/^\s+(\w+)\??\s*[:?]/` against each declaration body.
// Comment lines (`//`, `/*`, `*`) and blank lines are skipped.
//
// The lint goes silent (zero hits, zero violations) if any of these refactors
// land without an extractor update:
//   - `extends BaseType` — inherited fields are ignored.
//   - `Pick<...>` / `Omit<...>` / intersection / union composition.
//   - Generated fields (`[K in keyof T]: ...`).
//   - Type aliases (`type T = { ... }`) instead of `interface T { ... }`.
//
// Day-one allowlist members do NOT use any of these. If you change one of
// them to use one of those forms, update `extractTypeFields` in the same
// commit AND add a regression test that exercises the new extractor branch.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Allowlist + migrator-site map
// ---------------------------------------------------------------------------

export interface PersistedType {
  /** Type name as it appears in the source file (e.g. `OrchestrationState`). */
  readonly typeName: string;
  /** Repo-relative path to the source file declaring the type. */
  readonly sourcePath: string;
}

/** Day-one allowlist (gh-ludics-479 user 2026-05-02 Q4: broad). Adding a new
 *  persisted JSON shape that doesn't appear here is silently uncovered by
 *  this lint — reviewer-side guidance in pair-reviewer-plan-review.md is the
 *  catch-all for that case. */
export const PERSISTED_TYPES: ReadonlyArray<PersistedType> = [
  // OrchestrationState / OrchestrationConfig pair first — they share the
  // canonical migrator and are the highest-traffic shapes.
  { typeName: "OrchestrationState", sourcePath: "src/orchestration/state.ts" },
  { typeName: "OrchestrationConfig", sourcePath: "src/orchestration/state.ts" },
  // Remaining entries alphabetised by typeName.
  { typeName: "CleanupEntry", sourcePath: "src/orchestration/deferred-cleanup.ts" },
  { typeName: "PreemptStash", sourcePath: "src/slots/preempt.ts" },
  { typeName: "SessionSweepState", sourcePath: "src/sessions/sweep-state.ts" },
  { typeName: "SlotData", sourcePath: "src/slots/types.ts" },
  { typeName: "TmuxSlotState", sourcePath: "src/adapters/tmux-adapter.ts" },
];

export interface MigratorSite {
  /** Repo-relative path to the file containing the migrator/read-boundary. */
  readonly path: string;
  /** Function name as declared (`function <fnName>(` or
   *  `export function <fnName>(`). The diff-parser greps for body diffs
   *  inside this function specifically — touching any other function in the
   *  same file does NOT clear a violation. */
  readonly fnName: string;
}

/** Per-type read-boundary normalizer. The lint requires a `git diff` body hit
 *  inside this exact function when the type's field set drifts from the
 *  snapshot.
 *
 *  SlotData → normalizeTaskId is the day-one mapping (see proposal §
 *  "Read-boundary normalizers (per-type)" and gh-ludics-479 plan
 *  assumption-gap 2). If SlotData accumulates more migration concerns,
 *  extracting a proper `migrateSlotData(data)` helper is the natural
 *  follow-up; this map is the single update site. */
export const MIGRATOR_SITES: Readonly<Record<string, MigratorSite>> = {
  OrchestrationState: { path: "src/orchestration/state.ts", fnName: "migrateState" },
  OrchestrationConfig: { path: "src/orchestration/state.ts", fnName: "migrateState" },
  CleanupEntry: { path: "src/orchestration/deferred-cleanup.ts", fnName: "loadDeferredCleanups" },
  PreemptStash: { path: "src/slots/preempt.ts", fnName: "readStash" },
  SessionSweepState: { path: "src/sessions/sweep-state.ts", fnName: "loadSessionSweepState" },
  SlotData: { path: "src/slots/json.ts", fnName: "normalizeTaskId" },
  TmuxSlotState: { path: "src/adapters/tmux-adapter.ts", fnName: "readTmuxSlotState" },
};

export const SNAPSHOT_PATH = "scripts/snapshots/state.shape.snapshot.json";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Extract field names from a single interface body. Returns `null` when the
 *  named type is not present in the source. Supports both
 *  `export interface <T> {` and bare `interface <T> {` declarations. Stops
 *  at the matching closing brace (one nesting level deep — sufficient for
 *  every allowlist member today; see SILENT-DRIFT WARNING above). */
export function extractTypeFields(source: string, typeName: string): string[] | null {
  const declarePattern = new RegExp(
    `(?:^|\\n)(?:export\\s+)?interface\\s+${escapeRegex(typeName)}\\s*\\{`,
    "m",
  );
  const match = declarePattern.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = source.slice(start, end);
  const fields = new Set<string>();
  const fieldPattern = /^\s+(\w+)\??\s*[:?]/;
  // Track brace depth across the body so nested-object types (e.g.
  // `staleBaseLastWarned?: { coder?: {...}; reviewer?: {...}; };`) don't
  // bleed their nested members into the top-level field set. We're at the
  // interface body itself at line-walker depth 0 (the outer `{` was consumed
  // during the declaration match); a top-level field begins at depth 0, and
  // any line whose first `{`/`}` action raises us above 0 belongs to a
  // nested type.
  let lineDepth = 0;
  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("/*") &&
        !trimmed.startsWith("*") && lineDepth === 0) {
      const m = fieldPattern.exec(rawLine);
      if (m) fields.add(m[1]!);
    }
    // Update depth from any braces on this line (after deciding whether the
    // line itself was a top-level field declaration).
    for (const ch of rawLine) {
      if (ch === "{") lineDepth++;
      else if (ch === "}") lineDepth--;
    }
  }
  return [...fields].sort();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Snapshot = Record<string, string[]>;

export function loadSnapshot(root: string): Snapshot | null {
  const file = join(root, SNAPSHOT_PATH);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf-8");
  return JSON.parse(raw) as Snapshot;
}

/** Write the snapshot with deterministic, alphabetically-sorted output:
 *  keys sorted, value arrays sorted, two-space indent, trailing newline. */
export function writeSnapshot(root: string, snapshot: Snapshot): void {
  const sorted: Snapshot = {};
  for (const key of Object.keys(snapshot).sort()) {
    sorted[key] = [...snapshot[key]!].sort();
  }
  const file = join(root, SNAPSHOT_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
}

/** Build a snapshot from live source files under `root`. */
export function buildSnapshot(
  root: string,
  types: ReadonlyArray<PersistedType> = PERSISTED_TYPES,
): Snapshot {
  const out: Snapshot = {};
  for (const t of types) {
    const sourceAbs = join(root, t.sourcePath);
    if (!existsSync(sourceAbs)) continue;
    const source = readFileSync(sourceAbs, "utf-8");
    const fields = extractTypeFields(source, t.typeName);
    if (fields) out[t.typeName] = fields;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shape violations
// ---------------------------------------------------------------------------

export type ShapeViolationKind =
  | "type-missing"
  | "snapshot-missing-type"
  | "field-added"
  | "field-removed";

export type CoChangeMissingKind = "co-change-missing";

export interface ShapeViolation {
  readonly kind: ShapeViolationKind;
  readonly typeName: string;
  readonly sourcePath: string;
  readonly fields?: string[];
  readonly hint: string;
}

export interface CoChangeViolation {
  readonly kind: CoChangeMissingKind;
  readonly typeName: string;
  /** What the diff was missing. `"both"` means neither migrator nor test was
   *  touched in the same diff. */
  readonly missing: "migrator" | "test" | "both";
  readonly migratorSite: MigratorSite;
  readonly hint: string;
}

export type Violation = ShapeViolation | CoChangeViolation;

/** Compare live source field sets against the snapshot and return one
 *  violation per drifting type. Pure: no git diff inspection, no migrator
 *  matching — that's `enforceCoChange`'s job. */
export function checkShapes(
  root: string,
  types: ReadonlyArray<PersistedType> = PERSISTED_TYPES,
  snapshot: Snapshot | null = loadSnapshot(root),
): ShapeViolation[] {
  const violations: ShapeViolation[] = [];
  const snap = snapshot ?? {};
  for (const t of types) {
    const sourceAbs = join(root, t.sourcePath);
    if (!existsSync(sourceAbs)) {
      violations.push({
        kind: "type-missing",
        typeName: t.typeName,
        sourcePath: t.sourcePath,
        hint: `Source file ${t.sourcePath} not found — did the type move?`,
      });
      continue;
    }
    const source = readFileSync(sourceAbs, "utf-8");
    const liveFields = extractTypeFields(source, t.typeName);
    if (liveFields === null) {
      violations.push({
        kind: "type-missing",
        typeName: t.typeName,
        sourcePath: t.sourcePath,
        hint:
          `Type ${t.typeName} not found in ${t.sourcePath} — refactor to ` +
          `extends/Pick/Omit/composition? See SILENT-DRIFT WARNING in lint-state-migration.ts.`,
      });
      continue;
    }
    const snapFields = snap[t.typeName];
    if (snapFields === undefined) {
      violations.push({
        kind: "snapshot-missing-type",
        typeName: t.typeName,
        sourcePath: t.sourcePath,
        fields: liveFields,
        hint:
          `${t.typeName} is in PERSISTED_TYPES but absent from the snapshot. ` +
          `Run \`bun scripts/lint-state-migration.ts --update\` to bootstrap it.`,
      });
      continue;
    }
    const liveSet = new Set(liveFields);
    const snapSet = new Set(snapFields);
    const added = liveFields.filter((f) => !snapSet.has(f));
    const removed = snapFields.filter((f) => !liveSet.has(f));
    if (added.length > 0) {
      violations.push({
        kind: "field-added",
        typeName: t.typeName,
        sourcePath: t.sourcePath,
        fields: added,
        hint:
          `${t.typeName} has new fields not in snapshot: ${added.join(", ")}. ` +
          `Touch ${MIGRATOR_SITES[t.typeName]?.fnName ?? "<migrator>"} + a ` +
          `*.migrate*.test.ts (or sibling test) and run --update.`,
      });
    }
    if (removed.length > 0) {
      violations.push({
        kind: "field-removed",
        typeName: t.typeName,
        sourcePath: t.sourcePath,
        fields: removed,
        hint:
          `${t.typeName} dropped fields present in snapshot: ${removed.join(", ")}. ` +
          `Touch ${MIGRATOR_SITES[t.typeName]?.fnName ?? "<migrator>"} (e.g. ` +
          `\`delete state.${removed[0]}\`) + a *.migrate*.test.ts and run --update.`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Co-change diff parsing
// ---------------------------------------------------------------------------

export interface DiffEnv {
  /** Decoded `git diff` text (file-mode unified diff). */
  readonly diff: string;
}

/** Resolve the diff base. Priority:
 *    1. `process.env.GIT_BASE` — explicit CI override.
 *    2. `git -C <root> merge-base origin/main HEAD` — the standard fork-point.
 *  Returns `null` when neither resolves (working-tree-only mode). */
export function resolveBase(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GIT_BASE) return env.GIT_BASE;
  const out = spawnSync("git", ["-C", root, "merge-base", "origin/main", "HEAD"], {
    encoding: "utf-8",
  });
  if (out.status === 0 && out.stdout.trim()) return out.stdout.trim();
  return null;
}

/** Run `git diff` against `base` (or the working tree when `base` is null). */
export function gitDiff(root: string, base: string | null): string {
  const args = base
    ? ["-C", root, "diff", "--unified=0", base, "--", "."]
    : ["-C", root, "diff", "--unified=0", "HEAD", "--", "."];
  const out = spawnSync("git", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return out.stdout ?? "";
}

interface DiffFile {
  readonly path: string;
  readonly hunks: ReadonlyArray<DiffHunk>;
}

interface DiffHunk {
  /** Starting line number on the new (`+`) side of the hunk. */
  readonly newStart: number;
  /** All lines belonging to this hunk, including the `@@` header. */
  readonly lines: ReadonlyArray<string>;
}

/** Parse unified-diff text into a list of per-file hunks. Cheap regex pass —
 *  no full diff library, no rename detection. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");
  let currentPath: string | null = null;
  let currentHunks: DiffHunk[] = [];
  let currentLines: string[] = [];
  let currentNewStart = 0;
  const flushHunk = () => {
    if (currentLines.length > 0) {
      currentHunks.push({ newStart: currentNewStart, lines: currentLines });
      currentLines = [];
    }
  };
  const flushFile = () => {
    flushHunk();
    if (currentPath !== null && currentHunks.length > 0) {
      files.push({ path: currentPath, hunks: currentHunks });
    }
    currentPath = null;
    currentHunks = [];
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("+++ ") && line.includes("/dev/null")) {
      currentPath = null;
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      const m = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      currentNewStart = m ? parseInt(m[1]!, 10) : 0;
      currentLines = [line];
      continue;
    }
    if (currentLines.length > 0 && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "")) {
      currentLines.push(line);
    }
  }
  flushFile();
  return files;
}

/** Locate the byte range of a function body in `source`. Matches both
 *  `function <fnName>(` and `export function <fnName>(`. Returns the
 *  inclusive [startLine, endLine] (1-based) of the function body, or
 *  `null` if not found. */
export function locateFunctionBody(
  source: string,
  fnName: string,
): { startLine: number; endLine: number } | null {
  const declarePattern = new RegExp(
    `(?:^|\\n)(?:export\\s+)?function\\s+${escapeRegex(fnName)}\\s*\\(`,
    "m",
  );
  const match = declarePattern.exec(source);
  if (!match) return null;
  // Find the opening brace after the parameter list.
  let i = match.index + match[0].length;
  let parens = 1;
  while (i < source.length && parens > 0) {
    const ch = source[i++];
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
  }
  while (i < source.length && source[i] !== "{") i++;
  if (source[i] !== "{") return null;
  const bodyStart = i;
  let depth = 1;
  i++;
  while (i < source.length && depth > 0) {
    const ch = source[i++];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) return null;
  const bodyEnd = i;
  // Convert byte offsets to 1-based line numbers.
  const startLine = source.slice(0, bodyStart).split("\n").length;
  const endLine = source.slice(0, bodyEnd).split("\n").length;
  return { startLine, endLine };
}

/** Returns true if any `+`/`-` line in the diff for `filePath` falls inside
 *  the body of `fnName`. Matches the "textual diff hit on the function body,
 *  not just adjacent lines" requirement of AC #7. */
export function hasFunctionBodyDiff(
  diffFiles: ReadonlyArray<DiffFile>,
  filePath: string,
  fnName: string,
  source: string,
): boolean {
  const range = locateFunctionBody(source, fnName);
  if (!range) return false;
  for (const f of diffFiles) {
    if (f.path !== filePath) continue;
    for (const hunk of f.hunks) {
      // Walk the hunk and track current new-side line number for `+`/` ` lines
      // and old-side for `-` lines. We accept either side falling inside the
      // body range, since the migrator function's body location is a property
      // of the post-diff source — a `-` line removed from inside the body
      // counts as a body touch.
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith("@@")) continue;
        if (line.startsWith("+")) {
          if (newLine >= range.startLine && newLine <= range.endLine) return true;
          newLine++;
        } else if (line.startsWith("-")) {
          // Old-side removal — also inside body if newLine is within range
          // (the removal is anchored where the next + line lands).
          if (newLine >= range.startLine && newLine <= range.endLine) return true;
        } else {
          newLine++;
        }
      }
    }
  }
  return false;
}

/** Return the set of changed test file paths whose names match the
 *  legacy-fixture conventions (`*.migrate*.test.ts`, `state*.test.ts`) or
 *  that live in the same directory as one of the migrator-site files. */
export function findChangedTestFiles(
  diffFiles: ReadonlyArray<DiffFile>,
  sites: ReadonlyArray<MigratorSite> = Object.values(MIGRATOR_SITES),
): string[] {
  const siteDirs = new Set(sites.map((s) => dirname(s.path)));
  const out: string[] = [];
  for (const f of diffFiles) {
    if (!f.path.endsWith(".test.ts")) continue;
    const basename = f.path.split("/").pop() ?? "";
    const matchesName = /^.+\.migrate.*\.test\.ts$/.test(basename) ||
                        /^state.*\.test\.ts$/.test(basename);
    const matchesDir = siteDirs.has(dirname(f.path));
    if (matchesName || matchesDir) out.push(f.path);
  }
  return out;
}

/** For each shape violation, emit a co-change-missing violation when the
 *  paired diff doesn't show a migrator-body touch and a test-file touch.
 *  Pure — accepts the diff text and a per-type source-reader so tests can
 *  drive it without filesystem access for the post-diff sources. */
export function enforceCoChange(
  shapeViolations: ReadonlyArray<ShapeViolation>,
  diffFiles: ReadonlyArray<DiffFile>,
  readSource: (path: string) => string | null,
): CoChangeViolation[] {
  const out: CoChangeViolation[] = [];
  // Group by typeName so two violations on the same type (field-added +
  // field-removed) only emit one co-change violation.
  const seen = new Set<string>();
  const testFiles = findChangedTestFiles(diffFiles);
  for (const v of shapeViolations) {
    if (seen.has(v.typeName)) continue;
    seen.add(v.typeName);
    if (v.kind === "type-missing") continue;
    const site = MIGRATOR_SITES[v.typeName];
    if (!site) continue; // type in allowlist but no migrator site — should not happen
    const source = readSource(site.path);
    const migratorTouched = source !== null
      ? hasFunctionBodyDiff(diffFiles, site.path, site.fnName, source)
      : false;
    const testTouched = testFiles.length > 0;
    if (migratorTouched && testTouched) continue;
    const missing: CoChangeViolation["missing"] = !migratorTouched && !testTouched
      ? "both"
      : !migratorTouched
        ? "migrator"
        : "test";
    out.push({
      kind: "co-change-missing",
      typeName: v.typeName,
      missing,
      migratorSite: site,
      hint: missingHint(missing, site, v.typeName),
    });
  }
  return out;
}

function missingHint(
  missing: CoChangeViolation["missing"],
  site: MigratorSite,
  typeName: string,
): string {
  switch (missing) {
    case "migrator":
      return `${typeName} drifted but ${site.fnName} in ${site.path} was not touched in this diff. ` +
        `Add a migrator update (or a no-op comment-line touch for additive fields).`;
    case "test":
      return `${typeName} drifted but no *.migrate*.test.ts (or sibling test) was touched. ` +
        `Add a legacy-fixture test under ${dirname(site.path)} or any *.migrate*.test.ts.`;
    case "both":
      return `${typeName} drifted but neither ${site.fnName} in ${site.path} nor a ` +
        `legacy-fixture test was touched. Pair the type change with both.`;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatViolation(v: Violation): string {
  if (v.kind === "co-change-missing") {
    return [
      `     ${v.typeName}  (co-change-missing)`,
      `       missing:  ${v.missing}`,
      `       migrator: ${v.migratorSite.fnName} in ${v.migratorSite.path}`,
      `       hint:     ${v.hint}`,
    ].join("\n");
  }
  const fields = v.fields ? ` [${v.fields.join(", ")}]` : "";
  return [
    `     ${v.typeName}  (${v.kind})${fields}`,
    `       source:   ${v.sourcePath}`,
    `       hint:     ${v.hint}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly root: string;
  readonly update: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export function parseArgv(argv: ReadonlyArray<string>, defaultRoot: string): RunOptions {
  const positional: string[] = [];
  let update = false;
  for (const a of argv) {
    if (a === "--update" || a === "--write") update = true;
    else if (a.startsWith("--")) continue;
    else positional.push(a);
  }
  const root = positional[0] ?? defaultRoot;
  return { root, update, env: process.env };
}

export function run(opts: RunOptions): { exitCode: number; stdout: string; stderr: string } {
  if (opts.update) {
    const snap = buildSnapshot(opts.root);
    writeSnapshot(opts.root, snap);
    return {
      exitCode: 0,
      stdout: `✅  Wrote ${SNAPSHOT_PATH} with ${Object.keys(snap).length} types.\n`,
      stderr: "",
    };
  }

  const snapshot = loadSnapshot(opts.root);
  if (snapshot === null) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `\n❌  ${SNAPSHOT_PATH} not found.\n` +
        `     Run \`bun scripts/lint-state-migration.ts --update\` to bootstrap.\n`,
    };
  }
  const shapeViolations = checkShapes(opts.root, PERSISTED_TYPES, snapshot);
  if (shapeViolations.length === 0) {
    return {
      exitCode: 0,
      stdout: `✅  All ${PERSISTED_TYPES.length} persisted-shape types match the snapshot.\n`,
      stderr: "",
    };
  }
  // Drift detected — require co-change.
  const base = resolveBase(opts.root, opts.env);
  const diff = gitDiff(opts.root, base);
  const diffFiles = parseDiff(diff);
  const readSource = (rel: string): string | null => {
    const abs = join(opts.root, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf-8");
  };
  const coChange = enforceCoChange(shapeViolations, diffFiles, readSource);
  const all: Violation[] = [...shapeViolations, ...coChange];

  const lines: string[] = [];
  lines.push(`\n❌  ${all.length} state-migration ${all.length === 1 ? "violation" : "violations"}:\n`);
  for (const v of all) lines.push(formatViolation(v));
  lines.push(
    "\n     Persisted-shape field touches must be paired with a migrator-body diff",
    "     (the function in MIGRATOR_SITES) and a *.migrate*.test.ts touch. Run",
    "     `bun scripts/lint-state-migration.ts --update` to refresh the snapshot",
    "     after legitimate shape changes are paired with their migrator + test.",
    "     See docs/orchestration-patterns.md § Read-boundary backfill for optional fields.\n",
  );
  return { exitCode: 1, stdout: "", stderr: lines.join("\n") };
}

if (import.meta.main) {
  const defaultRoot = join(import.meta.dir, "..");
  const opts = parseArgv(process.argv.slice(2), defaultRoot);
  const result = run(opts);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
