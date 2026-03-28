# Task: Core State + CLI Integration

## Goal
Unify slot/task state handling, bring `slots.md` in line with ARCHITECTURE, add safe state sync helpers, and integrate new commands into the CLI with minimal conflicts.

## Scope
- Slots/task integration and `slots.md` format parity.
- State pull/sync helpers in `lib/common.sh`.
- CLI wiring for state sync and slot operations.
- Journal/audit trail hooks for slot events.

## Deliverables
- `slots.md` format aligned with ARCHITECTURE (Process/Task/Mode/Session/Terminals/Runtime/Git).
- `slot assign` updates task file metadata (status/slot/started/adapter).
- `slot clear` clears task slot and optionally marks done/abandoned.
- `slot start` uses slot metadata (Mode/Task/Session/Project) to call adapters.
- `slots refresh` reads adapter state and updates slot runtime sections.
- `ludics_state_pull()` + a user-facing `ludics sync` or `ludics state sync`.
- Journal entries for slot events.

## Files to Touch
- `lib/slots.sh` (slot formatting, assign/clear/start/refresh)
- `lib/common.sh` (state pull/sync helpers)
- `bin/ludics` (new commands)
- `templates/harness/slots.md` (format example)
- `docs/ARCHITECTURE.md` (add `slots refresh` to CLI section)

## Suggested Approach
1) Define the canonical `slots.md` schema and update templates + parsing.
2) Update slot assign/clear to also update task files in `tasks/`.
3) Add `slots refresh` to read adapter state into Runtime/Terminals blocks.
4) Add `ludics_state_pull()` and `ludics sync` wrapper (pull then update).
5) Add journal append helper (file: `journal/YYYY-MM-DD.md`) for slot events.

## Dependencies
- Needs a stable `slots.md` schema (coordinate with dashboard track).
- Task file format is already in `lib/tasks.sh` (YAML frontmatter).

## Validation
- Run shellcheck on changed scripts.
- Manual sanity check:
  - `ludics slot 1 assign task-001`
  - `ludics slot 1 start`
  - `ludics slot 1 note "..."`
  - `ludics slot 1 clear`
  - Ensure slot/task files and journal update as expected.

## Out of Scope
- Mag session management and skills.
- Dashboard rendering.
- Trigger expansion.

## Risks
- `bin/ludics` is a hotspot; coordinate with other tracks.
- `slots.md` schema changes affect dashboard parsing.
