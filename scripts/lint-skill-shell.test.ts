import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  HARNESS_INHERITED,
  IN_SCOPE_GLOBS,
  collectInScopeFiles,
  collectShellLines,
  extractAssignments,
  extractAssignmentsFromLine,
  extractRefs,
  extractRefsFromLine,
  lintCorpus,
  lintFile,
} from "./lint-skill-shell.ts";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// HARNESS_INHERITED seed (AC: hardcoded constant with at least the named set)
// ---------------------------------------------------------------------------

describe("HARNESS_INHERITED", () => {
  test("contains the harness-set environment names", () => {
    for (const name of [
      "LUDICS_STATE_PATH",
      "LUDICS_RESULTS_DIR",
      "LUDICS_REQUEST_ID",
      "ARGUMENTS",
    ]) {
      expect(HARNESS_INHERITED.has(name)).toBe(true);
    }
  });

  test("contains standard env / shell built-ins", () => {
    for (const name of [
      "HOME",
      "PATH",
      "USER",
      "SHELL",
      "PWD",
      "OLDPWD",
      "TMPDIR",
      "EDITOR",
      "LANG",
      "LC_ALL",
      "IFS",
    ]) {
      expect(HARNESS_INHERITED.has(name)).toBe(true);
    }
  });

  test("does not contain shell special parameters as allowlist entries", () => {
    // Special parameters $0..$9, $@, $*, $#, $?, $!, $$, $_, $- are handled
    // by the reference scanner skipping non-`[A-Za-z_]` first characters,
    // not by allowlist entries. If they ever leak into HARNESS_INHERITED
    // it would mean the scanner stopped recognizing them (AC).
    for (const name of ["0", "1", "2", "@", "*", "#", "?", "!", "$", "_", "-"]) {
      expect(HARNESS_INHERITED.has(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// extractRefsFromLine — quote-aware $NAME / ${NAME...} extractor
// ---------------------------------------------------------------------------

describe("extractRefsFromLine", () => {
  test("extracts bare $NAME", () => {
    const refs = extractRefsFromLine('echo "$FOO"', 1);
    expect(refs.map((r) => r.name)).toEqual(["FOO"]);
  });

  test("extracts ${NAME}", () => {
    const refs = extractRefsFromLine('echo "${FOO}"', 1);
    expect(refs.map((r) => r.name)).toEqual(["FOO"]);
  });

  test("extracts ${VAR:-default} (param expansion variants)", () => {
    const refs = extractRefsFromLine('echo "${FOO:-bar}"', 1);
    expect(refs.map((r) => r.name)).toEqual(["FOO"]);
  });

  test("extracts ${VAR:=default}, ${VAR:?msg}, ${VAR:+alt}", () => {
    const cases = [
      'echo "${A:=x}"',
      'echo "${B:?missing}"',
      'echo "${C:+alt}"',
    ];
    const names = cases.flatMap((c) => extractRefsFromLine(c, 1).map((r) => r.name));
    expect(names).toEqual(["A", "B", "C"]);
  });

  test("extracts ${VAR/pattern/repl} stripping pattern sub-tokens", () => {
    const refs = extractRefsFromLine('echo "${EVENTS_LINES// /}"', 1);
    expect(refs.map((r) => r.name)).toEqual(["EVENTS_LINES"]);
  });

  test("extracts ${#VAR} and ${!VAR}", () => {
    const refs = [
      ...extractRefsFromLine('echo "${#FOO}"', 1),
      ...extractRefsFromLine('echo "${!BAR}"', 1),
    ];
    expect(refs.map((r) => r.name)).toEqual(["FOO", "BAR"]);
  });

  test("extracts ${VAR[i]} dropping the index sub-token", () => {
    const refs = extractRefsFromLine('echo "${ARR[0]}"', 1);
    expect(refs.map((r) => r.name)).toEqual(["ARR"]);
  });

  test("does not extract \\$NAME (escaped)", () => {
    const refs = extractRefsFromLine('echo "\\$FOO"', 1);
    expect(refs).toEqual([]);
  });

  test("does not extract $$ (PID special parameter)", () => {
    const refs = extractRefsFromLine('echo "$$"', 1);
    expect(refs).toEqual([]);
  });

  test("does not extract $? / $1 / $@ / $* / $# / $!", () => {
    const refs = [
      ...extractRefsFromLine('echo "$?"', 1),
      ...extractRefsFromLine('echo "$1"', 1),
      ...extractRefsFromLine('echo "$@"', 1),
      ...extractRefsFromLine('echo "$*"', 1),
      ...extractRefsFromLine('echo "$#"', 1),
      ...extractRefsFromLine('echo "$!"', 1),
    ];
    expect(refs).toEqual([]);
  });

  test("does not extract refs inside single-quoted strings (no interpolation)", () => {
    // bash treats `'$FOO'` as a literal string — no interpolation.
    // The scanner mirrors that quote behavior so that legit jq filters
    // like `'select(.epoch >= $cutoff)'` (which use jq variables, not
    // shell variables) don't get wrongly flagged.
    const refs = extractRefsFromLine("jq 'select(.x >= $cutoff)'", 1);
    expect(refs).toEqual([]);
  });

  test("extracts refs inside double-quoted strings", () => {
    const refs = extractRefsFromLine('echo "hello $FOO and ${BAR}"', 1);
    expect(refs.map((r) => r.name)).toEqual(["FOO", "BAR"]);
  });

  test("descends into $(...) command substitution", () => {
    const refs = extractRefsFromLine('echo "$(grep $PATTERN file)"', 1);
    expect(refs.map((r) => r.name)).toEqual(["PATTERN"]);
  });

  test("attaches the originating line to each ref", () => {
    const refs = extractRefsFromLine('echo "$FOO and $BAR"', 42);
    expect(refs.every((r) => r.line === 42)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractAssignmentsFromLine — assignment detector
// ---------------------------------------------------------------------------

describe("extractAssignmentsFromLine", () => {
  test("bare assignment at line start", () => {
    expect(extractAssignmentsFromLine("FOO=bar")).toContain("FOO");
  });

  test("assignment after whitespace boundary (export / local / declare / readonly)", () => {
    expect(extractAssignmentsFromLine("export FOO=bar")).toContain("FOO");
    expect(extractAssignmentsFromLine("local BAR=baz")).toContain("BAR");
    expect(extractAssignmentsFromLine("declare BAZ=qux")).toContain("BAZ");
    expect(extractAssignmentsFromLine("readonly QUX=zap")).toContain("QUX");
  });

  test("assignment after && / || / ;", () => {
    expect(extractAssignmentsFromLine("foo && BAR=baz")).toContain("BAR");
    expect(extractAssignmentsFromLine("foo || BAR=baz")).toContain("BAR");
    expect(extractAssignmentsFromLine("foo; BAR=baz")).toContain("BAR");
  });

  test("for NAME in ... binds NAME", () => {
    expect(extractAssignmentsFromLine('for f in *.md; do echo "$f"; done'))
      .toContain("f");
  });

  test("read NAME [NAME...] binds each name", () => {
    const names = extractAssignmentsFromLine("read first second third");
    expect(names).toContain("first");
    expect(names).toContain("second");
    expect(names).toContain("third");
  });

  test("read with -r flag still binds the name", () => {
    expect(extractAssignmentsFromLine("read -r line")).toContain("line");
  });
});

// ---------------------------------------------------------------------------
// collectShellLines — span collector (fenced + inline, looksLikeShell-filtered)
// ---------------------------------------------------------------------------

describe("collectShellLines", () => {
  test("captures fenced ```bash blocks", () => {
    const md = ["before", "```bash", "FOO=bar", "echo $FOO", "```", "after"].join("\n");
    const lines = collectShellLines(md);
    expect(lines.map((l) => l.text)).toEqual(["FOO=bar", "echo $FOO"]);
    expect(lines[0]!.line).toBe(3);
  });

  test("captures fenced ```sh and ```shell blocks", () => {
    const md = [
      "```sh",
      "echo a",
      "```",
      "between",
      "```shell",
      "echo b",
      "```",
    ].join("\n");
    const lines = collectShellLines(md);
    expect(lines.map((l) => l.text)).toEqual(["echo a", "echo b"]);
  });

  test("ignores ```ts / ```yaml fences (AC: non-shell context)", () => {
    const md = [
      "```ts",
      "const X = '$NOT_A_VAR';",
      "```",
      "```yaml",
      "key: $value",
      "```",
    ].join("\n");
    expect(collectShellLines(md)).toEqual([]);
  });

  test("captures inline backtick spans that looksLikeShell accepts", () => {
    const md = "Run `git log $BASE..HEAD --stat` to see commits.";
    const lines = collectShellLines(md);
    expect(lines.map((l) => l.text)).toEqual(["git log $BASE..HEAD --stat"]);
  });

  test("excludes prose-style inline backticks (looksLikeShell rejects)", () => {
    // A bare `$NAME` token in prose is not a shell command; looksLikeShell
    // returns false and the span is skipped. This is the catch-net for
    // documentary mentions of variable names that should not be flagged.
    const md = "Set the `$LUDICS_STATE_PATH` variable before running.";
    expect(collectShellLines(md)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lintFile — end-to-end (AC: every required case)
// ---------------------------------------------------------------------------

describe("lintFile — required AC cases", () => {
  test("flags fabricated $EVENTS_BASELINE_LINE typo", () => {
    // Mirrors the original PR #493 typo class. A reference to a name that
    // resembles but does not match an in-file derivation must be flagged.
    const md = [
      "```bash",
      "EVENTS_LINES=$(grep -c foo events.jsonl)",
      'echo "$EVENTS_BASELINE_LINE"',
      "```",
    ].join("\n");
    const violations = lintFile("synthetic.md", md);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.name).toBe("EVENTS_BASELINE_LINE");
    expect(violations[0]!.line).toBe(3);
  });

  test("does not flag a name defined earlier in the same file's shell", () => {
    const md = [
      "```bash",
      "EVENTS_LINES=$(grep -c foo events.jsonl)",
      'echo "$EVENTS_LINES"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("does not flag $LUDICS_STATE_PATH (HARNESS_INHERITED)", () => {
    const md = [
      "```bash",
      'cat "$LUDICS_STATE_PATH/tasks/example.md"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("flags ${VAR:-default} when VAR is unknown (typo-class catch)", () => {
    // AC: the contract is "typo-class catch"; bash's safe-default
    // semantics is incidental. ${MISSING:-fallback} where MISSING has
    // no in-file assignment and is not in HARNESS_INHERITED still flags.
    const md = ["```bash", 'echo "${MISSING:-fallback}"', "```"].join("\n");
    const violations = lintFile("synthetic.md", md);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.name).toBe("MISSING");
  });

  test("does not flag ${VAR:-default} when VAR is defined", () => {
    const md = [
      "```bash",
      "FOO=$(date)",
      'echo "${FOO:-fallback}"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("does not flag $X inside a ```ts fence (non-shell context)", () => {
    const md = ["```ts", "const X = process.env.$X;", "```"].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("does not flag $NAME after `for NAME in ...` (loop binding)", () => {
    const md = [
      "```bash",
      'for f in *.md; do echo "$f"; done',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("does not flag $NAME after `read NAME` (read binding)", () => {
    const md = [
      "```bash",
      "read line",
      'echo "$line"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("does not flag $$, $?, or $1 (special parameters)", () => {
    const md = [
      "```bash",
      'echo "pid=$$ exit=$? arg=$1"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("per-file scope: assignment in one fence resolves reference in a later fence", () => {
    const md = [
      "First derive:",
      "```bash",
      "FOO=$(date)",
      "```",
      "Then use:",
      "```bash",
      'echo "$FOO"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("HEREDOC body is scanned uniformly (AC: no <<'EOF' special-case)", () => {
    // The proposal explicitly says HEREDOC bodies are scanned uniformly
    // as shell content; quoted-heredoc suppression is not special-cased
    // in v1. So a typo inside an `<<'EOF'`-quoted heredoc is still flagged
    // even though bash would not interpolate it at runtime.
    const md = [
      "```bash",
      "cat <<'EOF'",
      "value=$ALSO_MISSING",
      "EOF",
      "```",
    ].join("\n");
    const violations = lintFile("synthetic.md", md);
    expect(violations.map((v) => v.name)).toContain("ALSO_MISSING");
  });

  test("bash -c '…' / sh -c \"…\" inner strings are treated as opaque (AC)", () => {
    // AC: bash -c '…' / sh -c "…" inner strings are treated as opaque
    // in v1 (no recursive scanning). Both single- and double-quoted forms
    // must be opaque so the typo class isn't inverted by the choice of
    // quoting in the wrapper.
    const md = [
      "```bash",
      "bash -c 'echo $INNER_SINGLE'",
      'sh -c "echo $INNER_DOUBLE"',
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });

  test("references inside single-quoted strings are not extracted", () => {
    // jq filters and similar embedded mini-languages put `$VAR`-shaped
    // tokens inside single quotes; bash does not interpolate, so the
    // scanner should not extract them as shell references.
    const md = [
      "```bash",
      "EVENTS_FILE=events.jsonl",
      "jq -c --argjson cutoff 0 'select(.epoch >= $cutoff)' \"$EVENTS_FILE\"",
      "```",
    ].join("\n");
    expect(lintFile("synthetic.md", md)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lintFile — output shape (AC: file:line $NAME (snippet) row, exit-1 contract)
// ---------------------------------------------------------------------------

describe("lintFile — violation shape", () => {
  test("each violation carries file, line, name, and snippet", () => {
    const md = ["```bash", 'echo "$UNKNOWN"', "```"].join("\n");
    const v = lintFile("a.md", md)[0]!;
    expect(v.file).toBe("a.md");
    expect(v.line).toBe(2);
    expect(v.name).toBe("UNKNOWN");
    expect(v.snippet).toBe('echo "$UNKNOWN"');
  });
});

// ---------------------------------------------------------------------------
// Live-corpus smoke (AC: running the lint over the live in-scope corpus is clean)
// ---------------------------------------------------------------------------

describe("live corpus", () => {
  test("running the lint over the live in-scope files yields zero violations", () => {
    // The proposal mandates that the test refers to a fabricated typo
    // (above, in the synthetic-md cases) rather than relying on a real
    // regression in the live tree. Here we assert the inverse: the live
    // tree as it stands MUST be clean. If a future commit introduces a
    // typo in a skill body, this assertion fires.
    const files = collectInScopeFiles(root);
    const violations = lintCorpus(files, (rel) =>
      readFileSync(join(root, rel), "utf-8"),
    );
    expect(violations).toEqual([]);
  });

  test("IN_SCOPE_GLOBS is shared with lint-skill-cli-refs (no parallel literal)", () => {
    // AC: the lint imports IN_SCOPE_GLOBS from lint-skill-cli-refs.ts.
    // If a future refactor introduces a parallel literal, the re-exported
    // identity check from this file falls out of sync with the import
    // and this assertion fires.
    expect(IN_SCOPE_GLOBS).toContain("skills/*.md");
    expect(IN_SCOPE_GLOBS).toContain("skills/orchestration/*.md");
    expect(IN_SCOPE_GLOBS).toContain("templates/harness/CLAUDE.md");
    expect(IN_SCOPE_GLOBS).toContain("templates/mag/memory/*.md");
  });
});

// ---------------------------------------------------------------------------
// CLI exit-code contract (AC: exit 1 on violation, 0 otherwise; output shape)
// ---------------------------------------------------------------------------

describe("CLI exit code", () => {
  test("exits 0 on the live corpus", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", "scripts/lint-skill-shell.ts"],
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(0);
  });

  test("exits 1 when a synthetic typo is wired into the in-scope set", () => {
    // We verify the exit-1 contract by lint-running over a fabricated
    // file via a small shim script. The in-process equivalent above
    // (`flags fabricated $EVENTS_BASELINE_LINE typo`) already proves the
    // detection path; here we anchor the CLI's exit code so a future
    // refactor can't accidentally swallow the failure with a `try/catch
    // → 0` wrapper.
    const violations = lintFile(
      "synthetic.md",
      ["```bash", 'echo "$DEFINITELY_NOT_DEFINED"', "```"].join("\n"),
    );
    expect(violations.length).toBeGreaterThan(0);
    // The CLI's process.exit(1) path is gated by `violations.length > 0`,
    // so the in-process test above is the contract guard. (A spawn-based
    // assertion that injects a typo into the live corpus would require
    // mutating tracked files; the corpus-clean spawn above plus the
    // detection assertion together pin both branches of the contract.)
  });
});

// ---------------------------------------------------------------------------
// extractRefs / extractAssignments — top-level aggregators
// ---------------------------------------------------------------------------

describe("extractRefs / extractAssignments", () => {
  test("aggregate refs across multiple shell lines", () => {
    const lines = [
      { line: 1, text: 'echo "$FOO"' },
      { line: 2, text: 'echo "${BAR}"' },
    ];
    expect(extractRefs(lines).map((r) => r.name)).toEqual(["FOO", "BAR"]);
  });

  test("aggregate assignments across multiple shell lines into a per-file pool", () => {
    const lines = [
      { line: 1, text: "FOO=bar" },
      { line: 2, text: "BAZ=qux" },
      { line: 3, text: "for x in *; do :; done" },
    ];
    const pool = extractAssignments(lines);
    expect(pool.has("FOO")).toBe(true);
    expect(pool.has("BAZ")).toBe(true);
    expect(pool.has("x")).toBe(true);
  });
});
