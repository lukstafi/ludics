import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ALWAYS_POPULATED,
  ENV_ASSIGNMENT_PREFIX,
  SHELL_COMMANDS,
  SHELL_KEYWORDS,
  classifyLines,
  findFencedLines,
  findFencedShellBlocks,
  findInlineShellSpans,
  listTemplates,
  looksLikeShell,
  parseIfRanges,
  lintTemplate,
  runLint,
  stripLeadingEnvAssignments,
} from "./lint-template-safety.ts";

describe("findFencedShellBlocks", () => {
  test("recognizes ```sh fences", () => {
    const lines = ["# T", "", "```sh", "echo hi", "```", "after"];
    const spans = findFencedShellBlocks(lines);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startLine).toBe(3);
    expect(spans[0]!.endLine).toBe(3);
  });

  test("recognizes ```bash fences", () => {
    const lines = ["```bash", "echo hi", "```"];
    const spans = findFencedShellBlocks(lines);
    expect(spans).toHaveLength(1);
  });

  test("recognizes indented shell fences", () => {
    const lines = ["1. Do:", "   ```sh", "   echo hi", "   ```", "done"];
    const spans = findFencedShellBlocks(lines);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startLine).toBe(2);
  });

  test("ignores non-shell fences", () => {
    const lines = ["```ts", "const x = 1;", "```"];
    const spans = findFencedShellBlocks(lines);
    expect(spans).toHaveLength(0);
  });
});

describe("findFencedLines", () => {
  test("marks shell fence body and marker lines", () => {
    const lines = ["prose", "```sh", "echo hi", "```", "after"];
    const fenced = findFencedLines(lines);
    expect(fenced.has(1)).toBe(true);
    expect(fenced.has(2)).toBe(true);
    expect(fenced.has(3)).toBe(true);
    expect(fenced.has(0)).toBe(false);
    expect(fenced.has(4)).toBe(false);
  });

  test("marks non-shell fence body and marker lines", () => {
    const lines = ["prose", "```ts", "const x = 1;", "```", "after"];
    const fenced = findFencedLines(lines);
    expect(fenced.has(1)).toBe(true);
    expect(fenced.has(2)).toBe(true);
    expect(fenced.has(3)).toBe(true);
    expect(fenced.has(0)).toBe(false);
    expect(fenced.has(4)).toBe(false);
  });

  test("marks indented fenced blocks", () => {
    const lines = ["1. do:", "   ```sh", "   git x", "   ```", "done"];
    const fenced = findFencedLines(lines);
    expect(fenced.has(1)).toBe(true);
    expect(fenced.has(2)).toBe(true);
    expect(fenced.has(3)).toBe(true);
  });
});

describe("findInlineShellSpans", () => {
  test("recognizes inline gh command", () => {
    const lines = ['Run `gh pr view --json x` now.'];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.kind).toBe("inline");
  });

  test("ignores prose-like backticks (file paths, values)", () => {
    const lines = ["Write to `{{STATUS_FILE}}`.", "Value is `foo/bar`."];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(0);
  });

  test("skips backticks on fence lines", () => {
    const lines = ["```sh"];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(0);
  });

  test("recognizes subshell-style inline", () => {
    const lines = ["Inspect `$(date +%s)` output."];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(1);
  });

  test("recognizes shell-keyword prefixed commands (`if`, `for`, etc.)", () => {
    const lines = [
      'Run `if gh pr view --repo "{{PROJECT_REPO}}"; then :; fi` now.',
    ];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(1);
  });

  test("recognizes env-var-assignment-prefixed commands", () => {
    const lines = ['Run `PROJECT_REPO=foo gh pr view --repo "{{PROJECT_REPO}}"` now.'];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(1);
  });

  test("recognizes pipe-chained commands inside backticks", () => {
    const lines = ['Inspect `gh pr view --json x | jq ".title"` output.'];
    const spans = findInlineShellSpans(lines);
    expect(spans).toHaveLength(1);
  });
});

