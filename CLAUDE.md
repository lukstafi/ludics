# CLAUDE.md

Instructions for AI agents working on this repository.

## Project Overview

ludics is a lightweight personal AI infrastructure — a harness for humans working with AI agents. It manages concurrent agent sessions (slots), runs multi-agent coding workflows via t3code or tmux, orchestrates autonomous task analysis (Mag), and maintains flow-based task management.

## Key Concepts

- **Slots**: Like CPUs, not memory. Each slot runs one process, holds runtime state, has no persistent identity. Supports preemption and mode toggle.
- **Adapters**: Thin integrations with different agent systems. The `t3code` adapter supports orchestrated multi-agent workflows; the `tmux` adapter is currently primary due to t3code stability issues, but t3code remains the target as its stability improves. Assignable adapter modes are `tmux`, `t3code`, and `manual`.
- **Orchestration**: Phase-driven multi-agent workflow engine (21 phases) — pair mode (coder + reviewer), hierarchical duo mode (two paired slots with swapped roles), cross-slot merge coordination.
- **Mag**: Persistent Claude Code session (Opus) providing autonomous strategic coordination. Skills use orchestrator/worker pattern for context isolation.
- **Federation**: Multi-machine coordination with seniority-based leader election. Slot intent files for cross-machine dispatch (replaced SSH).
- **State**: Stored in a separate private repo, not here. This repo is public tooling only.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Code Style

- 100% TypeScript (Bun runtime)
- Compiled to standalone binary via `bun build --compile`
- Shell commands invoked via `Bun.spawnSync()` / `Bun.spawn()` where needed
- Clear error messages
- Minimal dependencies (only `yaml` npm package)

## Directory Structure

```
ludics/
├── bin/ludics              # Compiled standalone binary (~60MB)
├── src/                    # TypeScript source (~80 modules, ~27K lines)
│   ├── index.ts            # CLI entry point & command dispatcher
│   ├── config.ts           # Two-tier config loading
│   ├── mag.ts              # Mag lifecycle, queue, auto-start, deferred launch (~3.5K lines)
│   ├── flow.ts             # Flow engine (ready/blocked/critical)
│   ├── federation.ts       # Multi-machine leader election + worker keepalive (~590 lines)
│   ├── slot-intents.ts     # Cross-machine slot intent files
│   ├── slots/              # Slot management (assign, clear, preempt, duo-expand, mode toggle)
│   ├── tasks/              # Task aggregation and management
│   ├── adapters/           # Adapter registry + implementations (t3code + tmux)
│   ├── orchestration/      # Multi-agent workflow engine (~9K lines, 21 phases)
│   ├── t3code/             # t3code server integration (~1K lines)
│   ├── sessions/           # Session discovery pipeline
│   └── ...
├── skills/                 # Mag skills (22 files: 15 skills + 5 workers + conventions)
├── skills/orchestration/   # Orchestration phase templates (24 files)
├── templates/              # Config templates, launchd/systemd, dashboard HTML
└── tests/                  # Test suite
```

## Build & Dev

```bash
bun run build              # Compile to bin/ludics
bun run dev -- <args>      # Run from source
bun run typecheck          # Type checking only
```

## Testing

When making changes:
1. Run `bun run typecheck` for type errors
2. Test locally with a mock config before pushing
3. Ensure adapters fail gracefully when their target isn't available

## Common Tasks

### Adding an adapter

1. Create `src/adapters/<name>.ts`
2. Implement the `Adapter` interface: `readState()`, `start()`, `stop()`, `lastActivity()`
3. Register in `src/adapters/index.ts`

### Adding a trigger type

1. Add to `src/triggers.ts`
2. Create template plist/service in `templates/launchd/` or `templates/systemd/`
3. Update `ludics triggers install`

### Adding a Mag skill

1. Create `skills/ludics-<name>.md` with skill instructions
2. Add queue action mapping in `src/mag.ts` if needed

## Important Notes

- Never store user data in this repo — all state goes to the user's private repo
- Keep dependencies minimal
- Prefer reading state from existing sources (like `.peer-sync/` orchestration data) over creating new state
- the `tmux` adapter is currently used for most orchestrated workflows; the t3code adapter has richer functionality but is pending stability improvements. Both paths are maintained.
