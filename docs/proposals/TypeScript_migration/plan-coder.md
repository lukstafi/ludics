# Implementation Plan (Revised)

## Changes from Round 1

Addressing reviewer feedback:

1. **Fallback contradiction resolved**: TS binary is the sole entry point from Phase 0 onward. Unmigrated commands print `"pai-lite <cmd>: not yet migrated"` and exit 1 — no Bash fallback at any phase.
2. **CI tasks added**: Phase 0 includes GitHub Actions workflow with `bun install`, `bun run typecheck`, `bun run build`.
3. **Format changes section added**: Conversion commands and documentation location defined for any artifact format changes.
4. **Parity checkpoints added**: Each phase includes explicit verification before deleting Bash modules.

## Approach

Migrate pai-lite from Bash to TypeScript+Bun incrementally across 4 phases, each as a separate commit. The TS binary is the single entry point from Phase 0 — unmigrated commands fail explicitly with "not yet migrated" instead of falling back to Bash. Phase 0 scaffolds the project and CI. Phase 1 ports session discovery. Phase 2 ports core data model (config, slots, tasks, state). Phase 3 replaces the CLI dispatch. Phase 4 ports remaining modules. Crash on errors throughout.

## Key Decisions

1. **Single entry point, no Bash fallback**: From Phase 0, `bin/pai-lite` execs the TS binary. Commands not yet migrated print `"pai-lite <cmd>: not yet migrated"` and exit 1. This is consistent with the user's "no fallback to Bash" directive.
2. **Bun.$ for subprocesses**: Use Bun's shell integration for git, tmux, pgrep, gh, yq calls. Replace yq with native YAML parsing in Phase 2.
3. **Crash on errors**: Use `throw` liberally. No try/catch for graceful degradation. Process exits non-zero on unhandled errors. Missing optional tools (tmux, ttyd) are the exception — their absence means "skip that scanner" not "crash".
4. **Delete after parity**: Each Bash file is deleted only after its TS replacement passes a parity checkpoint (documented per phase below).
5. **No legacy conversion porting**: `tasks migrate-refs` and similar one-time utilities are not ported.
6. **Format changes documented**: Any artifact format change includes a conversion command in `bin/pai-lite-migrate` and a note in `MIGRATION.md`.

## Format Changes Policy

When a migrated module changes the format of an output artifact (e.g., `sessions.md`, `slots.md`, task files):

- **Conversion command**: Add a subcommand to the TS binary (e.g., `pai-lite migrate sessions-v2`) that converts existing artifacts to the new format.
- **Documentation**: Add a section to `MIGRATION.md` (created in Phase 0) describing what changed, why, and how to convert.
- **Expectation**: Format changes should be well-motivated (not just cosmetic). The current formats are fine as-is if the TS code can produce them identically.

For Phase 1, the sessions report (`sessions.md`) format may change slightly (TS produces cleaner Markdown). Since the report is regenerated on every run and not stored as persistent state, no conversion command is needed — just a note in MIGRATION.md.

## File Changes

### Phase 0: Scaffold

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Create | Bun project: typescript, @types/bun |
| `tsconfig.json` | Create | Strict mode, ES2022, Bun module resolution |
| `src/index.ts` | Create | Entry point — routes commands, "not yet migrated" for unknown |
| `src/types.ts` | Create | Shared type definitions (Session, MergedSession, Slot, etc.) |
| `.github/workflows/ci.yml` | Create | CI: bun install, typecheck, build |
| `MIGRATION.md` | Create | Documents format changes and conversion steps |
| `README.md` | Modify | Add Bun to dependencies with install instructions |
| `.gitignore` | Modify | Add node_modules/, pai-lite-ts binary |
| `bin/pai-lite` | Modify | Exec TS binary unconditionally (no Bash fallback) |

### Phase 1: Session Discovery

