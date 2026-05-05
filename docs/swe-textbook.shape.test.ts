// Shape test for task-c4e0e80a — pins the AC1–AC7 invariants of
// docs/swe-textbook.md and the three skill files that gain the
// `capture-textbook` disposition. Mirrors the
// docs/task-frontmatter-reference.shape.test.ts harness style.
//
// Each test below names the AC it enforces, the invariant it pins,
// and (in comments) the mutation that would falsify it.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ludicsRoot } from "./../src/config.ts";

const TEXTBOOK_PATH = "docs/swe-textbook.md";
const PROCESS_SUGGESTIONS_PATH = "skills/ludics-process-suggestions.md";
const FEEDBACK_DIGEST_PATH = "skills/ludics-feedback-digest.md";
const FEEDBACK_DIGEST_WORKER_PATH = "skills/ludics-feedback-digest-worker.md";
const WORKER_CONVENTIONS_PATH = "skills/worker-conventions.md";

const AC7_ALLOWLIST = new Set([
  "ludics-process-suggestions.md",
  "ludics-feedback-digest.md",
  "ludics-feedback-digest-worker.md",
]);

const ANCHOR = "docs/swe-textbook.md#capture-idempotency";

function read(rel: string): string {
  return readFileSync(join(ludicsRoot(), rel), "utf-8");
}

// Range-scoped slice between an opening regex and a closing regex.
// Uses awk-equivalent semantics: skip the opener line, accumulate
// until (but not including) the closer line. Avoids the
// degenerate `/start/,/end/` trap when start regex matches the close
// (per feedback_awk_range_degenerate_when_start_matches_close.md).
function slice(body: string, opener: RegExp, closer: RegExp): string {
  const lines = body.split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      if (opener.test(line)) inside = true;
      continue;
    }
    if (closer.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n");
}

// Slice from the opener line to end of file. Used when the AC's
// region runs to EOF (e.g., the seed entry that lives at the bottom
// of docs/swe-textbook.md). Avoids the previous `/^\0NEVER_MATCH/`
// hack which turned this test file into a git-binary blob.
function sliceToEnd(body: string, opener: RegExp): string {
  const lines = body.split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      if (opener.test(line)) inside = true;
      continue;
    }
    collected.push(line);
  }
  return collected.join("\n");
}

function listSkillMarkdown(): string[] {
  // Returns repo-relative paths of every .md file under skills/.
  const root = join(ludicsRoot(), "skills");
  const out: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (name.endsWith(".md")) out.push(full.slice(ludicsRoot().length + 1));
    }
  }
  walk(root);
  return out;
}