describe("classifyLines — disjointness", () => {
  // Hand-crafted mixed corpus: prose, ```sh, ```ts, indented ```bash inside a
  // numbered list, and a few prose lines between blocks.
  const corpus = [
    "# Heading",
    "",
    "Some prose with a `gh pr view 1` backtick.",
    "",
    "```sh",
    'echo "{{STATUS_FILE}}"',
    "```",
    "",
    "Now a typescript block:",
    "",
    "```ts",
    "// `gh pr view 2` is illustrative only",
    "const x = 1;",
    "```",
    "",
    "1. Indented bash example:",
    "",
    "   ```bash",
    "   git status",
    "   git log",
    "   ```",
    "",
    "Trailing prose.",
  ];

  test("returns one classification per input line (length invariant)", () => {
    const classes = classifyLines(corpus);
    expect(classes).toHaveLength(corpus.length);
  });

  test("each element is well-formed (one of three kinds with expected fields)", () => {
    for (const c of classifyLines(corpus)) {
      if (c.kind === "prose") {
        // No additional fields.
      } else if (c.kind === "fence-marker") {
        expect(c.blockKind === "shell" || c.blockKind === "other").toBe(true);
      } else if (c.kind === "fence-body") {
        expect(c.blockKind === "shell" || c.blockKind === "other").toBe(true);
        expect(typeof c.indent).toBe("string");
      } else {
        // exhaustiveness — should be unreachable
        throw new Error(`unexpected kind: ${JSON.stringify(c)}`);
      }
    }
  });

  test("disjointness: prose / fence-marker / fence-body never overlap on the same row", () => {
    const classes = classifyLines(corpus);
    let proseCount = 0;
    let markerCount = 0;
    let bodyCount = 0;
    for (const c of classes) {
      if (c.kind === "prose") proseCount++;
      else if (c.kind === "fence-marker") markerCount++;
      else if (c.kind === "fence-body") bodyCount++;
    }
    expect(proseCount + markerCount + bodyCount).toBe(corpus.length);
  });

  test("classifies ```sh body rows as fence-body shell", () => {
    const classes = classifyLines(corpus);
    // Line 5 is the body of the ```sh block (corpus[4] is the marker).
    expect(classes[5]).toEqual({ kind: "fence-body", blockKind: "shell", indent: "" });
  });

  test("classifies ```ts body rows as fence-body other", () => {
    const classes = classifyLines(corpus);
    // Lines 11 and 12 are inside the ```ts block.
    expect(classes[11]).toEqual({ kind: "fence-body", blockKind: "other", indent: "" });
    expect(classes[12]).toEqual({ kind: "fence-body", blockKind: "other", indent: "" });
  });

  test("classifies indented ```bash body rows with the opening indent", () => {
    const classes = classifyLines(corpus);
    // corpus[17] is `   ```bash` (marker), bodies are 18 and 19.
    expect(classes[18]).toEqual({ kind: "fence-body", blockKind: "shell", indent: "   " });
    expect(classes[19]).toEqual({ kind: "fence-body", blockKind: "shell", indent: "   " });
  });

  test("disjointness invariant holds against a real orchestration template", () => {
    // Pick a representative template; any one suffices since the invariant is
    // structural. pair-coder-pr-create.md exists in skills/orchestration/.
    const path = join(import.meta.dir, "..", "skills", "orchestration", "pair-coder-pr-create.md");
    const text = readFileSync(path, "utf-8");
    const lines = text.split(/\r?\n/);
    const classes = classifyLines(lines);
    expect(classes).toHaveLength(lines.length);
    for (const c of classes) {
      const ok =
        c.kind === "prose" ||
        c.kind === "fence-marker" ||
        c.kind === "fence-body";
      expect(ok).toBe(true);
    }
  });

  test("ts-fence regression: inline-shell-shaped backtick inside ```ts is fence-body, not inline shell", () => {
    // The round-2 Codex catch: a ```ts (non-shell) fence whose body contains a
    // backtick span shaped like an inline shell command must classify as
    // fence-body of blockKind: "other", and findInlineShellSpans must not
    // emit a span pointing into that body.
    const lines = [
      "Example code:",
      "",
      "```ts",
      '// `gh pr view 123` — illustrative only',
      "const x: string = `hello`;",
      "```",
      "After the block.",
    ];
    const classes = classifyLines(lines);
    // Body lines are 3 and 4.
    expect(classes[3]).toEqual({ kind: "fence-body", blockKind: "other", indent: "" });
    expect(classes[4]).toEqual({ kind: "fence-body", blockKind: "other", indent: "" });
    // findInlineShellSpans must NOT emit a span pointing into the ```ts body.
    const spans = findInlineShellSpans(lines);
    for (const span of spans) {
      expect(span.startLine === 3 || span.startLine === 4).toBe(false);
    }
  });
});