| File | Action | Description |
|------|--------|-------------|
| `src/config.ts` | Create | Config reading via yq subprocess (temporary) |
| `src/slots/paths.ts` | Create | Extract slot paths from slots.md for classification |
| `src/sessions/discover-codex.ts` | Create | Codex JSONL scanning |
| `src/sessions/discover-claude.ts` | Create | Claude Code index + JSONL scanning |
| `src/sessions/discover-tmux.ts` | Create | tmux list-panes parsing |
| `src/sessions/discover-ttyd.ts` | Create | ttyd process discovery |
| `src/sessions/enrich.ts` | Create | .peer-sync walk-up enrichment |
| `src/sessions/dedup.ts` | Create | Dedup by normalized cwd, priority ranking |
| `src/sessions/classify.ts` | Create | Longest-prefix slot classification |
| `src/sessions/report.ts` | Create | JSON + Markdown report output |
| `src/sessions/index.ts` | Create | Pipeline orchestration + CLI handlers |
| `MIGRATION.md` | Modify | Note: sessions report format changes (if any) |
| `lib/sessions.sh` | Delete | **After parity checkpoint** |

### Phase 2: Core Data Model

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Add `yaml` package for native YAML parsing |
| `src/config.ts` | Rewrite | Native YAML config (two-tier: pointer → full) |
| `src/state.ts` | Create | State repo git operations via Bun.$ |
| `src/slots/types.ts` | Create | Slot type definitions |
| `src/slots/markdown.ts` | Create | Parse/serialize slots.md |
| `src/slots/index.ts` | Create | Slot operations (list, show, assign, clear, start, stop, note) |
| `src/tasks/types.ts` | Create | Task type with YAML frontmatter |
| `src/tasks/markdown.ts` | Create | Parse/serialize task-NNN.md files |
| `src/tasks/sync.ts` | Create | Aggregate from GitHub + watch paths |
| `src/tasks/index.ts` | Create | Task operations (sync, list, show, create, convert, etc.) |
| `src/adapters/index.ts` | Create | Adapter dispatch (start/stop session via subprocess) |
| `lib/slots.sh` | Delete | **After parity checkpoint** |
| `lib/tasks.sh` | Delete | **After parity checkpoint** |
| `lib/common.sh` | Delete | **After parity checkpoint** |

### Phase 3: CLI Entry Point

| File | Action | Description |
|------|--------|-------------|
| `src/cli/index.ts` | Create | Main CLI router with help text |
| `src/cli/slots.ts` | Create | Slot subcommand handlers |
| `src/cli/tasks.ts` | Create | Task subcommand handlers |
| `src/cli/sessions.ts` | Create | Session subcommand handlers |
| `src/cli/flow.ts` | Create | Flow subcommand handlers (stub: "not yet migrated") |
| `src/cli/mayor.ts` | Create | Mayor subcommand handlers (stub: "not yet migrated") |
| `src/cli/misc.ts` | Create | status, briefing, doctor, sync, state, journal, etc. |
| `src/index.ts` | Modify | Delegate to cli/index.ts |
| `bin/pai-lite` | Simplify | Pure exec to compiled binary |

### Phase 4: Remaining Modules

| File | Action | Description |
|------|--------|-------------|
| `src/flow/index.ts` | Create | Flow engine (ready, blocked, critical, impact, context) |
| `src/flow/deps.ts` | Create | Dependency graph + cycle detection (native TS, no tsort) |
| `src/mayor/index.ts` | Create | Mayor lifecycle (start, stop, status, attach, logs) |
| `src/mayor/queue.ts` | Create | Queue JSONL read/write |
| `src/mayor/inbox.ts` | Create | Inbox append/consume/archive |
| `src/mayor/briefing.ts` | Create | Context precomputation |
| `src/triggers/index.ts` | Create | launchd/systemd generation + install |
| `src/notify/index.ts` | Create | Three-tier ntfy.sh notifications |
| `src/dashboard/index.ts` | Create | Data generation + Bun HTTP server |
| `src/network/index.ts` | Create | Network status + Tailscale |
| `src/federation/index.ts` | Create | Multi-machine federation |
| `src/journal/index.ts` | Create | Journal append/read/list |
| `src/doctor.ts` | Create | System health check |
| `src/init.ts` | Create | pai-lite init (install binary, state repo, skills, hooks, triggers) |
| `lib/*.sh` | Delete | **After parity checkpoint** for each |
| `adapters/*.sh` | Delete | **After parity checkpoint** |
| `bin/pai-lite` | Delete | Compiled binary becomes the sole entry point |

