# Workflow Patterns

This file contains learned workflow patterns for common ludics operations.

## Task Elaboration

When elaborating a task from a high-level description to detailed spec:

1. **Read the task file and linked GitHub issue**
   - Understand the goal and acceptance criteria
   - Note any constraints or preferences mentioned

2. **Check related tasks for context**
   - Read blocking/blocked-by tasks
   - Understand where this fits in the larger picture

3. **Identify specific files to modify**
   - Use grep/glob to find relevant code
   - Note entry points and key functions

4. **Break into subtasks with acceptance criteria**
   - Each subtask should be independently testable
   - Include edge cases in criteria

5. **Add implementation hints**
   - Code pointers (file:line)
   - Similar existing implementations
   - Potential gotchas

---

## Issue Analysis

When analyzing a GitHub issue to create a task:

1. **Assess actionability**
   - Is this a bug, feature, or discussion?
   - Is there enough information to act?
   - Does it need clarification first?

2. **Extract dependencies**
   - What existing tasks does this relate to?
   - What must be done first?
   - What does this unblock?

3. **Infer priority**
   - Check labels and milestone
   - Consider user impact
   - Consider technical urgency

4. **Create task with context**
   - Link back to issue
   - Summarize in your own words
   - Add technical notes

---

## Morning Briefing

When generating a morning briefing:

1. **Current state**
   - What's running in slots?
   - What phase are active tasks in?

2. **Ready queue**
   - Priority-sorted tasks with empty blocked_by
   - Highlight A-priority items

3. **Urgent items**
   - Deadlines within 7 days
   - Blocked high-priority tasks

4. **Suggestion**
   - What to work on and why
   - Consider context switching cost
   - Note alternatives

---

## PR Review Checklist

When reviewing or creating a PR:

- [ ] Tests pass
- [ ] No new warnings
- [ ] Documentation updated if needed
- [ ] Commit messages follow convention
- [ ] No accidental file inclusions
- [ ] Changes match the task description

---

## Slot Assignment

When assigning a task to a slot:

1. **Check task readiness**
   - blocked_by must be empty
   - Task must have clear acceptance criteria

2. **Choose adapter**
   - Complex tasks: agent-duo (two agents)
   - Medium tasks: agent-claude (single agent)
   - Simple tasks: manual or agent-claude

3. **Set up context**
   - Ensure working directory is correct
   - Create worktree if needed
   - Note any special setup

4. **Update slot state**
   - Record task assignment
   - Set started timestamp
   - Add initial runtime notes

---

## Add New Workflows

*When a new workflow pattern emerges, document it following the patterns above.*
