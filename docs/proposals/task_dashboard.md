# Task: Dashboard

## Goal
Complete the read-only dashboard pipeline: generate JSON data, serve/install the dashboard, and add the terminal grid view.

## Scope
- Dashboard data generation from slots/tasks/journal/mag status.
- Serve/install commands in CLI.
- Terminal grid view HTML/JS.

## Deliverables
- `ludics dashboard generate` produces:
  - `dashboard/data/slots.json`
  - `dashboard/data/ready.json`
  - `dashboard/data/notifications.json`
  - `dashboard/data/mag.json`
- `ludics dashboard serve` starts a local HTTP server.
- `ludics dashboard install` copies templates to state repo.
- `templates/dashboard/terminals.html` with 3x2 ttyd grid and tab support.
- Shared schema documented (slots.json, mag.json).

## Files to Touch
- `bin/ludics` (dashboard subcommands)
- `lib/flow.sh` (ready output helper, if needed)
- `lib/slots.sh` (slots -> JSON helper, if needed)
- `templates/dashboard/*`
- `docs/ARCHITECTURE.md` (only if schema clarifications needed)

## Suggested Approach
1) Define JSON schemas for slots/mag/ready/notifications.
2) Build `dashboard generate` using existing slot/task/journal sources.
3) Add serve/install commands.
4) Implement `terminals.html` + JS (tabs per slot).

## Dependencies
- Requires stable `slots.md` schema and task format.
- Mag status schema should match mag session mgmt output.

## Validation
- Run `ludics dashboard generate` and open `templates/dashboard/index.html` via `serve`.
- Confirm dashboard renders with placeholder or real data.

## Out of Scope
- Mag session management.
- Trigger expansion.
- CI integration.

## Risks
- JSON schema coupling to slot/Mag formats. Coordinate before finalizing.
