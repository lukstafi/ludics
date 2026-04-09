# Proposal: Avoid wide markdown tables in plan skill templates

**Task:** gh-ludics-204
**Date:** 2026-04-09

## Goal

Prevent agents from producing wide markdown tables in plan files, which get truncated when passed between agents via `{{PEER_PLAN}}` template substitution. Add formatting guidance to the three plan-writing skill templates so agents default to numbered lists for structured data.

## Acceptance Criteria

- [ ] `pair-coder-plan.md` contains a formatting note instructing agents to use numbered lists instead of wide markdown tables
- [ ] `pair-reviewer-plan.md` contains the same formatting note
- [ ] `pair-coder-plan-merge.md` contains the same formatting note
- [ ] The guidance is placed near the "Be concrete" instruction line so it reads naturally alongside existing formatting advice
- [ ] No other files are modified

## Context

In gh-ludics-137, 3 of 4 plan-merge rounds were wasted because wide markdown tables appeared truncated in agent-to-agent context passing. The content was complete on disk (verified via `readFileIfExists()` in `skills.ts`), but the LLM context window rendered wide tables poorly, causing agents to perceive missing content. Switching to numbered lists resolved the issue immediately.

This is a prompt-level fix (advisory, not programmatic). The three template files are each 15-20 lines, so the change is a single line addition per file.

## Approach

Add the following line to each of the three template files, immediately before the existing "Be concrete" or "Pick the strongest approach" instruction:

> **Formatting**: Use numbered lists for structured data in your plan. Do not use wide markdown tables — they get truncated when passed between agents.

For `pair-coder-plan-merge.md`, place the note before the "Pick the strongest approach" line since that file has no "Be concrete" line.
