# Proposal: Skill Context Isolation via Subagent Forking

## Motivation

Mag is a persistent, long-running Claude Code session. Every skill invocation
injects the full skill markdown plus all tool outputs (file reads, git logs,
codebase exploration) into Mag's conversation context. Over a typical day — a
briefing, several elaborations, a couple of proposals, health checks — this
accumulates significantly and pushes out Mag's strategic memory: cross-task
awareness, user preferences, prior decisions, and institutional knowledge.

The heaviest skills are exactly the ones that do deep codebase inspection:
- `/ludics-draft-proposal` (150 lines + codebase reads across a project)
- `/ludics-verify-completion` (130 lines + git log + source file reads)
- `/ludics-elaborate` (132 lines + dependency/codebase reads)
- `/ludics-briefing` (220 lines + inline elaboration via Task tool)
- `/ludics-techdebt` (164 lines + codebase scanning via Haiku subagent)

Meanwhile, lighter skills like `/ludics-launch-session`, `/ludics-read-inbox`,
and `/ludics-health-check` are mostly CLI commands with minimal codebase reads.

## Current State

All 16 skills are flat markdown files in `skills/`. None use Claude Code's
`context: fork` or `agent:` frontmatter. Some already mention delegation via
the Task tool (Haiku/Sonnet subagents), but the orchestration logic and all
tool outputs still land in Mag's main context.

Claude Code supports skill frontmatter for context isolation:
```yaml
---
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Edit, Write
---
```

When `context: fork` is set, the skill's markdown becomes the prompt for an
isolated subagent. The subagent gets its own context window; its internal tool
outputs do not pollute the parent conversation. Only the subagent's final
response is returned to Mag.

## Proposed Change

### Classify skills by context weight

**Heavy skills** (fork candidates) — do significant codebase exploration:
- `/ludics-draft-proposal` — reads project source, writes proposal doc
- `/ludics-verify-completion` — deep codebase inspection for completion evidence
- `/ludics-elaborate` — reads dependencies, codebase, writes detailed spec
- `/ludics-techdebt` — scans codebase for debt patterns
- `/ludics-feedback-digest` — reads PR comments, issue threads
- `/ludics-sync-learnings` — reads and consolidates memory files

**Light skills** (keep inline) — mostly CLI commands, minimal reads:
- `/ludics-briefing` — special case, see below
- `/ludics-launch-session` — slot lookup + adapter start
- `/ludics-health-check` — reads slots.md, queues verifications
- `/ludics-read-inbox` — processes message queue
- `/ludics-suggest` — reads flow state, suggests tasks
- `/ludics-preempt` — slot stash/reassign
- `/ludics-learn` — updates memory files (small, targeted)
- `/ludics-split-task` — reads task file, creates subtasks
- `/ludics-new-quote` — trivial

### Briefing: hybrid approach

The briefing skill is the heaviest (220 lines) but also the most strategic —
it needs Mag's cross-task context for slot assignment decisions and ambiguity
surfacing. Rather than forking the entire briefing, keep the orchestration
inline but ensure its sub-operations (elaboration, nudge notifications) run
via forked subagents or Task tool.

The briefing already delegates elaboration via the Task tool (step 3). The
remaining heavy operations (codebase reads for slot assignment reasoning) are
inherently strategic and benefit from Mag's accumulated context.

### Refactoring pattern for heavy skills

Each heavy skill becomes two files:

```
skills/
├── ludics-draft-proposal.md          # Orchestrator (small, inline in Mag)
└── ludics-draft-proposal-worker.md   # Worker (forked subagent)
```

**Orchestrator** (stays in Mag's context):
```yaml
---
name: ludics-draft-proposal
description: Write proposal document, send launch buttons
---
```
- Read task file (small, needed for Mag's awareness)
- Decide whether to proceed, bail out, or split
- Invoke the worker via Task tool with specific instructions
- Interpret worker result
- Send notifications, update frontmatter, commit

**Worker** (forked, isolated context):
```yaml
---
name: ludics-draft-proposal-worker
description: Explore codebase and write proposal document
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write
---
```
- Receives: task ID, project path, task content, acceptance criteria
- Does: codebase exploration, reads source files, checks patterns
- Writes: proposal document to `docs/<feature>.md`
- Returns: proposal path, ambiguities found, summary

### Alternative: Task tool delegation without skill splitting

Instead of creating separate worker skill files, heavy skills could delegate
their codebase-heavy steps via the Task tool directly:

```markdown
## Process

3. **Explore codebase** (via Task tool):
   Use the Task tool to spawn a subagent that reads the project codebase,
   checks relevant source files, and returns a structured summary. Pass:
   - Project path
   - Files to check (from task elaboration)
   - What to look for (acceptance criteria, proposed changes)
```

This is simpler (no new files) but less structured — the Task tool prompt
must be carefully crafted each time.

### Validation needed

Before implementing, verify:
1. `context: fork` works correctly for skills installed in
   `.claude/commands/` (not just `~/.claude/commands/`)
2. Forked subagents can access the project filesystem (they should, since
   they run in the same working directory)
3. The subagent's final response is returned to Mag in a usable form
   (not just a summary — Mag needs to parse specific fields like
   proposal path, ambiguities list, verdict)
4. Whether `allowed-tools` properly restricts the subagent's capabilities
5. How `$ARGUMENTS` and environment variables are passed to forked skills

## Scope

**In scope:**
- Refactor 6 heavy skills to use context isolation
- Keep briefing as hybrid (inline orchestration + forked sub-operations)
- Keep 9 light skills unchanged
- Validate `context: fork` behavior with installed skills
- Update ARCHITECTURE.md to document the pattern

**Out of scope:**
- Changing the Mag lifecycle or queue mechanism
- Modifying the stop hook or keepalive
- Adding new skills
- Changing the skill installation process in `init.ts`

## Dependencies

- Claude Code must support `context: fork` for project-level custom commands
  (`.claude/commands/` in a repo, not just global `~/.claude/commands/`)
- The subagent must be able to run CLI tools (`ludics notify`, `ludics slot`,
  etc.) — verify this works from a forked context
