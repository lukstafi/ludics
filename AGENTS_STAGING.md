# Agent Learnings (Staging)

This file contains learnings discovered by AI agents during development sessions.
Periodically review and consolidate valuable entries into `CLAUDE.md` or `AGENTS.md`.

---


<!-- Entry: pervasive_session_discovery-claude | 2026-02-10 -->
### Bash brace default expansion bug

In bash, ${var:-{}} is ambiguous — when $var has a value containing braces, the expansion appends an extra }. Use [[ -n "$var" ]] || var="{}" instead.
<!-- End entry -->
<!-- Entry: proposal-slot-assign-task-id-detection-coder | 2026-03-07T21:41:20+0100 -->
### Use OS temp dirs for test harnesses, not repo-local scratch paths

When a Bun test needs a fake HOME or harness tree, allocate it with `mkdtempSync(join(tmpdir(), "..."))` instead of creating `.test-tmp-*` under `src/` or another tracked path. Repo-local scratch directories are easy to commit by accident and can also collide with tracked fixtures during cleanup.
<!-- End entry -->

<!-- Entry: pervasive_session_discovery-claude | 2026-02-10 -->
### Pipe-while subshell trap

In bash, cmd | while read ...; do ... done runs the while body in a subshell. Variable modifications (like accumulating into _SESSIONS_RAW) are lost. Fix: capture output to a variable first, then use while ... done <<< "$var".
<!-- End entry -->

<!-- Entry: pervasive_session_discovery-claude | 2026-02-10 -->
### Claude Code session stores

Claude Code stores session metadata in two places:
- `~/.claude/projects/<encoded-path>/sessions-index.json` — rich metadata (sessionId, fileMtime in ms, projectPath, gitBranch, summary, messageCount, isSidechain). Preferred source.
- `~/.claude/projects/<encoded-path>/<session-id>.jsonl` — fallback. Root entry has `"parentUuid": null` with `cwd` and `sessionId`.

Codex stores sessions in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (date-organized layout, NOT flat). First line is `{"type":"session_meta","payload":{...}}`.
<!-- End entry -->

<!-- Entry: pervasive_session_discovery-claude | 2026-02-10 -->
### Slot Path field for session classification

Adding an explicit `**Path:**` field to the slot block format makes slot-to-directory mapping first-class. This is cleaner than inferring paths from Git "Working directory:" lines or Session field guessing. Use with `slot assign --path /abs/path`.
<!-- End entry -->

<!-- Entry: skill-context-isolation-coder | 2026-02-27 -->
### Claude Code skill frontmatter for context isolation

Claude Code skills support `context: fork` to run as isolated subagents (since Claude Code 2.1). Combined with `user-invocable: false`, worker skills stay hidden from the user's `/` menu while remaining invocable by Claude. Key constraints:
- Forked skills do NOT have access to the parent's conversation history — only `SKILL.md` content + `$ARGUMENTS` + `CLAUDE.md`
- `$ARGUMENTS` is the full argument string; use `$ARGUMENTS[N]` or `$N` for positional access in the skill markdown content, but do NOT use `$0`/`$1` inside bash code blocks — those resolve to the shell script name in bash context
- `allowed-tools` restricts what the forked subagent can use
- Environment variables (like `$LUDICS_STATE_PATH`) propagate to forked subagents
- The subagent's final text response is returned to the parent — keep it structured for parsing
<!-- End entry -->
<!-- Entry: skill-context-isolation-followup-coder | 2026-02-27T22:33:43+0100 -->
### Skill file conventions: worker-conventions.md and context brief pattern

- Worker skill files reference `skills/worker-conventions.md` for shared boilerplate (argument parsing, structured response format, error handling). When adding a new worker, follow this pattern rather than duplicating conventions inline.
- Judgment-heavy orchestrators (draft-proposal, elaborate, verify-completion) pass a `<context_brief>` as a third positional argument to their workers. The brief is free-form text composed by the orchestrator from Mag's conversation history. Context-free workers (feedback-digest) do not receive a brief.
- When a skill's orchestrator adds no strategic value (no proceed/bail/split decision, no notification routing), use `context: fork` directly on the skill instead of an orchestrator/worker split. sync-learnings is the current example of this "direct fork" pattern.
- The `bun run typecheck` command requires bun type definitions installed; it may fail in fresh clones without `bun install` first.

<!-- End entry -->
<!-- Entry: gh-ludics-21-coder | 2026-03-05T16:40:59+0100 -->
### Verify Proposal Against Current Code First

For proposal-driven tasks, run a quick `rg` sweep before editing because proposals may reference code that is already removed on the working branch. In this task, a proposed `src/notify.ts` deletion target was already absent, so pre-checking avoided unnecessary churn.

### Install Dependencies Before Typecheck

`bun run typecheck` depends on local `typescript` from `devDependencies`. If dependencies are not installed yet, the command fails with `Script not found "tsc"`; run `bun install` first in fresh worktrees.

<!-- End entry -->
<!-- Entry: gh-ludics-30-coder | 2026-03-05T18:48:08+0100 -->
### Fresh Worktree Preflight: Install Bun Dependencies First

In fresh worktrees, run bun install before bun run typecheck or bun run build. Without installed dependencies, typecheck can fail with Script not found "tsc", which can look like a config issue but is just missing local deps.

<!-- End entry -->
<!-- Entry: gh-ludics-30-followup-coder | 2026-03-05T19:36:15+0100 -->
### Smoke Test Precondition and Pipefail Gotcha

- `tests/test.sh` expects `bin/ludics` to exist; run `bun run build` before smoke tests in a fresh checkout.
- The smoke checks using `echo "$output" | grep -q ...` can produce false negatives under `set -o pipefail`, because `grep -q` exits early and upstream `echo` can fail with SIGPIPE. If output appears contradictory, validate command and grep exit codes separately.

<!-- End entry -->
