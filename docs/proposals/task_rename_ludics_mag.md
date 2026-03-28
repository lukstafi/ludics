# Rename pai-lite to ludics; Mayor to Mag

## Context

Rename the project from "pai-lite" to "ludics" and the coordinator role from "Mayor" to "Mag" everywhere. Motivation: "pai-lite" is generic and inaccurate as the project has grown beyond a lightweight personal AI tool. "Ludics" draws from both Girard's proof-theoretic framework (computation as interaction) and Hesse's "Glass Bead Game" (Glasperlenspiel) — the synthesis of disciplines into unified play. "Mag" (short for Magister Ludi, master of the game) replaces the "Mayor" role name, treated as a proper noun (i.e.mm name) rather than a title.

## Acceptance Criteria

- [ ] Binary renamed: `pai-lite` → `ludics` (Bun compile output, install path)
- [ ] TypeScript source: all internal references updated (`pai-lite` → `ludics`, `pai_lite` → `ludics`, `PAI_LITE` → `LUDICS`)
- [ ] Skills directory: `pai-*` skill files renamed (e.g., `pai-briefing.md` → `ludics-briefing.md` or similar convention)
- [ ] Skill invocation names updated in skill files and CLAUDE.md references
- [ ] Config paths: `~/.local/pai-lite/` → `~/.local/ludics/` (or chosen path)
- [ ] Environment variables: `$PAI_LITE_STATE_PATH`, `$PAI_LITE_REQUEST_ID`, `$PAI_LITE_RESULTS_DIR` → `$LUDICS_*`
- [ ] Stop hook script: `~/.local/bin/pai-lite-on-stop` → `ludics-on-stop` (or equivalent)
- [ ] Harness CLAUDE.md updated (references to pai-lite, Mayor skills, CLI commands)
- [ ] Harness task IDs: existing `gh-pai-lite-*` tasks noted (historical, may keep as-is)
- [ ] Memory files: update references in MEMORY.md and topic files
- [ ] GitHub repo renamed (or new repo created) if applicable
- [ ] README, MIGRATION.md, docs updated
- [ ] Legacy Bash `lib/*.sh` files: update references (or remove if fully superseded)
- [ ] Bash adapters (`adapters/*.sh`): update sourced paths and variable names
- [ ] `package.json` name field updated
- [ ] Notify command updated: `ludics notify` instead of `pai-lite notify`
- [ ] Mayor → Mag: rename `mayor` subcommand to `mag` (e.g., `ludics mag briefing`)
- [ ] Mayor → Mag: rename `mayor/` directory in harness to `mag/` (queue, inbox, results, context, memory)
- [ ] Mayor → Mag: update all TypeScript references (`mayor` → `mag`, `MAYOR` → `MAG`)
- [ ] Mayor → Mag: update config.yaml keys (`mayor:` section → `mag:`)
- [ ] Mayor → Mag: update session name (`pai-mayor` → `ludics-mag` or similar)
- [ ] Mayor → Mag: update skill file content (references to "Mayor" role → "Mag")
- [ ] Mayor → Mag: update CLAUDE.md "For Mayor Sessions" → "For Mag Sessions"

## Implementation Plan

### Phase 1: Core rename (pai-lite → ludics)
- Rename binary output and install targets
- Update all TypeScript `src/**/*.ts` references
- Update `package.json`
- Update environment variable names (with backward-compat shim if needed)

### Phase 2: Role rename (Mayor → Mag)
- Rename `mayor` subcommand to `mag` in CLI entry point
- Rename `mayor.ts` → `mag.ts` (or update internal references)
- Rename harness `mayor/` directory to `mag/`
- Update config.yaml schema (`mayor:` → `mag:`)
- Update session name constant (`pai-mayor` → `ludics-mag`)

### Phase 3: Skills and config
- Rename skill files (`pai-*` → `ludics-*` or chosen convention)
- Update skill content (slash command names, env var references, "Mayor" → "Mag")
- Update config paths and defaults

### Phase 4: Harness and docs
- Update harness CLAUDE.md, memory files
- Update README, MIGRATION.md, other docs
- Update stop hook and other shell integration scripts

### Phase 5: Cleanup
- Remove backward-compat shims if used
- Update GitHub repo name/description if applicable
- Verify all `grep -r pai-lite` / `grep -r pai_lite` / `grep -r PAI_LITE` / `grep -r mayor` (in project context) return zero hits

## Notes

- Existing task IDs like `gh-pai-lite-9` are historical identifiers — renaming them would break merge history. Keep as-is.
- Consider a brief backward-compat period where `pai-lite` symlinks to `ludics`.
