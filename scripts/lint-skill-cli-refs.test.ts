import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  IN_SCOPE_GLOBS,
  buildSubCommandIndex,
  buildTopLevelIndex,
  collectInScopeFiles,
  extractCliRefs,
  extractCodeSpans,
  lintSkillCliRefs,
  resolveCliRefs,
} from "./lint-skill-cli-refs.ts";
import { extractUsageBlock } from "./lint-cli-readme.ts";

// ---------------------------------------------------------------------------
// extractCodeSpans — code-context extractor (AC #3, AC #10)
// ---------------------------------------------------------------------------

describe("extractCodeSpans", () => {
  test("captures inline backtick spans", () => {
    const md = "Run `ludics mag start` to begin.\n";
    const spans = extractCodeSpans("a.md", md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("ludics mag start");
    expect(spans[0]!.line).toBe(1);
  });

  test("captures fenced code-block content", () => {
    const md = ["before", "```bash", "ludics tasks list", "```", "after"].join(
      "\n",
    );
    const spans = extractCodeSpans("a.md", md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("ludics tasks list");
  });

  test("ignores prose mentions outside backticks/fences", () => {
    // AC #10 — prose-mention rejection. The line "the ludics harness ..."
    // contains `ludics` followed by a space then a word, but it is not in
    // any code formatting. extractCodeSpans must yield no span for it.
    const md = "Use the ludics harness directory wisely.\n";
    expect(extractCodeSpans("a.md", md)).toHaveLength(0);
  });

  test("recognizes fences indented inside list items", () => {
    // Skill files like ludics-adopt-sessions.md nest fences at 3-space
    // indent inside numbered lists. The walker must accept a leading
    // \s* before the ``` delimiter.
    const md = ["1. step one", "   ```bash", "   ludics flow ready", "   ```"].join(
      "\n",
    );
    const spans = extractCodeSpans("a.md", md);
    // The fenced block contributes one span (the body line).
    expect(spans.some((s) => s.text.includes("ludics flow ready"))).toBe(true);
  });

  test("does not emit fence-delimiter lines as spans", () => {
    const md = ["```", "ludics mag start", "```"].join("\n");
    const spans = extractCodeSpans("a.md", md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("ludics mag start");
  });
});

// ---------------------------------------------------------------------------
// extractCliRefs — verb / sub / slot-id extraction (AC #4-#7)
// ---------------------------------------------------------------------------

describe("extractCliRefs", () => {
  test("extracts verb-only and verb+sub", () => {
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics mag start" },
      { file: "a.md", line: 2, text: "ludics briefing" },
    ]);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ verb: "mag", sub: "start", slotPlaceholder: null });
    expect(refs[1]).toMatchObject({ verb: "briefing", sub: null, slotPlaceholder: null });
  });

  test("accepts hyphenated verbs and subs (AC #7)", () => {
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics mag verify-container-completion" },
      { file: "a.md", line: 2, text: "ludics mag auto-start-evaluate" },
    ]);
    expect(refs[0]!.sub).toBe("verify-container-completion");
    expect(refs[1]!.sub).toBe("auto-start-evaluate");
  });

  test("rejects hyphen-suffixed skill names (AC #6)", () => {
    // `ludics-elaborate` and `/ludics-draft-proposal` are skill identifiers,
    // not CLI invocations. The anchor `(?<![/\w-])ludics\s+` requires a
    // space after `ludics`; the hyphen forms have no space and so do not
    // match. The negative lookbehind also rejects the leading-slash form.
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics-elaborate" },
      { file: "a.md", line: 2, text: "/ludics-draft-proposal-worker" },
    ]);
    expect(refs).toHaveLength(0);
  });

  test("rejects path segments where a slash precedes ludics (AC #6 regex anchor)", () => {
    // `~/ludics worktree`, `~/repos/ludics scripts/...` reference the
    // project root in a path, not a CLI invocation. The negative
    // lookbehind `(?<![/\w-])` ensures these are filtered.
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "git -C ~/ludics worktree add foo" },
      { file: "a.md", line: 2, text: "cwd: ~/repos/ludics scripts/foo.ts" },
    ]);
    expect(refs).toHaveLength(0);
  });

  test("dynamic-prefix `ludics slot N <sub>` (AC #5)", () => {
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics slot N assign task-101 -a tmux" },
      { file: "a.md", line: 2, text: "ludics slot 2 clear ready" },
      { file: "a.md", line: 3, text: "ludics slot $TASK_ID preempt urgent" },
      { file: "a.md", line: 4, text: "ludics slot <N> start" },
      { file: "a.md", line: 5, text: "ludics slot ${N} stop" },
    ]);
    expect(refs).toHaveLength(5);
    for (const r of refs) {
      expect(r.verb).toBe("slot");
      expect(r.slotPlaceholder).not.toBeNull();
    }
    expect(refs[0]!.sub).toBe("assign");
    expect(refs[1]!.sub).toBe("clear");
    expect(refs[2]!.sub).toBe("preempt");
    expect(refs[3]!.sub).toBe("start");
    expect(refs[4]!.sub).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
