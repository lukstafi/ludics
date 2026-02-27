# TypeScript Migration Plan

*Decision document, 2026-02-10.*

## Why Migrate

pai-lite is a Bash codebase that increasingly processes structured data (JSONL, JSON,
Markdown) and serves a web dashboard. The session discovery feature made the mismatch
visible: both agent implementations struggled with Bash+jq for what would be
straightforward operations in a language with native JSON support.

**What Bash is good at here:** launching tmux sessions, running git commands, invoking
`agent-duo start`, managing launchd plists, piping commands together.

**What Bash is bad at here:** parsing JSONL session stores, manipulating slot blocks in
Markdown, generating reports, deduplication/classification pipelines, the dashboard server,
complex data structures (the `PAI_LITE_SLOTS` array with tab-separated records and
`cut -f3` field extraction).

## Choice: TypeScript with Bun

**TypeScript over Python:** JSON is the native data format. Same language for the
dashboard frontend and backend. Strong typing catches schema variation bugs at compile time
(e.g., a field that might be a string or number). The Codex SDK is TypeScript.

**TypeScript over Elixir:** Elixir's supervision trees are a great fit for the long-running
daemon direction, but the added deployment complexity and niche ecosystem make it overkill
for a personal tool.

**Bun over Node/Deno:** Fast startup (~6ms), built-in TypeScript support (no build step for
development), `Bun.$` shell integration for ergonomic subprocess calls, `bun build --compile`
produces a self-contained binary with zero runtime dependency.

## Migration Stages

Prepare each stage as a separate commit.

### Phase 0: Scaffold

- Add `bun init`, `tsconfig.json`, `src/` directory alongside existing `lib/`
- `bun build --compile` producing a `pai-lite-ts` binary
- Thin Bash wrapper: `bin/pai-lite` dispatches migrated commands to the TS binary,
  falls through to Bash for the rest
- CI: add Bun + TypeScript linting

### Phase 1: Session Discovery (first TS module)

The natural first target — it's JSON-heavy and benefits most from the migration.

- Types: `Session`, `MergedSession`, `Slot`, `SlotPath`, `DiscoveryResult`
- Scanner modules: Codex, Claude Code, tmux, ttyd
- `.peer-sync` enrichment
- Deduplication and slot classification
- Both JSON and Markdown output
- CLI: `pai-lite sessions`, `pai-lite sessions refresh`, `pai-lite sessions show`

### Phase 2: Core Data Model

- Slot and task types with Markdown serialization/deserialization
- Replace fragile `slot_get_field` / awk parsing with a proper Markdown parser
- State repo interaction (git via `Bun.$`)

### Phase 3: CLI Entry Point

- Replace the giant `case` statement with Commander.js or similar
- Each subcommand as a module
- Bash `bin/pai-lite` wrapper goes away

### Phase 4: Remaining Modules

- Triggers, flow engine, Mayor queue, notify
- Dashboard backend shares types with frontend

## Data Format Discoveries (from PR research)

Both PRs investigated the actual file formats. These findings should inform the TS types.

### Codex Session Store

- **Location:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
  (nested date layout, NOT flat)
- **First line format:** `{"type":"session_meta","payload":{"id":...,"cwd":...,"source":...}}`
- **Source kinds:** `cli`, `vscode`, `exec`, `appServer`
- **Archived sessions:** `$CODEX_HOME/archived_sessions/`
- **Fallback:** If `session_meta` isn't the first line, scan the first ~20 lines for any
  entry containing `cwd`, `workdir`, or `workingDirectory`

### Claude Code Session Store

- **Location:** `~/.claude/projects/<encoded-path>/`
- **Preferred source:** `sessions-index.json` — contains an `entries[]` array with:
  `sessionId`, `fileMtime` (milliseconds!), `projectPath`, `gitBranch`, `summary`,
  `messageCount`, `isSidechain`. Also has a top-level `originalPath`.
- **Fallback:** `<session-id>.jsonl` files. Root entry has `parentUuid: null` with `cwd`
  and `sessionId`.
- **Timestamp caveat:** `fileMtime` is in milliseconds epoch (>1e12). Must divide by 1000
  to get seconds.

### tmux Sessions

- **Best approach:** `tmux list-panes -a -F '#{session_name}|#{pane_active}|#{pane_current_path}'`
  — picks the active pane's path for multi-pane sessions.
- **Last activity:** `tmux list-sessions -F '#{session_name}|#{session_last_attached}'`

### ttyd Processes

- **Discovery:** `pgrep -a ttyd` (or `ps -ax -o pid=,command=` fallback)
- **Port:** extract from `-p <port>` or `--port <port>` in command line
- **tmux link:** extract from `tmux attach -t <name>` in command line

### .peer-sync Enrichment

- Walk up from session `cwd` to find `.peer-sync/` directory
- Read state files: `mode`, `feature`, `phase`, `round` (plain text, one value each)
- Orchestration type: `agent-duo` (default) or `agent-solo` (when mode=solo)

## Design Decisions to Preserve

These decisions were validated through the agent-duo review process (6+ rounds).

1. **`**Path:**` slot field** — explicit slot-to-directory mapping, cleaner than inferring
   from Git sections. Use with `slot assign --path /abs/path`.

2. **Longest-prefix cwd matching** for slot classification — a session belongs to the slot
   whose path is the longest prefix of the session's cwd.

3. **Deduplication by normalized cwd** — when multiple sources report the same directory,
   agent stores (Codex, Claude Code) rank higher than terminal sources (tmux, ttyd).

4. **Stale threshold filtering** — skip files older than the threshold (default 24h) before
   parsing, to avoid scanning historical sessions.

5. **Atomic writes** — temp file + rename to prevent partial reads.

6. **Classified vs Unclassified** grouping — the report separates sessions matched to slots
   from those that need Mayor attention.

7. **Briefing skill integration** — Mayor explicitly runs `pai-lite sessions report` during
   briefing and pays attention to unclassified sessions.

## Suggested TypeScript Types

This is just for inspiration.

```typescript
interface DiscoveredSession {
  source: "codex" | "claude" | "tmux" | "ttyd";
  agent: "codex" | "claude-code" | "terminal";
  id: string;
  cwd: string;
  cwdNormalized: string;
  lastActivityEpoch: number;
  stale: boolean;
  meta: Record<string, unknown>;
}

interface Orchestration {
  type: "agent-duo" | "agent-solo";
  mode: string;
  feature: string;
  phase: string;
  round: string;
  peerSyncPath: string;
}

interface MergedSession {
  cwd: string;
  cwdNormalized: string;
  sources: string[];
  agents: string[];
  ids: string[];
  details: Record<string, unknown[]>;
  lastActivityEpoch: number;
  lastActivity: string; // ISO timestamp
  stale: boolean;
  slot: number | null;
  slotPath: string | null;
  orchestration: Orchestration | null;
}

interface DiscoveryResult {
  generatedAt: string;
  staleAfterHours: number;
  sources: Record<string, number>;
  slots: Array<{ slot: number; path: string }>;
  sessions: MergedSession[];
  unassigned: MergedSession[];
}
```
