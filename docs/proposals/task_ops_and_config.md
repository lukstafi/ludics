# Task: Ops + Config

## Goal
Harden operational tooling: config parsing/templates, triggers, and doctor checks.

## Scope
- Config parsing helpers for `mag.*` and `notifications.*`.
- Update config templates with mag/notifications sections.
- Trigger expansion (morning/health/watchpaths) + status/uninstall.
- `ludics doctor` comprehensive checks.

## Deliverables
- Config helpers in `lib/common.sh` (or new lib) for mag/notifications.
- Updated templates:
  - `templates/config.reference.yaml`
  - `templates/harness/config.yaml`
- Trigger updates in `lib/triggers.sh`:
  - StartCalendarInterval (morning briefing)
  - StartInterval (health check)
  - WatchPaths (repo change)
  - Startup trigger (on login)
  - `triggers status` + `triggers uninstall`
- `ludics doctor` command with required/optional tool checks.

## Files to Touch
- `lib/common.sh` (config helpers)
- `lib/triggers.sh`
- `bin/ludics` (doctor + trigger subcommands)
- `templates/config.reference.yaml`
- `templates/harness/config.yaml`

## Suggested Approach
1) Add config helpers using `yq` (already a dependency per ARCHITECTURE.md).
2) Expand templates with mag/notifications sections.
3) Extend triggers install with additional trigger types + status/uninstall.
4) Implement `ludics doctor` command, reuse adapter doctor functions where available.

## Dependencies
- Mag track for precise mag config fields.
- Slot/task track for state sync expectations.

## Validation
- Run shellcheck on changed scripts.
- Manual sanity check:
  - `ludics triggers install`
  - `ludics triggers status`
  - `ludics doctor`

## Out of Scope
- Dashboard generation.
- Mag skills content.

## Risks
- `bin/ludics` merge conflicts with other tracks.