describe("looksLikeShell", () => {
  test("accepts direct command prefix", () => {
    expect(looksLikeShell("gh pr view --repo foo")).toBe(true);
  });

  test("accepts shell-keyword prefixes", () => {
    expect(looksLikeShell("if gh pr view; then :; fi")).toBe(true);
    expect(looksLikeShell("for f in *.md; do echo $f; done")).toBe(true);
    expect(looksLikeShell("while read line; do :; done")).toBe(true);
    expect(looksLikeShell("case $x in a) :;; esac")).toBe(true);
  });

  test("accepts single-assignment prefix before a command", () => {
    expect(looksLikeShell("FOO=bar gh pr view --repo x")).toBe(true);
  });

  test("accepts multiple-assignment prefix before a command", () => {
    expect(looksLikeShell('FOO=bar BAZ="qux" gh pr view')).toBe(true);
  });

  test("accepts subshell / parameter expansion anywhere", () => {
    expect(looksLikeShell("echo $(date +%s)")).toBe(true);
    expect(looksLikeShell("prefix ${HOME}/bin")).toBe(true);
  });

  test("accepts pipe / chain into recognized command", () => {
    expect(looksLikeShell("some-tool | jq .x")).toBe(true);
    expect(looksLikeShell("cmd && git status")).toBe(true);
  });

  test("rejects prose-style backtick contents", () => {
    expect(looksLikeShell("src/foo.ts")).toBe(false);
    expect(looksLikeShell("{{STATUS_FILE}}")).toBe(false);
    expect(looksLikeShell("APPROVE")).toBe(false);
    expect(looksLikeShell("handleFoo()")).toBe(false);
  });

  test("rejects assignment-without-command", () => {
    expect(looksLikeShell("FOO=bar")).toBe(false);
  });

  // Gap-closure: previously the brittle ENV_ASSIGNMENT_PREFIX regex's `\S*`
  // alternative halted mid-`$(...)`, leaving residual `$(` characters that the
  // independent `/\$\(|\$\{/` recognizer would then false-positive on. With
  // stripLeadingEnvAssignments, pure-assignment lines whose RHS is `$(...)` are
  // correctly classified as not-a-shell-command.
  test("rejects pure-assignment lines whose RHS contains $(...) with whitespace", () => {
    expect(looksLikeShell(`PR_URL=$(cat "x" 2>/dev/null)`)).toBe(false);
    expect(looksLikeShell(`FOO=$(date +%s)`)).toBe(false);
  });

  test("accepts $(...)-valued assignment followed by a real command", () => {
    // The post-strip remainder is `gh pr view`, matching SHELL_COMMAND_PREFIX.
    // Verifies the helper consumed the full `$(...)` body (whitespace and
    // nested redirection included) rather than halting mid-value.
    expect(
      looksLikeShell(`PR_URL=$(cat "x" 2>/dev/null) gh pr view`),
    ).toBe(true);
  });
});

