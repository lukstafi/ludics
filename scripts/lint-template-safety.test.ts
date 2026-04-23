import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ALWAYS_POPULATED,
  findFencedShellBlocks,
  findInlineShellSpans,
  looksLikeShell,
  parseIfRanges,
  lintTemplate,
  runLint,
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
