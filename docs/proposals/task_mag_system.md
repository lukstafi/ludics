# Task: Mag System

## Goal
Implement Mag lifecycle, queue handling integration, skills scaffolding, and memory structure so automation can invoke Mag actions end-to-end.

## Scope
- Mag session management commands.
- Stop hook installation path and state path detection.
- Mag skills files in `skills/` directory.
- Mag memory templates under `templates/mag/`.
- Briefing/status integration in CLI.

## Deliverables
- `ludics mag start|stop|status|attach|logs` commands.
- `ludics init` optionally installs stop hook to a ludics-specific path (e.g., `~/.claude/hooks/ludics-on-stop.sh`) — don't overwrite existing hooks.
- Stop hook uses `LUDICS_STATE_PATH` or derives state path safely.
- Skills: `/ludics-briefing`, `/ludics-suggest`, `/ludics-analyze-issue`, `/ludics-elaborate`, `/ludics-health-check`, `/ludics-learn`, `/ludics-sync-learnings`, `/ludics-techdebt`.
- Mag memory templates — see ARCHITECTURE.md "Mag memory" section for structure (`mag/context.md`, `mag/memory/` subfiles).
- `ludics briefing` queues Mag, waits for result, renders `briefing.md`, notifies.
- `ludics status` includes Mag status (if available).

## Files to Touch
- `bin/ludics` (mag + briefing/status integration)
- `lib/common.sh` (mag wait helper, if needed)
- `templates/hooks/ludics-on-stop.sh`
- `templates/mag/` (new)
- `skills/` (new)
- `templates/config.reference.yaml` + `templates/harness/config.yaml` (mag config sections)

## Suggested Approach
1) Add Mag session commands first (tmux-based like claude-code).
2) Update stop hook to discover state path (prefer `LUDICS_STATE_PATH`, fallback to pointer config).
3) Add skills scaffolding with clear I/O expectations and file outputs.
4) Add memory templates under `templates/mag/`.
5) Wire `ludics briefing` to queue + wait + notify.

## Dependencies
- Queue implementation already exists in `lib/common.sh`.
- Notifications are already in `lib/notify.sh`.

## Validation
- Run shellcheck on changed scripts.
- Manual sanity check:
  - `ludics mag start`
  - `ludics mag briefing` queues and stop hook emits `/ludics-briefing`.
  - Results written to `mag/results/<id>.json`.

## Out of Scope
- Dashboard generation.
- Trigger expansion.
- CI integration.

## Risks
- `bin/ludics` and config templates overlap with other tracks.
- Skills content needs to be consistent with actual file paths and data formats.
