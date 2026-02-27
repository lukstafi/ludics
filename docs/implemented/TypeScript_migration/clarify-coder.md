# Coder's Proposed Approach

## High-Level Approach

I'll implement **Phase 0 (Scaffold) + Phase 1 (Session Discovery)** as described in `TypeScript-migration.md`, each as a separate commit. Phase 0 sets up Bun + TypeScript tooling (`bun init`, `tsconfig.json`, `src/` directory) and modifies `bin/pai-lite` to dispatch `sessions` commands to the compiled TS binary while falling through to Bash for everything else. Phase 1 ports the 27KB `lib/sessions.sh` into typed TypeScript modules: four scanner modules (Codex, Claude Code, tmux, ttyd), `.peer-sync` enrichment, deduplication/classification, and JSON+Markdown output formatters. I'll preserve all the validated design decisions (longest-prefix matching, stale filtering, deduplication ranking, classified/unclassified grouping) and use `Bun.$` for subprocess calls (tmux, pgrep). The suggested types in the migration doc are a good starting skeleton.

## Questions for the User

1. Bun is not installed on this machine. Should I install it (e.g., `curl -fsSL https://bun.sh/install | bash`), or do you want to handle that separately?
2. Should this task cover only Phase 0 + Phase 1, or do you want me to go further into Phase 2 (Core Data Model)?
3. For the Bash wrapper dispatch: should `bin/pai-lite` detect whether the TS binary exists and silently fall back to Bash `sessions.sh` if it doesn't (for graceful degradation), or should it require the TS binary and fail loudly?