## Implementation Steps

### Phase 0: Scaffold
1. [ ] Install Bun (`curl -fsSL https://bun.sh/install | bash`)
2. [ ] Run `bun init`, configure `package.json` (name: pai-lite, scripts: build, typecheck)
3. [ ] Create `tsconfig.json` (strict, ES2022, Bun module resolution, skipLibCheck)
4. [ ] Create `src/index.ts` — parse process.argv, route known commands, print "not yet migrated" for others
5. [ ] Create `src/types.ts` — Session, MergedSession, Slot, Config types
6. [ ] Add build script in package.json: `"build": "bun build --compile src/index.ts --outfile pai-lite-ts"`
7. [ ] Add typecheck script: `"typecheck": "bun x tsc --noEmit"`
8. [ ] Create `.github/workflows/ci.yml` — install Bun, run typecheck + build
9. [ ] Create `MIGRATION.md` with initial structure
10. [ ] Modify `bin/pai-lite` — exec `"$root_dir/pai-lite-ts" "$@"` unconditionally
11. [ ] Update `README.md` — add Bun to dependencies section with install command
12. [ ] Update `.gitignore` — node_modules/, pai-lite-ts
13. [ ] **Verify**: `bun run build` compiles, `./pai-lite-ts sessions` prints "not yet migrated", `./pai-lite-ts help` prints usage

### Phase 1: Session Discovery
1. [ ] Create `src/config.ts` — shell out to `yq` for config reading, state path resolution
2. [ ] Create `src/slots/paths.ts` — parse slots.md with regex to extract slot number + path
3. [ ] Create `src/sessions/discover-codex.ts` — find JSONL files, filter by mtime, parse session_meta
4. [ ] Create `src/sessions/discover-claude.ts` — scan project dirs, build index cache, scan JSONLs
5. [ ] Create `src/sessions/discover-tmux.ts` — Bun.$ for tmux list-panes, parse output
6. [ ] Create `src/sessions/discover-ttyd.ts` — Bun.$ for pgrep/ps, extract port and tmux session
7. [ ] Create `src/sessions/enrich.ts` — walk up from cwd to find .peer-sync, read state files
8. [ ] Create `src/sessions/dedup.ts` — group by normalized cwd, keep highest-priority source
9. [ ] Create `src/sessions/classify.ts` — match sessions to slots by longest cwd prefix
10. [ ] Create `src/sessions/report.ts` — generate Markdown report + summary to stdout
11. [ ] Create `src/sessions/index.ts` — wire full pipeline, export handlers for CLI
12. [ ] Wire `sessions` and `sessions report` in `src/index.ts`
13. [ ] **Parity checkpoint**: Run `pai-lite sessions` and `pai-lite sessions report`, compare output to Bash version
14. [ ] Delete `lib/sessions.sh`
15. [ ] Update `MIGRATION.md` if report format changed

### Phase 2: Core Data Model
1. [ ] `bun add yaml` (js-yaml or yaml package for YAML parsing)
2. [ ] Rewrite `src/config.ts` — parse pointer config, resolve full config, provide typed accessors
3. [ ] Create `src/state.ts` — git pull/push/commit/sync via Bun.$
4. [ ] Create `src/slots/types.ts` + `src/slots/markdown.ts` — Markdown block parser with regex
5. [ ] Create `src/slots/index.ts` — all slot operations including adapter dispatch for start/stop
6. [ ] Create `src/tasks/types.ts` + `src/tasks/markdown.ts` — YAML frontmatter parser
7. [ ] Create `src/tasks/sync.ts` — GitHub issues via `gh`, watch path scanning for checkboxes/TODOs
8. [ ] Create `src/tasks/index.ts` — task operations (sync, list, show, create, convert, duplicates, needs-elaboration, queue-elaborations, check, merge)
9. [ ] Create `src/adapters/index.ts` — adapter dispatch for slot start/stop
10. [ ] Wire slot and task commands in `src/index.ts`
11. [ ] **Parity checkpoint for slots**: `pai-lite slots`, `pai-lite slot 1`, `pai-lite slot 1 assign "test" -a manual`
12. [ ] **Parity checkpoint for tasks**: `pai-lite tasks list`, `pai-lite tasks sync`, `pai-lite tasks show <id>`
13. [ ] Delete `lib/slots.sh`, `lib/tasks.sh`, `lib/common.sh`
14. [ ] Update `MIGRATION.md` if any artifact format changed

