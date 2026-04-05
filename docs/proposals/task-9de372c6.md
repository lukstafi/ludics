# Proposal: Per-agent threadId for tmux captures

**Task:** task-9de372c6
**Project:** ludics
**Date:** 2026-04-05

## Goal

Make retrospective threadIds unique per agent in the tmux capture fallback path, so that downstream consumers grouping or filtering by threadId do not conflate data from different agents.

## Acceptance Criteria

1. In `src/retrospective.ts`, the `allThreads` entry for each tmux-captured agent uses `threadId: \`tmux-capture-${agentName}\`` instead of the hardcoded `"tmux-capture"`.
2. In `src/retrospective.ts`, every `allTurns` entry for each tmux-captured agent uses the same per-agent threadId (`tmux-capture-${agentName}`).
3. No other code paths are affected; existing retrospective tests continue to pass.
4. Retrospective JSON output for multi-agent tmux sessions contains distinct threadIds per agent.

## Context

The tmux capture fallback in `src/retrospective.ts` (lines 529-550) iterates over `agentCaptures` grouped by `agentName`, but assigns the identical literal `"tmux-capture"` as `threadId` for every agent's thread and turn entries. While no current consumer groups by threadId alone, this makes the data model semantically incorrect and risks future conflation bugs.

## Approach

Change two lines in `src/retrospective.ts`:

- **Line 531:** `threadId: "tmux-capture"` to `threadId: \`tmux-capture-${agentName}\``
- **Line 542:** `threadId: "tmux-capture"` to `threadId: \`tmux-capture-${agentName}\``

No new tests required -- the existing test suite (`retrospective.test.ts`) does not cover the tmux capture path and the change is mechanical.