// resolveCliRefs — happy-path + negative-fixture (AC #10)
// ---------------------------------------------------------------------------

describe("resolveCliRefs", () => {
  test("happy path: known verb + known sub resolves with no error", () => {
    const top = new Set(["mag", "tasks", "briefing"]);
    const subs = new Map<string, Set<string>>([
      ["mag", new Set(["start", "stop", "elaborate"])],
    ]);
    const errors = resolveCliRefs(
      [
        { verb: "mag", sub: "start", slotPlaceholder: null, file: "a.md", line: 1 },
        { verb: "briefing", sub: null, slotPlaceholder: null, file: "a.md", line: 2 },
      ],
      top,
      subs,
    );
    expect(errors).toEqual([]);
  });

  test("negative-fixture: unknown sub is reported as unknown-sub error", () => {
    // AC #10 — a markdown string with a known-bogus reference yields one
    // resolution error. This is the exact shape that the triggering case
    // would have caught (`ludics mag verify-container-completion <id>`
    // pre-fix).
    const top = new Set(["mag"]);
    const subs = new Map<string, Set<string>>([["mag", new Set(["start"])]]);
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics mag does-not-exist" },
    ]);
    const errors = resolveCliRefs(refs, top, subs);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("unknown-sub");
    expect(errors[0]!.message).toContain("ludics mag does-not-exist");
    expect(errors[0]!.message).toContain("a.md:1");
  });

  test("negative-fixture: unknown top-level verb is reported", () => {
    const top = new Set(["mag"]);
    const subs = new Map<string, Set<string>>();
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics ghost-verb arg" },
    ]);
    const errors = resolveCliRefs(refs, top, subs);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("unknown-verb");
    expect(errors[0]!.message).toContain("ludics ghost-verb");
  });

  test("verb without a sub-dispatcher passes after top-level check", () => {
    // `ludics briefing` has no sub-dispatcher — no sub validation
    // attempted, even when a token follows.
    const top = new Set(["briefing"]);
    const subs = new Map<string, Set<string>>(); // empty — no dispatchers
    const refs = extractCliRefs([
      { file: "a.md", line: 1, text: "ludics briefing today-please" },
    ]);
    const errors = resolveCliRefs(refs, top, subs);
    expect(errors).toEqual([]);
  });

  test("ludics alias resolves via canonical (e.g. orchestration → orch)", () => {
    // AC #8 — alias allow-list. `orchestration` is an alias of `orch` in
    // 438's ALIASES["ludics"]. A skill citing `ludics orchestration status`
    // must resolve cleanly even though the orch dispatcher index is keyed
    // under `orch`. Conversely, `ludics orchestration bogus-sub` must
    // still be flagged — the alias must be validated against the canonical
    // dispatcher's case set, not silently skipped.
    const top = new Set(["orch", "orchestration"]);
    const subs = new Map<string, Set<string>>([
      ["orch", new Set(["status", "diff"])],
    ]);
    const okErrors = resolveCliRefs(
      [{ verb: "orchestration", sub: "status", slotPlaceholder: null, file: "a.md", line: 1 }],
      top,
      subs,
    );
    expect(okErrors).toEqual([]);
    const bogusErrors = resolveCliRefs(
      [{ verb: "orchestration", sub: "bogus-sub", slotPlaceholder: null, file: "a.md", line: 2 }],
      top,
      subs,
    );
    expect(bogusErrors).toHaveLength(1);
    expect(bogusErrors[0]!.kind).toBe("unknown-sub");
  });
});

// ---------------------------------------------------------------------------
// In-scope file collection
// ---------------------------------------------------------------------------

