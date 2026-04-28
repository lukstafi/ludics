# Fix lint-cli-readme template literal parser

## Goal

`bun run lint:cli-readme` reports 12 spurious "stale docs" errors (`tasks`,
`flow`, `orch`, `notify`, `mag`, `status`, `briefing`, `init`, `stop`,
`triggers`, `doctor`, `help`) and breaks the CI `build` check on every PR
touching the repo. The README and `src/index.ts` USAGE constant are actually
in sync — the lint script's parser is buggy. Fix the parser so the gate
reflects reality.

Related: gh-ludics-426, task-6f217ebb (merged into this task), gh-ludics-404,
task-a00fc0d9 (PR authors and coders flagged this as pre-existing on
`origin/main`).

## Acceptance Criteria

- `bun run lint:cli-readme` exits 0 on the current `main` (no stale-docs errors).
- The script still detects genuine drift: if a command appears in the README
  CLI Reference but is missing from `USAGE`, the script reports it as stale
  and exits 1.
- The "undocumented" warnings list (USAGE commands not in README) is allowed
  to grow when the parser is fixed — those are non-fatal by design (per the
  script's own header comment).
- No changes to `README.md` content or `src/index.ts`'s `USAGE` constant.

## Context

The bug is in `scripts/lint-cli-readme.ts`, in the block that extracts the
`USAGE` template literal from `src/index.ts`:

```ts
const usageStart = indexSrc.indexOf("const USAGE =");
const usageEnd = indexSrc.indexOf(";", usageStart + "const USAGE =".length);
const usageBlock = usageStart !== -1 && usageEnd !== -1
  ? indexSrc.slice(usageStart, usageEnd)
  : "";
```

`USAGE` in `src/index.ts` is a backtick template literal spanning ~150 lines.
The parser uses the **first `;`** after `const USAGE =` as the end-of-block
delimiter, but the description for `slot <n> assign` inside the literal
contains the substring `cluster.machines);`. That parenthetical truncates
`usageBlock` to the first ~7 lines, so the regex
`/^\s{1,4}([a-z][\w-]*)\b/gm` only captures `slot` and `slots`. Every other
top-level command is silently dropped and falsely reported as "stale docs."

Verified 2026-04-28: `bun run lint:cli-readme` reproduces exactly the 12-name
list quoted in the task; `printUsage` already includes every flagged command
as a top-level entry.

Key files:

- `scripts/lint-cli-readme.ts` — the broken extractor (lines around the
  `usageStart`/`usageEnd` block above).
- `src/index.ts` — `const USAGE = \`...\`` (the help string). No edits.
- `README.md` — `## CLI Reference` section. No edits.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Replace the `;`-based end-delimiter lookup with a backtick-aware extractor.
The simplest robust form:

```ts
const usageMatch = indexSrc.match(/const USAGE = `([\s\S]*?)`/);
const usageBlock = usageMatch ? usageMatch[1] : "";
```

This captures the full template literal contents as opaque text, so any
punctuation inside (parentheses, semicolons, etc.) is irrelevant. The
existing `usageCommandPattern` regex then matches all top-level commands
correctly.

Then run `bun run lint:cli-readme` to confirm exit 0.

Add a small unit test at `scripts/lint-cli-readme.test.ts` that covers the
extractor: feed a sample source string whose `USAGE` template contains a
`;` inside the body and assert the extracted block includes content past
that semicolon (or, equivalently, that all expected top-level command names
are recognized). Bun's built-in test runner (`bun:test`) is used elsewhere
in `scripts/*.test.ts` — follow the same pattern (e.g. `lint-contracts.test.ts`).

Notes for the implementer:

- The current script is a top-level imperative module (runs on import).
  To make it testable, factor the extraction into an exported pure
  function (e.g. `extractUsageCommands(source: string): Set<string>`)
  and have the script call it. Other lint scripts in `scripts/` follow
  this split.
- Escaped backticks (`` \` ``) and `${...}` interpolations are not
  currently present in `USAGE`; the lazy `[\s\S]*?` regex handles the
  current contents correctly. No need to over-engineer.

## Scope

In scope:

- `scripts/lint-cli-readme.ts` — fix the extractor; optionally factor the
  parsing into an exported function for testability.
- `scripts/lint-cli-readme.test.ts` (new) — minimal unit test for the
  extractor.

Out of scope:

- Editing `README.md` to add or remove commands.
- Editing the `USAGE` constant in `src/index.ts`.
- Reconciling the "undocumented" warnings list (commands in `USAGE` but
  not in the README) — those are non-fatal warnings; expanding the README
  CLI Reference belongs in a separate task if desired.
- Adding new CLI subcommands.

Dependencies: none. No other tasks block this; merging it un-breaks the
`build` check for all PRs and closes the documentation-drift references in
gh-ludics-426, task-6f217ebb, task-a00fc0d9, gh-ludics-404.