describe("stripLeadingEnvAssignments", () => {
  test("returns null for pure assignment with no command", () => {
    expect(stripLeadingEnvAssignments("FOO=bar")).toBeNull();
    expect(stripLeadingEnvAssignments(`FOO="bar baz"`)).toBeNull();
    expect(stripLeadingEnvAssignments(`FOO='bar baz'`)).toBeNull();
    expect(stripLeadingEnvAssignments(`FOO=$(date)`)).toBeNull();
    expect(stripLeadingEnvAssignments(`PR_URL=$(cat "x" 2>/dev/null)`)).toBeNull();
  });

  test("returns null for multiple chained pure assignments", () => {
    expect(stripLeadingEnvAssignments(`FOO=bar BAZ="qux"`)).toBeNull();
    expect(stripLeadingEnvAssignments(`A=1 B=$(date) C="d e f"`)).toBeNull();
  });

  test("returns the command remainder when a command follows", () => {
    expect(stripLeadingEnvAssignments("FOO=bar gh pr view")).toBe("gh pr view");
    expect(stripLeadingEnvAssignments(`FOO="bar baz" gh pr view`)).toBe(
      "gh pr view",
    );
    expect(
      stripLeadingEnvAssignments(`PR_URL=$(cat "x" 2>/dev/null) gh pr view`),
    ).toBe("gh pr view");
  });

  test("returns the input verbatim when no leading assignment is present", () => {
    // Used by looksLikeShell to feed the SHELL_COMMAND_PREFIX recognizer.
    expect(stripLeadingEnvAssignments("gh pr view")).toBe("gh pr view");
    expect(stripLeadingEnvAssignments("APPROVE")).toBe("APPROVE");
    expect(stripLeadingEnvAssignments("{{STATUS_FILE}}")).toBe(
      "{{STATUS_FILE}}",
    );
  });

  test("handles single-quoted values with embedded escapes and whitespace", () => {
    expect(stripLeadingEnvAssignments(`FOO='it\\'s fine' gh pr view`)).toBe(
      "gh pr view",
    );
  });

  // Regression: the depth counter inside the `$(...)` walker incremented on
  // every `(` / `)` regardless of quoting, so a quoted `(` inside the
  // substitution body left depth unbalanced and the walker consumed past the
  // real closing `)` into the trailing command — producing `null` (Codex
  // review on PR #455). The walker now tracks quoted regions explicitly.
  test("handles quoted parentheses inside $(...) without skewing depth", () => {
    expect(
      stripLeadingEnvAssignments(`FOO=$(printf '(') gh pr view`),
    ).toBe("gh pr view");
    expect(
      stripLeadingEnvAssignments(`FOO=$(printf ')') gh pr view`),
    ).toBe("gh pr view");
    expect(
      stripLeadingEnvAssignments(`FOO=$(printf "(") gh pr view`),
    ).toBe("gh pr view");
    expect(stripLeadingEnvAssignments(`FOO=$(printf '(')`)).toBeNull();
    // looksLikeShell consumer must agree.
    expect(looksLikeShell(`FOO=$(printf '(') gh pr view`)).toBe(true);
  });
});

describe("parseIfRanges", () => {
  test("single IF block yields one range", () => {
    const text = "before {{#IF FOO}}body{{/IF}} after";
    const ranges = parseIfRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.variable).toBe("FOO");
  });

  test("nested IF blocks are tracked via stack", () => {
    const text = "{{#IF A}}outer {{#IF B}}inner{{/IF}} tail{{/IF}}";
    const ranges = parseIfRanges(text);
    expect(ranges).toHaveLength(2);
    const vars = ranges.map((r) => r.variable).sort();
    expect(vars).toEqual(["A", "B"]);
  });
});

describe("lintTemplate — safe forms", () => {
  test("always-populated variable in fenced block is safe", () => {
    const md = ['```sh', 'printf "%s" "{{STATUS_FILE}}"', '```'].join("\n");
    expect(lintTemplate("t.md", md, undefined)).toEqual([]);
  });

  test("potentially-empty variable in prose is safe", () => {
    const md = "Re-read `{{PROPOSAL_PATH}}` for the criteria.";
    expect(lintTemplate("t.md", md, undefined)).toEqual([]);
  });

  test("IF-guarded variable in fenced block is safe", () => {
    const md = [
      "```sh",
      'gh pr create {{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}--title X',
      "```",
    ].join("\n");
    expect(lintTemplate("t.md", md, undefined)).toEqual([]);
  });

  test("per-file allowlist suppresses a flagged variable", () => {
    const md = [
      "```sh",
      'gh pr view --repo "{{PROJECT_REPO}}"',
      "```",
    ].join("\n");
    const allow = new Set(["PROJECT_REPO"]);
    expect(lintTemplate("forward-pr.md", md, allow)).toEqual([]);
  });
});