### Phase 3: CLI Entry Point
1. [ ] Create `src/cli/index.ts` — main router with help/usage text mirroring current output
2. [ ] Create subcommand modules: `slots.ts`, `tasks.ts`, `sessions.ts`, `flow.ts`, `mayor.ts`, `misc.ts`
3. [ ] Stubbed commands (flow, mayor, etc.) print "not yet migrated" and exit 1
4. [ ] Migrate `init`, `doctor`, `status`, `briefing` command routing
5. [ ] Simplify `bin/pai-lite` to a 3-line exec wrapper
6. [ ] **Parity checkpoint**: Run every command from `pai-lite help` — migrated ones work, others print "not yet migrated"

### Phase 4: Remaining Modules
1. [ ] Port flow engine → `src/flow/` (native dependency graph, no tsort/jq)
2. [ ] Port mayor → `src/mayor/` (lifecycle, queue, inbox, briefing)
3. [ ] Port triggers → `src/triggers/` (plist/unit generation)
4. [ ] Port notify → `src/notify/` (ntfy.sh via fetch())
5. [ ] Port dashboard → `src/dashboard/` (JSON gen + Bun.serve())
6. [ ] Port network + federation → `src/network/` + `src/federation/`
7. [ ] Port journal → `src/journal/`
8. [ ] Port doctor → `src/doctor.ts` (add Bun version check)
9. [ ] Port init → `src/init.ts` (install compiled binary instead of shell scripts)
10. [ ] **Parity checkpoint per module**: Run all commands for each module before deleting its Bash source
11. [ ] Delete all remaining `lib/*.sh`, `adapters/*.sh`
12. [ ] Remove `bin/pai-lite` wrapper — compiled binary is the entry point
13. [ ] Update `MIGRATION.md` with complete migration notes

## Risks and Edge Cases

- **Bun.$ subprocess quoting**: Test with paths containing spaces and special characters. Mitigation: use Bun.$'s template literal interpolation which handles quoting.
- **Cross-platform stat**: TS uses `Bun.file().stat()` or `fs.statSync()` — cross-platform by default.
- **tmux not running**: `tmux list-panes` exits non-zero if no server. Catch and return empty array (this is "skip scanner", not "crash").
- **Large JSONL files**: Read only first 20 lines for session metadata (same as Bash). Use `readline` or line-by-line.
- **Concurrent slots.md access**: Use temp-file-then-rename for atomic writes (same pattern as Bash).
- **yq dependency in Phase 1**: Config reading depends on yq until Phase 2 replaces it. Note in MIGRATION.md.
- **CI without secrets**: CI only needs Bun install + typecheck + build — no secrets or state repo access needed.

## Test Strategy

- [ ] **Per-phase parity checkpoints** (detailed above): run migrated commands, verify output matches Bash semantics
- [ ] **CI on every commit**: `bun run typecheck && bun run build` must pass
- [ ] **Session discovery**: Test with real Codex/Claude Code session stores on this machine
- [ ] **Missing optional tools**: Verify tmux/ttyd scanners skip cleanly when tools absent
- [ ] **Empty state**: Test with no sessions, no tasks, empty slots.md
- [ ] **Error paths**: Verify missing config, missing state repo, bad YAML produce clear error messages and exit 1
- [ ] **After Phase 4**: Run every command from `pai-lite help` end-to-end
