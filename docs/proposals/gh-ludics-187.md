# Proposal: Journal merge conflict timestamp sorting

**Task:** gh-ludics-187 — Journal files get git merge conflicts from concurrent federation node writes
**Date:** 2026-04-05

## Goal

After `resolveAppendOnly` merges conflicting journal markdown files from two federation nodes, entries should appear in chronological order (sorted by their `HH:MM:SS` timestamp) rather than in arbitrary upstream-first/local-second order.

## Acceptance Criteria

1. When `resolveAppendOnly` processes a `.md` journal file, the merged output has all `- **HH:MM:SS** ...` lines sorted chronologically by their embedded timestamp.
2. The header line (`# Journal YYYY-MM-DD`) remains pinned as the first line and is not affected by sorting.
3. Blank lines or non-timestamped lines (if any) are preserved at the end of the sorted block.
4. Existing JSONL epoch-sort behavior is unchanged.
5. Deduplication (exact-line match) continues to work as before.

## Context

- `src/state.ts` line 401: `resolveAppendOnly()` already deduplicates lines from both upstream and local versions during rebase conflict resolution.
- `src/state.ts` lines 375-377: daily journal `.md` files are routed through `resolveAppendOnly`.
- `src/journal.ts` line 30-31: entries are written as `- **HH:MM:SS** [category] message` where `HH:MM:SS` is `new Date().toTimeString().slice(0, 8)`.
- JSONL files already get epoch-sorted (lines 418-427); markdown entries need analogous treatment using their inline timestamps.

## Approach

Add an `else if (file.endsWith(".md"))` branch in `resolveAppendOnly` (after the existing JSONL sort block) that:

1. Separates the header line(s) — any line starting with `#` or blank lines before the first `- **` entry.
2. Sorts the remaining `- **HH:MM:SS**` lines lexicographically by the `HH:MM:SS` portion (lexicographic sort is correct for zero-padded 24h time).
3. Reassembles: header lines first, then sorted entry lines.

The timestamp regex: `/^- \*\*(\d{2}:\d{2}:\d{2})\*\*/`. Lines not matching this pattern are appended after sorted lines (defensive handling).

Estimated change: ~10 lines added to `resolveAppendOnly` in `src/state.ts`.
