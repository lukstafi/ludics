# Stable code references in proposals and elaborations

## Goal

Proposals and elaborations contain specific line numbers (e.g., "line 523", "lines 532-557") that drift as other PRs merge before agents begin implementation. Four retrospectives identified this as a recurring source of confusion and wasted effort. The fix is convention-based: update the templates that guide elaboration and proposal writing to reference functions, types, and symbols instead of line numbers.

GitHub issue: https://github.com/lukstafi/ludics/issues/243

## Acceptance Criteria

1. The elaborate-worker template instructs agents to reference code by function/type/symbol name, not by line number.
2. The draft-proposal-worker template includes explicit guidance that code pointers in the Context section should use stable references (function names, type names, section headers) rather than line numbers.
3. The revise-proposal-worker template, when correcting "outdated API references," also covers line-number drift as something to fix during revision.
4. Templates provide guidance for cases where line-level precision is genuinely needed: use a distinctive code snippet or nearby function/symbol boundary rather than a raw line number.

## Context

The templates that shape how agents write elaborations and proposals live in `skills/`:

- **`skills/ludics-elaborate-worker.md`** -- The Tentative Design template example at the "Code Pointers" subsection says `[relevant files and functions with line numbers]`. This directly encourages the fragile pattern.
- **`skills/ludics-draft-proposal-worker.md`** -- The Context section guidance says "Key files and code pointers (saves agent grep time)" but gives no guidance on what form those pointers should take. Agents default to line numbers because it feels precise.
- **`skills/ludics-revise-proposal-worker.md`** -- Lists "wrong file paths, outdated API references" as things to correct during revision, but does not mention line-number drift.
- **`src/orchestration/skills.ts`** -- Contains `proposalInstruction` that tells agents to read the proposal file. No changes needed here; the content of proposals (shaped by the templates above) is what matters.

The complementary task gh-ludics-220 adds drift detection at plan-merge time. This task prevents the problem at the source; gh-ludics-220 catches any remaining mismatches.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. In `skills/ludics-elaborate-worker.md`, change the Code Pointers template example from `[relevant files and functions with line numbers]` to guidance referencing function/symbol names. Add a note that line numbers should not be used because they drift between elaboration and implementation.
2. In `skills/ludics-draft-proposal-worker.md`, expand the Context section guidance to explicitly say "Reference code by function, type, or symbol name rather than line numbers. Line numbers drift as other PRs merge before implementation begins. When line-level precision is needed, quote a short distinctive code snippet."
3. In `skills/ludics-revise-proposal-worker.md`, add "stale line-number references" to the list of factual errors to correct during revision.
4. In the elaborate-worker's short-form example (around the `[code pointers, observations, edge cases]` line), reinforce the same convention.

## Scope

**In scope:**
- Template text changes in the three skill files listed above
- Convention guidance only -- no runtime code changes

**Out of scope:**
- Retroactively fixing existing proposals that contain line numbers (the plan-merge checklist from gh-ludics-220 serves as safety net)
- Runtime freshness checks or line-number validation tooling
- Changes to `src/orchestration/skills.ts` or the coder-plan template (those consume proposals but don't shape how they're written)