describe("lintTemplate — violations", () => {
  test("unguarded PROJECT_REPO in fenced shell block is flagged", () => {
    const md = [
      "```sh",
      'gh pr create --repo "{{PROJECT_REPO}}"',
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("PROJECT_REPO");
    expect(vs[0]!.context).toBe("fenced");
    expect(vs[0]!.line).toBe(2);
  });

  test("unguarded UPSTREAM_REPO in bash block is flagged", () => {
    const md = [
      "```bash",
      'git clone "https://github.com/{{UPSTREAM_REPO}}.git"',
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("UPSTREAM_REPO");
  });

  test("unguarded variable in inline shell command is flagged", () => {
    const md = 'Run `gh pr view --repo "{{PROJECT_REPO}}" --json x` now.';
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.context).toBe("inline");
  });

  test("unguarded variable in indented shell block is flagged", () => {
    const md = [
      "1. Do this:",
      "   ```sh",
      '   gh pr list --repo "{{PROJECT_REPO}}"',
      "   ```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("PROJECT_REPO");
    expect(vs[0]!.line).toBe(3);
  });

  test("variable used outside its IF guard body is flagged", () => {
    const md = [
      "{{#IF PROJECT_REPO}}guard body{{/IF}}",
      "```sh",
      'gh pr view --repo "{{PROJECT_REPO}}"',
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
  });

  test("IF-guard for a different variable does not cover the target", () => {
    const md = [
      "```sh",
      '{{#IF OTHER}}gh pr view --repo "{{PROJECT_REPO}}"{{/IF}}',
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("PROJECT_REPO");
  });

  test("inline `if gh ...; then :; fi` is flagged (reviewer regression)", () => {
    const md = 'Run `if gh pr view --repo "{{PROJECT_REPO}}"; then :; fi` now.';
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("PROJECT_REPO");
    expect(vs[0]!.context).toBe("inline");
  });

  test("inline env-var-prefixed command is flagged (reviewer regression)", () => {
    const md = 'Run `PROJECT_REPO=foo gh pr view --repo "{{PROJECT_REPO}}"` now.';
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("PROJECT_REPO");
    expect(vs[0]!.context).toBe("inline");
  });

  test("inline for-loop with unsafe variable is flagged", () => {
    const md = 'Iterate `for x in "{{UPSTREAM_REPO}}"; do git clone "$x"; done` now.';
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.variable).toBe("UPSTREAM_REPO");
  });

  // Regression: reviewer flagged two cases where `findInlineShellSpans` ignored
  // fenced-block state. Inside a non-shell fence (e.g., ```ts) inline backticks
  // must NOT be treated as inline shell; and inside a shell fence the same
  // variable must not be reported twice (once fenced + once inline).
  test("inline backtick inside a non-shell fence (```ts) is not flagged", () => {
    const md = [
      "Example code:",
      "```ts",
      '// `gh pr view --repo "{{PROJECT_REPO}}"` — just illustrative',
      "const x = 1;",
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toEqual([]);
  });

  test("variable in a shell fence that also looks inline is reported once", () => {
    const md = [
      "```sh",
      'gh pr view --repo "{{PROJECT_REPO}}"',
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.context).toBe("fenced");
  });

  test("variable inside ```yaml is not flagged by the inline scan", () => {
    const md = [
      "```yaml",
      '# `gh pr view --repo "{{UPSTREAM_REPO}}"` — example command',
      "key: value",
      "```",
    ].join("\n");
    const vs = lintTemplate("t.md", md, undefined);
    expect(vs).toEqual([]);
  });
});

describe("ALWAYS_POPULATED set", () => {
  test("includes core identity variables", () => {
    for (const v of ["TASK_ID", "PHASE", "ROUND", "AGENT_NAME", "WORKTREE_PATH"]) {
      expect(ALWAYS_POPULATED.has(v)).toBe(true);
    }
  });

  test("excludes known potentially-empty variables", () => {
    for (const v of [
      "PROJECT_REPO",
      "UPSTREAM_REPO",
      "PROPOSAL_PATH",
      "PROPOSAL_INSTRUCTION",
      "VERIFICATION_CONTEXT",
      "TASK_AC",
    ]) {
      expect(ALWAYS_POPULATED.has(v)).toBe(false);
    }
  });
});

describe("ALWAYS_POPULATED_KEYS drift", () => {
  // Bidirectional invariant against `buildSkillContext`'s `result` object literal
  // in src/orchestration/skills.ts. Catches the classic drift case where someone
  // adds a literally-non-empty assignment but forgets to register the key as
  // always-populated, or removes a key from one side without the other.

  /** Extract the `result: Record<string, string> = { ... };` block from skills.ts
   *  by locating the opening `= {` and matching closing `};` via brace depth. */
  function extractResultBlock(text: string): { keys: { name: string; rhs: string }[] } {
    const startMarker = "const result: Record<string, string> = {";
    const startIdx = text.indexOf(startMarker);
    if (startIdx < 0) throw new Error("could not locate result literal in skills.ts");
    const bodyStart = startIdx + startMarker.length;
    let depth = 1;
    let i = bodyStart;
    while (i < text.length && depth > 0) {
      const ch = text[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) throw new Error("unbalanced braces in result literal");
    const body = text.slice(bodyStart, i);
    // Walk top-level entries (depth 0 within `body`) and collect "KEY: rhs,"
    // pairs. We need to track nested braces/brackets/parens so that ternaries
    // or template literals containing `,` don't fragment a single entry.
    const keys: { name: string; rhs: string }[] = [];
    let bd = 0; // brace depth
    let pd = 0; // paren depth
    let sd = 0; // square-bracket depth
    let entryStart = 0;
    let inString: '"' | "'" | "`" | null = null;
    let escape = false;
    const flush = (end: number) => {
      const entry = body.slice(entryStart, end).trim();
      entryStart = end + 1;
      if (!entry) return;
      const m = entry.match(/^([A-Z][A-Z0-9_]*)\s*:\s*([\s\S]*)$/);
      if (!m) return; // skip comments / non-identifier lines
      keys.push({ name: m[1]!, rhs: m[2]!.trim() });
    };
    for (let j = 0; j < body.length; j++) {
      const ch = body[j]!;
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
      if (ch === "{") bd++;
      else if (ch === "}") bd--;
      else if (ch === "(") pd++;
      else if (ch === ")") pd--;
      else if (ch === "[") sd++;
      else if (ch === "]") sd--;
      else if (ch === "," && bd === 0 && pd === 0 && sd === 0) {
        flush(j);
      }
    }
    flush(body.length);
    return { keys };
  }

  /** A right-hand-side expression has an empty-default marker if it contains
   *  one of the canonical idioms `?? ""`, `: ""`, or `|| ""` (single-quoted
   *  variants accepted too) at any position outside string literals. */
  function hasEmptyDefault(rhs: string): boolean {
    return /(?:\?\?|:|\|\|)\s*""(?!")|(?:\?\?|:|\|\|)\s*''(?!')/.test(rhs);
  }

  const skillsPath = join(import.meta.dir, "..", "src", "orchestration", "skills.ts");
  const skillsText = readFileSync(skillsPath, "utf-8");
  const { keys } = extractResultBlock(skillsText);

  test("every literally-non-empty assignment is in ALWAYS_POPULATED_KEYS", () => {
    const missing: string[] = [];
    for (const { name, rhs } of keys) {
      if (hasEmptyDefault(rhs)) continue;
      if (!ALWAYS_POPULATED.has(name)) {
        missing.push(`${name}  (rhs: ${rhs.slice(0, 60)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every key in ALWAYS_POPULATED_KEYS appears as a non-empty-default assignment", () => {
    const byName = new Map(keys.map((k) => [k.name, k.rhs]));
    const missing: string[] = [];
    for (const key of ALWAYS_POPULATED) {
      const rhs = byName.get(key);
      if (rhs == null) {
        missing.push(`${key} (no assignment found in result literal)`);
        continue;
      }
      if (hasEmptyDefault(rhs)) {
        missing.push(`${key} (rhs has empty-default marker: ${rhs.slice(0, 60)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the set has the expected size for the current result literal", () => {
    // Sanity check: 33 keys today. Update when buildSkillContext gains/loses an
    // always-populated key — failure here is a prompt to also update the tests
    // above with an explanatory comment in the same change.
    const nonEmpty = keys.filter((k) => !hasEmptyDefault(k.rhs)).map((k) => k.name);
    expect(new Set(nonEmpty)).toEqual(new Set(ALWAYS_POPULATED));
  });
});

describe("runLint — directory sweep", () => {
  test("returns empty for a directory with clean templates", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-templates-clean-"));
    try {
      writeFileSync(
        join(dir, "a.md"),
        ['```sh', 'printf "%s" "{{STATUS_FILE}}"', '```'].join("\n"),
      );
      writeFileSync(
        join(dir, "b.md"),
        "Prose referencing `{{PROPOSAL_PATH}}` is fine.",
      );
      expect(runLint(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aggregates violations across multiple files", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-templates-dirty-"));
    try {
      writeFileSync(
        join(dir, "a.md"),
        ["```sh", 'gh pr view --repo "{{PROJECT_REPO}}"', "```"].join("\n"),
      );
      writeFileSync(
        join(dir, "b.md"),
        ["```bash", 'git clone "{{UPSTREAM_REPO}}"', "```"].join("\n"),
      );
      const vs = runLint(dir);
      expect(vs).toHaveLength(2);
      const files = vs.map((v) => v.file).sort();
      expect(files).toEqual(["a.md", "b.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runLint — CLI integration", () => {
  test("exits 0 against the live orchestration template set", async () => {
    const proc = Bun.spawnSync([
      "bun",
      "run",
      join(import.meta.dir, "lint-template-safety.ts"),
    ]);
    expect(proc.exitCode).toBe(0);
  });

  test("exits 0 via CLI against a crafted clean directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-templates-cli-ok-"));
    try {
      writeFileSync(
        join(dir, "a.md"),
        ["```sh", 'printf "%s" "{{STATUS_FILE}}"', "```"].join("\n"),
      );
      const proc = Bun.spawnSync(
        ["bun", "run", join(import.meta.dir, "lint-template-safety.ts"), dir],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 1 via CLI against a crafted failing directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-templates-cli-fail-"));
    try {
      writeFileSync(
        join(dir, "bad.md"),
        ["```sh", 'gh pr view --repo "{{PROJECT_REPO}}"', "```"].join("\n"),
      );
      const proc = Bun.spawnSync(
        ["bun", "run", join(import.meta.dir, "lint-template-safety.ts"), dir],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(1);
      const stderr = new TextDecoder().decode(proc.stderr);
      expect(stderr).toContain("PROJECT_REPO");
      expect(stderr).toContain("bad.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SHELL_COMMANDS drift", () => {
  // Meta-test (NOT a runtime lint rule templates must pass): walks every
  // fenced shell block in skills/orchestration/*.md, tokenizes the first
  // command of each chain segment, and asserts the token is a known dispatch
  // form, a {{VAR}}-as-command, or a member of SHELL_COMMANDS ∪ SHELL_KEYWORDS.
  // An unknown token means a template has started using a new tool — bump the
  // static lists deliberately rather than weaken this test.

  /** Quote-aware shell-chain split: respects single-quoted, double-quoted, and
   *  backtick strings so `printf '%s|%s' "$a" "$b"` stays one segment. */
  function splitOnShellChain(line: string): string[] {
    const parts: string[] = [];
    let buf = "";
    let i = 0;
    let quote: '"' | "'" | "`" | null = null;
    while (i < line.length) {
      const ch = line[i]!;
      if (quote) {
        if (ch === "\\" && i + 1 < line.length) {
          buf += ch + line[i + 1]!;
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        buf += ch;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < line.length) {
        buf += ch + line[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        buf += ch;
        i++;
        continue;
      }
      if (ch === ";") {
        parts.push(buf);
        buf = "";
        i++;
        continue;
      }
      if (ch === "|") {
        // `||` and `|` both terminate a segment.
        parts.push(buf);
        buf = "";
        i += line[i + 1] === "|" ? 2 : 1;
        continue;
      }
      if (ch === "&" && line[i + 1] === "&") {
        parts.push(buf);
        buf = "";
        i += 2;
        continue;
      }
      buf += ch;
      i++;
    }
    parts.push(buf);
    return parts;
  }

  /** Strip leading `{{#IF VAR}}` / `{{/IF}}` template tags (one or more,
   *  separated by whitespace). A line like
   *  `{{#IF FOO}}{{#IF BAR}}command ...` becomes `command ...`. */
  function stripLeadingTemplateTags(line: string): string {
    return line.replace(/^(?:\{\{#IF\s+[A-Z0-9_]+\}\}\s*|\{\{\/IF\}\}\s*)+/, "");
  }

  function isKnownDispatchForm(token: string): boolean {
    return /^\$\(/.test(token) || /^\[/.test(token) || /^\{/.test(token) || /^\(/.test(token);
  }

  function isVariableAsCommand(token: string): boolean {
    return /^\{\{[A-Z0-9_]+\}\}/.test(token);
  }

  const known: ReadonlySet<string> = new Set([...SHELL_COMMANDS, ...SHELL_KEYWORDS]);

  function collectFailures(dir: string): string[] {
    const failures: string[] = [];
    for (const name of listTemplates(dir)) {
      const text = readFileSync(join(dir, name), "utf-8");
      const lines = text.split(/\r?\n/);
      const spans = findFencedShellBlocks(lines);
      for (const span of spans) {
        for (let i = span.startLine; i <= span.endLine; i++) {
          const raw = lines[i]!;
          let line = raw.replace(/^\s+/, "");
          line = stripLeadingTemplateTags(line);
          if (!line) continue;
          if (line.startsWith("#")) continue; // shell comment
          if (/^\\\s*$/.test(line)) continue; // line continuation only
          // First, try the smart env-var stripper (handles `$(...)` values).
          const stripped = stripLeadingEnvAssignments(line);
          if (stripped === null) continue; // pure assignment line, no command
          const segments = splitOnShellChain(stripped);
          for (const seg of segments) {
            const trimmed = seg.replace(/^\s+/, "");
            if (!trimmed) continue;
            // Each subsequent segment may also start with env-var prefixes
            // (rare, but possible); apply the runtime regex to be safe.
            const segBody = trimmed.replace(ENV_ASSIGNMENT_PREFIX, "");
            const token = segBody.split(/\s+/)[0] ?? "";
            if (!token) continue;
            if (isKnownDispatchForm(token)) continue;
            if (isVariableAsCommand(token)) continue;
            if (known.has(token)) continue;
            failures.push(
              `${name}:${i + 1}: unknown shell first-token \`${token}\`; add to SHELL_COMMANDS or document exemption`,
            );
          }
        }
      }
    }
    return failures;
  }

  test("every fenced shell block in skills/orchestration/* uses a known first-token", () => {
    const dir = join(import.meta.dir, "..", "skills", "orchestration");
    const failures = collectFailures(dir);
    expect(failures).toEqual([]);
  });

  test("the meta-test catches a synthetic unknown token", () => {
    // Sanity: the test isn't trivially passing because the directory walks
    // are short-circuiting somewhere. Build a tiny temp dir with a template
    // that uses `helmfoo` (definitely not in SHELL_COMMANDS) and assert the
    // failure surfaces.
    const dir = mkdtempSync(join(tmpdir(), "lint-shell-drift-synthetic-"));
    try {
      writeFileSync(
        join(dir, "x.md"),
        ["```sh", "helmfoo deploy --release {{TASK_ID}}", "```"].join("\n"),
      );
      const failures = collectFailures(dir);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0]).toContain("helmfoo");
      expect(failures[0]).toContain("x.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
