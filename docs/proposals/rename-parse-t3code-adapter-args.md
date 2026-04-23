# Rename `parseT3CodeAdapterArgs` to `parseOrchestrationAdapterArgs`

## Goal

The function `parseT3CodeAdapterArgs` in `src/adapters/t3code.ts` is imported
and used by both the t3code adapter and the tmux adapter (`tmux-adapter.ts`) —
there is no separate `parseTmuxAdapterArgs`. The t3code-first name is
historical and misleads readers into thinking the parser is t3code-specific.
Rename it to `parseOrchestrationAdapterArgs` to reflect its actual role as the
shared orchestration-args parser consumed by every adapter that spawns
coder/reviewer agents.

Spun off from gh-ludics-337 elaboration; related to task-8f5a78a1.

## Acceptance Criteria

- The function exported from `src/adapters/t3code.ts` is named
  `parseOrchestrationAdapterArgs`; no export named `parseT3CodeAdapterArgs`
  remains.
- All call sites and imports in the codebase use the new name:
  - `src/adapters/t3code.ts` (definition + self-use inside `start()`).
  - `src/adapters/tmux-adapter.ts` (named import + call inside `start()`).
  - `src/adapters/t3code.test.ts` (named import + all direct invocations).
- Both `describe(...)` block titles in `src/adapters/t3code.test.ts` use the
  new name, so `bun test --grep parseOrchestrationAdapterArgs` selects them.
- Error-message strings thrown from the parser body that use the
  `"t3code adapter args: ..."` prefix are updated to
  `"orchestration adapter args: ..."` (including the un-prefixed
  `"unterminated quote in t3code adapter args"` → `"unterminated quote in orchestration adapter args"`).
- The two comments in `src/adapters/tmux-adapter.ts` that describe the
  parser/helpers as `shared with t3code adapter` / `duplicated from t3code adapter`
  are lightly rephrased so they read as peer-shared rather than t3code-primary
  (both adapters are now peers consuming a shared parser).
- `bun test` passes; `bun run build` (or the project's equivalent lint/type
  check) passes.
- No references to `parseT3CodeAdapterArgs` remain in `src/**` (excluding
  historical proposal docs under `docs/proposals/`, which are deliberately
  left untouched — see Scope).

## Context

### Files

- `src/adapters/t3code.ts` — defines `parseT3CodeAdapterArgs` (the `export function`
  around the top of the parser section) and calls it inside this adapter's
  `start()`. Also contains the thrown `Error` strings with the
  `"t3code adapter args: ..."` prefix (and one `"unterminated quote in t3code adapter args"`).
- `src/adapters/tmux-adapter.ts` — `import { parseT3CodeAdapterArgs } from "./t3code.ts"`;
  calls it inside this adapter's `start()`. Contains the two section-header
  comments marked `shared with t3code adapter` and `duplicated from t3code adapter`.
- `src/adapters/t3code.test.ts` — imports the parser, has two `describe(...)`
  blocks titled `"parseT3CodeAdapterArgs"` and `"parseT3CodeAdapterArgs — --solo"`,
  and roughly fifteen direct invocations inside test bodies.

### Related symbols (unchanged)

- `ParsedAdapterArgs` — the parser's return-type interface in `t3code.ts`, already
  adapter-neutral; module-local; leave as-is.
- `ParsedOrchestrationArgs` (nested inside `ParsedAdapterArgs.orchestration`) —
  already neutral; leave as-is.
- No `T3CodeAdapterArgs` type alias exists anywhere in the codebase; no such
  rename is needed.
- Sibling helpers in `t3code.ts` are already neutrally named:
  `selectOrchestrationFlags`, `selectOrchestrationFlagsForTask`,
  `startOrchestrationProcess`. `parseOrchestrationAdapterArgs` fits the
  established `…Orchestration…` naming family in this module.

### Name rationale

- No collision: `grep parseOrchestration` in the codebase returns no prior hits.
- Keeping the `Adapter` in the new name signals that the parser consumes the
  per-slot `ctx.adapterArgs` free-form string, distinguishing it from any
  future high-level orchestration-config parser.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

A mechanical, grep-driven rename. The concrete edits are:

1. In `src/adapters/t3code.ts`:
   - Rename the exported function: `export function parseT3CodeAdapterArgs` →
     `export function parseOrchestrationAdapterArgs`.
   - Update the self-use inside this adapter's `start()`.
   - Update every thrown error-message string from
     `"t3code adapter args: ..."` to `"orchestration adapter args: ..."`,
     including the one un-prefixed `"unterminated quote in t3code adapter args"`
     → `"unterminated quote in orchestration adapter args"`.
2. In `src/adapters/tmux-adapter.ts`:
   - Update the named import and the one call site.
   - Lightly rephrase the two section comments so they read as peer-shared
     (e.g., `// Workspace & feature helpers (shared with the t3code adapter)`
     → `// Workspace & feature helpers (shared across orchestration adapters)`;
     and `// Agent model / effort resolution (duplicated from t3code adapter …)`
     → `// Agent model / effort resolution (shared across orchestration adapters
     — not yet extracted to a shared module)`). Exact wording at the coder's
     discretion; the goal is to remove the implication that `t3code` is the
     primary and `tmux` the derivative.
3. In `src/adapters/t3code.test.ts`:
   - Update the named import.
   - Rename both `describe(...)` titles (`"parseT3CodeAdapterArgs"` →
     `"parseOrchestrationAdapterArgs"`; `"parseT3CodeAdapterArgs — --solo"` →
     `"parseOrchestrationAdapterArgs — --solo"`).
   - Update every direct invocation inside the test bodies.
4. Run `bun test` to confirm tests still pass (and that the describe-title
   rename did not inadvertently break any grep-based test filter elsewhere).
5. Run the project's build / type-check (`bun run build` or equivalent) to
   confirm no stale references remain.

A final `grep -rn parseT3CodeAdapterArgs src/` should return no hits when done.

## Scope

**In scope**:

- Renaming the exported function in `src/adapters/t3code.ts` and all call
  sites in `src/`.
- Updating the two `describe(...)` titles in `src/adapters/t3code.test.ts`.
- Updating the error-message string prefixes in the parser body from
  `"t3code adapter args: ..."` to `"orchestration adapter args: ..."`
  (per user resolution of Q1).
- Lightly rephrasing the two `shared with t3code adapter` /
  `duplicated from t3code adapter` section comments in `tmux-adapter.ts`.

**Out of scope**:

- Restructuring the parser itself or splitting adapter-specific vs. shared
  args — if such a split turns out to be warranted, that's a separate task.
- Touching the `T3CodeAdapter*` types or symbols that genuinely are
  t3code-specific.
- Updating the `ParsedAdapterArgs` / `ParsedOrchestrationArgs` interface
  names — already neutral.
- Renaming the test file `t3code.test.ts` — the parser still physically
  lives in `t3code.ts`, so the file placement is correct.
- Updating historical proposal docs under `docs/proposals/` that reference
  `parseT3CodeAdapterArgs` as part of their own narrative
  (`solo-mode-and-tiny-effort.md`, `task-b4fd32ed.md`,
  `orchestration-patterns-bundle-2026-04.md`,
  `t3code-reviewer-only-flag-comment.md`). Per the user's resolution of Q2,
  proposals are historical documents recording the code state at the time;
  preserving the old symbol name in those files is correct.
- Any harness-repo changes — no references to the symbol exist outside
  `~/ludics/`.

### Dependencies

- None. Independent of the task-ba243220 docs bundle and of
  gh-ludics-337's main resolution path.