describe("docs/swe-textbook.md (AC1, AC2, AC5, AC6)", () => {
  const body = read(TEXTBOOK_PATH);

  test("AC1 — preamble carries each of the five directionality statements", () => {
    // Mutation: drop any of the five lines and the corresponding regex
    // fails. The harness is the preamble itself (lines 1..50ish).
    const preamble = slice(body, /^# SWE Textbook/, /^## Entry Shape/);
    // (1) not consulted by coder agents
    expect(preamble).toMatch(/not\b[^\n]*consulted[^\n]*coder/i);
    // (2) not consulted by reviewer agents
    expect(preamble).toMatch(/not\b[^\n]*consulted[^\n]*reviewer/i);
    // (3) only active consumers are Mag and the feedback-digest worker
    expect(preamble).toMatch(/Mag\b[\s\S]*feedback-digest[^\n]*worker/);
    // (4) write-side memory for competent-SWE filter decisions
    expect(preamble).toMatch(/competent-SWE filter/i);
    // (5) future publication seed
    expect(preamble).toMatch(/publication seed/i);
  });

  test("AC1 — preamble does NOT contain pull-side pointers", () => {
    // Falsifier: a "consult this doc" pointer back to a coder/reviewer
    // surface. Phrased as positive-presence absence.
    const preamble = slice(body, /^# SWE Textbook/, /^## Entry Shape/);
    expect(preamble).not.toMatch(/pair-coder-/);
    expect(preamble).not.toMatch(/pair-reviewer-/);
    expect(preamble).not.toMatch(/worker-conventions\.md/);
  });

  test("AC2 — entry-shape skeleton names the four required labelled fields", () => {
    const entryShape = slice(body, /^## Entry Shape/, /^## Capture Idempotency/);
    expect(entryShape).toContain("Description:");
    expect(entryShape).toContain("Precipitating retro:");
    expect(entryShape).toContain("Filter decision:");
    expect(entryShape).toContain("Second occurrence:");
  });

  test("AC5-positive — `## Capture Idempotency` cardinality is exactly 1 with the canonical snippet", () => {
    // Mutation: delete the heading or the snippet → assertion fails.
    const headings = body.match(/^## Capture Idempotency$/gm);
    expect(headings).not.toBeNull();
    expect(headings!.length).toBe(1);

    const guard = slice(
      body,
      /^## Capture Idempotency/,
      /^### "Issue is updated"/,
    );
    // The single source of truth for the guard's bash logic.
    expect(guard).toContain('grep -Fq "### ${ENTRY_HEADLINE}"');
    expect(guard).toContain('grep -Fq "${PRECIPITATING_RETRO}"');
    expect(guard).toMatch(/echo "skip-duplicate"/);
    expect(guard).toMatch(/echo "append"/);
  });

  test("AC5-positive — guard prose names headline AND precipitating-retro as duplicate keys", () => {
    const guard = slice(
      body,
      /^## Capture Idempotency/,
      /^### "Issue is updated"/,
    );
    expect(guard).toMatch(/headline OR\s+precipitating-retro/i);
    expect(guard).toContain("ENTRY_HEADLINE");
    expect(guard).toContain("PRECIPITATING_RETRO");
  });

  test("AC5-positive — input contract states ENTRY_HEADLINE excludes the leading `### ` prefix", () => {
    // Regression for codex review on PR #499: the original contract
    // said "ENTRY_HEADLINE — the proposed `### <headline>` text",
    // but the bash snippet does `grep -Fq "### ${ENTRY_HEADLINE}"` —
    // a caller following the contract literally produces `### ###
    // <headline>` and the guard never matches existing entries.
    // Fix: contract names the bare headline phrase only; the guard
    // prepends `### ` itself. Mutation: revert to "the proposed `###
    // <headline>` text" → assertion fails on the "without" literal.
    const guard = slice(
      body,
      /^## Capture Idempotency/,
      /^### "Issue is updated"/,
    );
    expect(guard).toMatch(/ENTRY_HEADLINE[\s\S]{0,200}without[\s\S]{0,40}leading[\s\S]{0,40}###/i);
    expect(guard).toMatch(/guard prepends `### `/i);
  });

  test("AC6 — at least one `### ` headline exists and the seed entry cites gh-ocannl-270", () => {
    const headlines = body.match(/^### /gm);
    expect(headlines).not.toBeNull();
    expect(headlines!.length).toBeGreaterThanOrEqual(1);
    // Seed entry slice from its `### ` headline through end-of-file.
    const seed = sliceToEnd(body, /^### "Issue is updated"/);
    expect(seed).toContain("gh-ocannl-270");
    // AC2.a–d on the seed entry: all four labelled fields present.
    expect(seed).toContain("Description:");
    expect(seed).toContain("Precipitating retro:");
    expect(seed).toContain("Filter decision:");
  });
});

describe("skills/ludics-process-suggestions.md (AC3)", () => {
  const body = read(PROCESS_SUGGESTIONS_PATH);

  test("AC3a — `<!-- section:classify -->` slice has the three-way split with capture-textbook", () => {
    const classify = slice(
      body,
      /<!-- section:classify -->/,
      /<!-- section:(?!classify)/,
    );
    expect(classify).toContain("capture-textbook");
    expect(classify).toMatch(/recurring-but-not-doctrine/i);
    expect(classify).toContain("create-task");
    expect(classify).toContain("skip-with-reason");
  });

  test("AC3b — `## Judgment Criteria` slice has a third bucket keyed to recurring-but-not-doctrine", () => {
    const criteria = slice(body, /^## Judgment Criteria/, /^## Error Handling/);
    expect(criteria).toMatch(/Recurring-but-not-doctrine \(capture in textbook\)/);
    expect(criteria).toContain("competent-SWE filter");
  });

  test("AC3c — `<!-- section:write-result -->` example carries textbookCaptures with required keys", () => {
    const result = slice(
      body,
      /<!-- section:write-result -->/,
      /<!-- section:(?!write-result)/,
    );
    expect(result).toContain("textbookCaptures");
    expect(result).toContain("entryHeadline");
    expect(result).toContain("precipitatingRetro");
  });

  test("AC5 cross-reference — body cites the canonical idempotency anchor", () => {
    expect(body).toContain(ANCHOR);
  });

  test("AC5-negative — process-suggestions body does NOT duplicate the canonical guard's implementation literals", () => {
    // Falsifier: copy the bash snippet from docs/swe-textbook.md back
    // into this skill body → assertion fails. The implementation
    // literals are the bash command form and the echo strings the
    // canonical guard uses.
    expect(body).not.toContain('grep -Fq "### ${ENTRY_HEADLINE}"');
    expect(body).not.toContain('grep -Fq "${PRECIPITATING_RETRO}"');
    expect(body).not.toContain('echo "skip-duplicate"');
    expect(body).not.toContain('echo "append"');
  });
});

describe("skills/ludics-feedback-digest-worker.md (AC4 worker side)", () => {
  const body = read(FEEDBACK_DIGEST_WORKER_PATH);

  test("AC4a — `### 3a.` step contains capture-textbook classification", () => {
    const stepThreeA = slice(body, /^### 3a\./, /^### 4\./);
    expect(stepThreeA).toContain("capture-textbook");
    expect(stepThreeA).toContain("file-issue");
    expect(stepThreeA).toContain(ANCHOR);
  });

  test("AC4b — `### Response Contract` carries textbookCaptures with required keys", () => {
    const contract = slice(body, /^### Response Contract/, /^## Error Handling/);
    expect(contract).toContain("textbookCaptures");
    expect(contract).toContain("feedbackItem");
    expect(contract).toContain("entryHeadline");
    expect(contract).toContain("precipitatingRetro");
  });

  test("AC4b — example JSON in Response Contract includes textbookCaptures", () => {
    const contract = slice(body, /^### Response Contract/, /^## Error Handling/);
    // Example block lives within the contract slice; assert literal presence.
    expect(contract).toMatch(/"textbookCaptures":\s*\[\]/);
  });

  test("AC5-negative — worker body does NOT duplicate the canonical guard's implementation literals", () => {
    expect(body).not.toContain('grep -Fq "### ${ENTRY_HEADLINE}"');
    expect(body).not.toContain('grep -Fq "${PRECIPITATING_RETRO}"');
    expect(body).not.toContain('echo "skip-duplicate"');
    expect(body).not.toContain('echo "append"');
  });
});

describe("skills/ludics-feedback-digest.md (AC4 orchestrator side)", () => {
  const body = read(FEEDBACK_DIGEST_PATH);

  test("AC4c — `## Status routing` table has a textbookCaptures row with `[]` fallback", () => {
    const routing = slice(body, /^## Status routing/, /^## Result fields/);
    expect(routing).toContain("textbookCaptures");
    expect(routing).toMatch(/\| `textbookCaptures` \|[^|]*\| `\[\]` \|/);
  });

  test("AC4c — `## Result fields` JSON schema includes textbookCaptures", () => {
    const result = slice(body, /^## Result fields/, /^## Delegation strategy/);
    expect(result).toMatch(/"textbookCaptures":\s*\[\]/);
  });

  test("AC4c — orchestrator output template mentions captured-to-textbook count", () => {
    const result = slice(body, /^## Result fields/, /^## Delegation strategy/);
    expect(result).toContain("captured N to textbook");
  });

  test("AC5-negative — orchestrator body does NOT duplicate the canonical guard's implementation literals", () => {
    expect(body).not.toContain('grep -Fq "### ${ENTRY_HEADLINE}"');
    expect(body).not.toContain('grep -Fq "${PRECIPITATING_RETRO}"');
    expect(body).not.toContain('echo "skip-duplicate"');
    expect(body).not.toContain('echo "append"');
  });
});

describe("skills/worker-conventions.md (AC4d field-contract reference)", () => {
  const body = read(WORKER_CONVENTIONS_PATH);

  test("AC4d — `## Field Contract Reference` has a feedback-digest | textbookCaptures row", () => {
    const refSlice = slice(body, /^## Field Contract Reference/, /^## Error Handling/);
    // Mutation: drop the row and the assertion fails on the literal pair.
    expect(refSlice).toMatch(
      /\| feedback-digest \| `textbookCaptures` \| object\[\] \| optional \|/,
    );
  });

  test("AC4d — the new row contains no `swe-textbook` substring (AC7 cross-check)", () => {
    const refSlice = slice(body, /^## Field Contract Reference/, /^## Error Handling/);
    const rowMatch = refSlice
      .split("\n")
      .find((line) => line.includes("textbookCaptures"));
    expect(rowMatch).toBeDefined();
    expect(rowMatch!).not.toContain("swe-textbook");
  });
});

describe("AC7 — negative control on agent-loaded prompts", () => {
  test("no `skills/**.md` outside the AC7 allowlist mentions `swe-textbook`", () => {
    // Harness: walk every .md file under skills/ and check the
    // forbidden substring. Allowlist contains exactly the three
    // skills the proposal authorises (worker-conventions.md is NOT
    // in the allowlist; the new field-contract row uses
    // `textbookCaptures` only and is asserted clean above).
    const files = listSkillMarkdown();
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const path of files) {
      const basename = path.split("/").pop()!;
      if (AC7_ALLOWLIST.has(basename)) continue;
      const body = readFileSync(join(ludicsRoot(), path), "utf-8");
      if (body.includes("swe-textbook")) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
