# Migration Notes

This document tracks format changes and conversion steps during the TypeScript migration.

## Phase 0: Scaffold

- `bin/pai-lite` now execs the compiled TypeScript binary (`pai-lite-ts`).
- Commands not yet migrated print `"pai-lite <cmd>: not yet migrated"` and exit 1.
- New dependency: [Bun](https://bun.sh) (v1.1+). Install with `curl -fsSL https://bun.sh/install | bash`.

## Phase 1: Session Discovery

- `pai-lite sessions` and `pai-lite sessions report` are now handled by TypeScript.
- The sessions report (`sessions.md`) format is functionally equivalent to the Bash version.
  Minor whitespace/ordering differences may occur. Since the report is regenerated on every
  run and not stored as persistent state, no conversion is needed.

## Phase 2: Core Data Model

- Config parsing replaced `yq` subprocess calls with native YAML parsing via the `yaml` npm package.
  The `yq` command is no longer required for config reading.
- Slot operations (`slots`, `slot <n> assign/clear/note/start/stop`) now use TypeScript.
  The slots.md format is unchanged.
- Task operations (`tasks sync/list/show/convert/create/files/samples/needs-elaboration/check/merge/duplicates`)
  now use TypeScript. Task file format (YAML frontmatter + Markdown) is unchanged.
- State repo operations (`sync`, `state pull`, `state push`) now use `Bun.spawnSync` for git.
- Journal operations (`journal`, `journal recent`, `journal list`) now use TypeScript.
- `tasks migrate-refs` was initially removed during migration as a one-time utility.
  It has since been reintroduced in TypeScript to migrate legacy `task-<number>`
  IDs to deterministic `task-<title-hash>` IDs and rewrite cross-references.
- Adapter dispatch: `slot <n> start/stop` still invokes Bash adapter scripts via subprocess.
  The adapters themselves remain in Bash.

## Phase 3: CLI Entry Point

- `bin/pai-lite` is now the compiled TypeScript binary (via `bun build --compile`).
  The Bash wrapper has been removed from git. After cloning, run `bun install && bun run build`.
- `yq` is no longer required. Removed from README dependencies.
- Development workflow: `bun run dev` runs from source, `bun run build` compiles to `bin/pai-lite`.

## Phase 4: Remaining Modules

- Flow engine (`flow ready/blocked/critical/impact/context/check-cycle`) ported to TypeScript.
  Replaces `yq`/`jq` subprocess calls with native YAML parsing and in-process logic.
  Cycle detection uses Kahn's algorithm instead of `tsort`.
- Notification system (`notify pai/agents/public/recent`) ported to TypeScript.
  Uses `Bun.spawnSync` for `curl` calls to ntfy.sh. Local JSONL logging unchanged.
- Network configuration (`network status`) ported to TypeScript.
  Tailscale hostname detection via `Bun.spawnSync` with graceful fallback when unavailable.
- Federation (`federation status/tick/elect/heartbeat`) ported to TypeScript.
  Leader election and heartbeat logic reimplemented natively.
- Mayor session management (`mayor start/stop/status/attach/logs/doctor/briefing/suggest/analyze/elaborate/health-check/message/inbox/queue/context`) ported to TypeScript.
  Tmux session control uses `Bun.spawnSync`. Queue pop and briefing context pre-computation are native.
- Trigger installation (`triggers install/uninstall/status`) ported to TypeScript.
  Generates launchd plists (macOS) and systemd units (Linux) natively.
- Dashboard (`dashboard generate/serve/install`) ported to TypeScript.
  JSON data generation is native (no `jq`). Serve still delegates to `dashboard_server.py`.
- `status` command now works (shows slots + flow ready).
- `briefing` command now works (queues briefing request via Mayor).
- `doctor` command now works (Mayor health check).
- `jq` is no longer required for flow engine, dashboard data generation, or federation.
  It is still needed by the Python dashboard server and by adapters that remain in Bash.
- `init` remains unmigrated (prints "not yet migrated").
