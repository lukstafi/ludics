# Proposal: CI lint for worker/orchestrator response contract field drift

**Task**: task-b0df15b2
**Project**: ludics

## Goal

Add an automated CI check that detects field name mismatches between worker skill files' "Response Contract" sections and their paired orchestrator skill files' "Expected Worker Fields" sections, preventing silent contract drift.

## Acceptance Criteria

1. A new script `scripts/lint-contracts.ts` discovers worker/orchestrator pairs by globbing `skills/ludics-*-worker.md` and deriving the orchestrator path (remove `-worker` suffix).
2. For each pair, the script extracts backtick-quoted field names from numbered list items under `### Response Contract` (worker) and `### Expected Worker Fields` (orchestrator) headings.
3. Fields present in one side but not the other are reported as **errors** (exit 1).
4. Unpaired files (worker exists but orchestrator missing, or vice versa) produce **warnings** (non-fatal, exit 0).
5. Missing sections in an otherwise paired file produce a **warning** (not an error), since new skills may be added incrementally.
6. A `lint:contracts` script entry is added to `package.json`.
7. A CI step "Lint contract field drift" running `bun run lint:contracts` is added to `.github/workflows/ci.yml`.
8. The script passes cleanly on the current skill files with no false positives.

## Context

- **Motivation**: Retrospective from gh-ludics-137 identified that response contract fields can silently drift between worker and orchestrator skill docs, causing runtime errors when orchestrators expect fields workers no longer emit.
- **Precedent**: `scripts/lint-cli-readme.ts` follows the same pattern (parse two sources, compare, report drift). The new script mirrors its structure: read files, extract sets, compare, report.
- **CI integration**: `.github/workflows/ci.yml` already runs `bun run lint:cli-readme` as the last step; the new step appends after it.
- **Pairs discovered at runtime**: The script globs `skills/ludics-*-worker.md` and computes the orchestrator name. Only top-level `skills/*.md` files are considered (not `skills/orchestration/` subdirectory).
- **Field extraction regex**: `/^\d+\.\s+`(\w+)`/` applied to lines under the relevant heading until the next heading or EOF.
- **Current pairs** (5): elaborate, draft-proposal, revise-proposal, verify-completion, feedback-digest.
