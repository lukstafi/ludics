# CLAUDE.md

Instructions for AI agents working on this repository.

## Project Overview

ludics is a lightweight personal AI infrastructure — a harness for humans working with AI agents. It manages concurrent agent sessions (slots), orchestrates autonomous task analysis (Mag), and maintains flow-based task management.

## Key Concepts

- **Slots**: Like CPUs, not memory. Each slot runs one process, holds runtime state, has no persistent identity.
- **Adapters**: Thin integrations with different agent systems (agent-duo, Claude Code, Codex, etc.)
- **Mag**: Persistent Claude Code session (Opus 4.5) that provides autonomous strategic coordination.
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
├── src/                    # TypeScript source (~22 modules, ~9K lines)
│   ├── index.ts            # CLI entry point & command dispatcher
│   ├── config.ts           # Two-tier config loading
│   ├── slots/              # Slot management (assign, clear, preempt)
│   ├── tasks/              # Task aggregation and management
│   ├── adapters/           # Adapter registry + implementations
│   ├── sessions/           # Session discovery pipeline
│   ├── flow.ts             # Flow engine (ready/blocked/critical)
│   ├── mag.ts              # Mag lifecycle & queue
│   ├── federation.ts       # Multi-machine leader election
│   └── ...
├── skills/                 # Mag skills (15 Markdown files)
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
2. Implement the `Adapter` interface: `readState()`, `start()`, `stop()`
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
- Prefer reading state from existing sources (like agent-duo's `.peer-sync/`) over creating new state
