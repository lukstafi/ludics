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

## Proposed Change

### Mechanism: `context: fork` skill frontmatter

Claude Code supports a `context: fork` frontmatter field for skills
([docs](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)).
When set, the skill runs as an isolated subagent while remaining discoverable
as a normal `/skill-name` command. The subagent gets its own context window;
its internal tool outputs do not pollute the parent conversation. Only the
subagent's final response is returned to Mag.

```yaml
---
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Edit, Write
---
```

The key insight: we don't need a separate delegation mechanism — a forked
skill *is* a subagent with full skill discoverability.

Important constraint from the docs: the forked subagent does **not** have
access to the parent's conversation history. The skill content + `$ARGUMENTS`
is all it receives (plus CLAUDE.md). Heavy skills must receive everything
they need via arguments.

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

### Briefing: keep inline

The briefing skill is the heaviest (220 lines) but also the most strategic —
it needs Mag's cross-task context for slot assignment decisions and ambiguity
surfacing. Forking it would cut it off from that strategic memory.

Keep briefing inline. Its sub-operations (elaboration, nudge notifications)
already run via Task tool or will become forked skills themselves (e.g.,
`/ludics-elaborate` with `context: fork`), so the briefing's own context
footprint shrinks naturally as its callees get forked.

### Approach A: Fork the skill directly

Add `context: fork` frontmatter to each heavy skill. The skill itself
becomes the subagent — no new files needed:

```yaml
---
name: ludics-draft-proposal
description: Write proposal document, send launch buttons
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write
---
```

When Mag invokes `/ludics-draft-proposal`, Claude Code automatically:
1. Spawns an isolated subagent with the skill markdown as its prompt
2. Passes `$ARGUMENTS` to the subagent
3. Runs all tool calls inside the subagent's context window
4. Returns only the subagent's final response to Mag

**Pros:** Minimal change — just add frontmatter, no new files, skill
discoverability unchanged.

**Cons:** Since skills are triggered by external automation (the queue),
Mag has no opportunity to interpret the task or adapt the skill's behavior
before execution. The forked subagent runs blind — no access to Mag's
conversation history, recent decisions, or cross-task awareness — and Mag
receives a result it had no input on. Any strategic context must be
serialized into `$ARGUMENTS` by the queue, which has far less judgment
than Mag.

### Approach B: Split into skill + subagent

Each heavy skill becomes two files — a thin orchestrator skill that stays
inline in Mag's context, and a worker subagent that runs forked:

```
skills/
├── ludics-draft-proposal.md          # Orchestrator (inline in Mag)
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

**Pros:** Compensates for queue-triggered invocation: even though the queue
decides *what* to run, Mag's inline orchestrator decides *how* — interpreting
the task with full conversation history, deciding whether to proceed or bail,
and tailoring the worker's instructions. Only the heavy codebase exploration
is isolated.

**Cons:** Doubles the number of files for heavy skills. The orchestrator
still adds some context weight (though much less than the full skill).
Requires the orchestrator to craft a good Task tool prompt for each
invocation.

### Common to both approaches

**What changes in each skill:**
- Ensure the forked portion's final output is a structured summary that
  Mag can act on (proposal path, ambiguities found, verdict, etc.)

**What stays the same:**
- How skills are installed to `.claude/commands/`
- How Mag invokes skills (via `/skill-name`)
- Skill discoverability in Claude Code's command palette

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
- Isolate 6 heavy skills via `context: fork` (Approach A or B, TBD)
- Keep briefing inline (benefits from Mag's strategic context)
- Keep 8 light skills unchanged
- Validate `context: fork` behavior with installed skills
- Ensure forked skills return structured summaries Mag can act on
- Update ARCHITECTURE.md to document the chosen pattern

**Out of scope:**
- Changing the Mag lifecycle or queue mechanism
- Modifying the stop hook or keepalive
- Adding new skills
- Changing the skill installation process in `init.ts`

## Dependencies

- `context: fork` is supported since Claude Code 2.1 (Jan 2026). Needs
  validation that it works for skills installed in `.claude/commands/`
  (project-level, not just global `~/.claude/commands/`)
- The subagent must be able to run CLI tools (`ludics notify`, `ludics slot`,
  etc.) — verify this works from a forked context
