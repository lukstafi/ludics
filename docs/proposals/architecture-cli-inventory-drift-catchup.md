# Update ARCHITECTURE.md command inventory to fix CLI drift (2 stale + 4 missing)

## Goal

The `## CLI Interface` command inventory in `docs/ARCHITECTURE.md` has drifted
from the real CLI command set defined by the `USAGE` constant in `src/index.ts`.
A 2026-06-20 audit (spun off from `task-ce21c233`'s retrospective) found 6 of 27
documented commands out of sync: 2 stale entries and 4 commands present in
`USAGE` but missing from the doc.

The user decided (2026-06-20) **not** to add a CI lint for this low-churn doc —
a one-time catch-up now plus as-noticed maintenance is sufficient. This task is
the one-time catch-up.

## Acceptance Criteria

*Intent: the `## CLI Interface` command inventory in `docs/ARCHITECTURE.md`
matches the real CLI command set in `src/index.ts`'s `USAGE` for the 6 audited
drifts, and the 21 already-in-sync commands stay in sync.*

- [ ] **Stale entry 1 fixed** — `auto-start-evaluate` is documented as a `mag`
      subcommand with the corrected signature. The current line
      `ludics auto-start-evaluate <id> [confidence] [rationale...]` (top-level,
      stale `[confidence]`) is replaced by an entry under the `# Mag
      interaction` group reading `ludics mag auto-start-evaluate <id> <high|low>
      [rationale]`, matching `USAGE` (`src/index.ts`, the `mag auto-start-evaluate`
      line).
- [ ] **Stale entry 2 fixed** — the `health run-tests` orphan is resolved by
      **removing the doc line** (and its `# Health monitoring` section heading,
      now empty). `runAllTestHealth()` in `src/health.ts` has no CLI entry point
      in `USAGE` / the command dispatch in `src/index.ts`, so the doc line
      describes a non-existent command. (Default per the task; the alternative
      — wiring a `health` command into the CLI — is explicitly not taken, since
      nothing in the codebase invokes it as a user-facing command.)
- [ ] **4 missing commands added** — the following, present in `USAGE` but absent
      from the inventory, are added in appropriate functional groups using the
      `USAGE` phrasing:
  - `ludics config proposals-path <project>` — print resolved proposals dir for a project
  - `ludics help` — show usage message
  - `ludics queue hold|resume|status` — suppress / re-enable / show automatic slot assignments
  - `ludics tmux status|list-panes|attach <slot> [agent]|capture <slot> [agent]` — tmux session inspection
- [ ] **Audited in-sync commands stay in sync** — a spot-check confirms none of
      the other audited commands regress: no documented command in the touched
      sections becomes absent from `USAGE`, and no `USAGE` command that the audit
      counted as in-sync is dropped.
- [ ] **No CI lint is added** — the change is doc-only (no `scripts/` lint, no
      `package.json` script, no CI workflow edit). The only file changed is
      `docs/ARCHITECTURE.md`.

## Context

- **Canonical source of truth:** the `USAGE` template-literal constant in
  `src/index.ts` (the long `Usage: ludics <command>` block, currently spanning
  roughly the `slots` line through `help Show this message`). This is the
  authoritative command list — what `ludics help` prints.
- **Drifted target:** the `## CLI Interface` fenced `bash` block in
  `docs/ARCHITECTURE.md` (between the `## CLI Interface` heading and the next
  `## Design Principles` heading). It is organized into `#`-commented functional
  groups (`# Slot management`, `# Task management`, `# Flow views`,
  `# Orchestration control`, `# t3code server management`, `# Events`,
  `# Mag interaction`, `# Session discovery`, `# Notifications`, `# Dashboard`,
  `# State synchronization`, `# Journal`, `# Cluster`, `# Health monitoring`,
  `# Network`, `# Setup & diagnostics`).
- **Extraction-pattern precedent:** `scripts/lint-cli-readme.ts` already encodes
  how command tokens are extracted from `USAGE`
  (`^\s{1,4}([a-z][\w-]*)\b`) and is the linted sibling that keeps the README's
  `## CLI Reference` current. This task deliberately does **not** add an
  analogous lint for ARCHITECTURE.md.
- **Specific drift locations** (by content, not line number — lines drift):
  - The `# Mag interaction` group contains the stale top-level
    `ludics auto-start-evaluate <id> [confidence] [rationale...]` line — it sits
    in the Mag block already but is written without the `mag` prefix and with the
    stale `[confidence]` arg.
  - The `# Health monitoring` group contains only the orphan
    `ludics health run-tests [--project=NAME] [--force]` line; removing it empties
    the group, so the `# Health monitoring` comment heading is removed too.
  - `config`, `help`, `queue`, `tmux` have no corresponding entries anywhere in
    the block.
- **Verification commands** (run from `/Users/lukstafi/ludics`):
  - Confirm `auto-start-evaluate` is a `mag` subcommand:
    `grep -n "auto-start-evaluate" src/index.ts` → only the `mag auto-start-evaluate <id> <high|low> [rationale]` line.
  - Confirm no `health` CLI command exists:
    `grep -nE "^  health" src/index.ts` → no match (only `mag health-check` and prose).
  - Confirm the 4 missing commands are top-level in `USAGE`:
    `grep -nE "^  (config|help|queue|tmux) " src/index.ts` → matches for all four.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Edit only `docs/ARCHITECTURE.md`'s `## CLI Interface` fenced block:

1. In the `# Mag interaction` group, replace the stale `auto-start-evaluate`
   line with `ludics mag auto-start-evaluate <id> <high|low> [rationale]  # Evaluate auto-start decision`.
2. Delete the `# Health monitoring` heading and its single `health run-tests`
   line.
3. Add the 4 missing commands to fitting groups, matching `USAGE` phrasing:
   - `tmux` lines → place near orchestration / adapter inspection (e.g., a new
     `# tmux inspection` group, or fold into an existing nearby group).
   - `queue hold|resume|status` → a `# Queue control` group (or fold near slot
     management — these gate automatic slot assignment).
   - `config proposals-path <project>` → the `# Setup & diagnostics` group.
   - `help` → the `# Setup & diagnostics` group, alongside `doctor` / `status`.
   Exact grouping is the implementer's call; faithfulness to `USAGE` phrasing and
   keeping the audited 21 in-sync commands unchanged is what matters.

## Scope

**In scope:** edits to the `## CLI Interface` block of `docs/ARCHITECTURE.md`
covering exactly the 6 audited drifts, plus removing the now-empty
`# Health monitoring` heading.

**Out of scope:**
- Any CI lint, `package.json` script, or CI workflow change (explicit user
  decision: as-noticed maintenance only).
- Wiring a `health` CLI command (the orphan is resolved by doc removal, not by
  adding a command).
- A full reconciliation of *every* divergence between `USAGE` and the
  ARCHITECTURE.md block beyond the 6 audited drifts. The audit scoped this to
  those 6; the AC spot-check guards only against regressing the audited in-sync
  set, not against pre-existing divergences the audit did not flag.

**Dependencies:** relates to `task-ce21c233` (origin of the retrospective
finding); no blocking dependencies.