describe("collectInScopeFiles", () => {
  test("matches the documented scope set (AC #2)", () => {
    expect(IN_SCOPE_GLOBS).toEqual([
      "skills/*.md",
      "skills/orchestration/*.md",
      "templates/harness/CLAUDE.md",
      "templates/mag/memory/*.md",
    ]);
  });

  test("collects real files in repo across all four globs", () => {
    const root = join(import.meta.dir, "..");
    const files = collectInScopeFiles(root);
    // Pre-assertion harness probe: the world (real repo on main) must
    // actually have at least one file from each glob. If any glob is
    // empty, the integration test below would pass vacuously.
    expect(files.some((f) => f.startsWith("skills/") && !f.startsWith("skills/orchestration/"))).toBe(true);
    expect(files.some((f) => f.startsWith("skills/orchestration/"))).toBe(true);
    expect(files.some((f) => f === "templates/harness/CLAUDE.md")).toBe(true);
    expect(files.some((f) => f.startsWith("templates/mag/memory/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration against the real repo (AC #10, #13)
// ---------------------------------------------------------------------------

describe("real repository", () => {
  const root = join(import.meta.dir, "..");

  test("lintSkillCliRefs returns zero errors against real corpus (AC #13)", () => {
    const files = collectInScopeFiles(root);
    const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
    const usageBlock = extractUsageBlock(indexSrc);
    const result = lintSkillCliRefs(
      files,
      (rel) => readFileSync(join(root, rel), "utf-8"),
      usageBlock,
      (rel) => readFileSync(join(root, rel), "utf-8"),
    );
    expect(result.errors).toEqual([]);
  });

  // Floor-count meta-test (AC #9, gh-ludics-406 convention). The lint's
  // safety claim — "every backtick-/fence-scoped `ludics …` reference
  // resolves to a live dispatcher" — depends on the regex actually
  // matching meaningful refs in the corpus. A DRY refactor that hides
  // skill prose behind a partials/include mechanism would let this lint
  // pass vacuously. The current corpus has ~89 distinct refs across the
  // four globs; the floor of 30 is conservative with slack so individual
  // skill rewrites do not trip the lint.
  test("extractCliRefs: floor count of 30 against real corpus", () => {
    const files = collectInScopeFiles(root);
    const spans = files.flatMap((f) =>
      extractCodeSpans(f, readFileSync(join(root, f), "utf-8")),
    );
    const refs = extractCliRefs(spans);
    expect(refs.length).toBeGreaterThanOrEqual(30);
  });

  test("buildTopLevelIndex includes USAGE commands plus ludics aliases", () => {
    const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
    const top = buildTopLevelIndex(extractUsageBlock(indexSrc));
    // Pre-assertion harness probe: known commands must be present.
    expect(top.has("mag")).toBe(true);
    expect(top.has("tasks")).toBe(true);
    expect(top.has("slot")).toBe(true);
    expect(top.has("briefing")).toBe(true);
    // Alias coverage: `orchestration` is an alias of `orch` in 438's
    // ALIASES["ludics"], so it must be in the recognized top-level set.
    expect(top.has("orchestration")).toBe(true);
  });

  test("buildSubCommandIndex covers all 9 sub-dispatchers (8 from 438 + slot)", () => {
    const subs = buildSubCommandIndex((rel) =>
      readFileSync(join(root, rel), "utf-8"),
    );
    // Pre-assertion harness probe: each prefix has a non-empty case set.
    for (const prefix of [
      "mag", "flow", "tasks", "triggers", "notify", "cluster",
      "dashboard", "orch", "network", "slot",
    ]) {
      const set = subs.get(prefix);
      expect(set, `prefix "${prefix}" missing from sub index`).toBeDefined();
      expect(set!.size, `prefix "${prefix}" has empty case set`).toBeGreaterThan(0);
    }
    // The newly-added `mag sync-learnings` (drift-fix in this PR) must
    // be a recognized sub. If a future change drops the dispatcher case,
    // this assertion fails — guarding the AC #13 day-one fix.
    expect(subs.get("mag")!.has("sync-learnings")).toBe(true);
    // Slot dispatcher must include the canonical sub-set.
    for (const sub of ["assign", "clear", "start", "stop", "preempt", "resume", "restore", "mode", "note"]) {
      expect(subs.get("slot")!.has(sub), `slot sub "${sub}" missing`).toBe(true);
    }
  });
});
