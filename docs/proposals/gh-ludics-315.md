# Proposal: Named section anchors for skill markdown files

**Task**: gh-ludics-315
**Project**: ludics

## Goal

Add HTML comment anchors (`<!-- section:NAME -->`) at major section boundaries in skill markdown files, and replace fragile step-number cross-references with stable section-name references. This makes diffs reviewable at the section level and eliminates cascading number updates when steps are inserted or reordered.

## Acceptance Criteria

### Part 1: Anchor convention and high-priority files

1. Every `### N. Step name` sub-heading under `## Process` in the 5 high-priority files gains a `<!-- section:NAME -->` comment on the line immediately preceding it, where NAME is a stable kebab-case identifier derived from the step's purpose (not its number). Example:
   ```markdown
   <!-- section:nudge-stalled -->
   7. **Nudge stalled slotted tasks**:
   ```

2. Top-level structural sections (`## Trigger`, `## Inputs`, `## Process`, `## Output Format`, `## Delegation Strategy`, `## Error Handling`, and any skill-specific top-level sections) also receive anchors in these files. Example:
   ```markdown
   <!-- section:output-format -->
   ## Output Format
   ```

3. The 5 high-priority files are: `ludics-briefing.md`, `ludics-revise-proposal-worker.md`, `orchestration/forward-pr.md`, `ludics-process-suggestions.md`, `ludics-verify-completion-worker.md`.

### Part 2: Replace step-number cross-references

4. All step-number cross-references in the 5 high-priority files are replaced with section-name references. Specifically:
   - `ludics-briefing.md` line 67: `"Still run step 7 (Nudge stalled slotted tasks)"` becomes `"Still run the nudge-stalled section"`
   - `ludics-briefing.md` line 67: `"skip to step 9"` becomes `"skip to the write-result section"`
   - `ludics-briefing.md` line 144: `"step 6"` becomes `"the assign-slots section"`
   - `ludics-revise-proposal-worker.md`: all 6 internal step-number references are replaced with their corresponding section names
   - `orchestration/forward-pr.md` line 67: `"step 1"` becomes `"the read-working-pr section"`
   - `ludics-process-suggestions.md` line 123: `"step 3"` becomes `"the parse-retrospective section"`
   - `ludics-verify-completion-worker.md` line 40: `"step 1"` becomes `"the read-task section"`

5. Step numbers themselves are preserved for ordering/readability -- only cross-references change.

### Part 3: Medium-priority files (anchors only, no cross-ref changes needed)

6. The 6 medium-priority files (`ludics-elaborate-worker.md`, `ludics-draft-proposal-worker.md`, `ludics-health-check.md`, `ludics-adopt-sessions.md`, `ludics-sync-learnings.md`, `ludics-draft-proposal.md`) receive `<!-- section:NAME -->` anchors on all `## Process` sub-steps and top-level structural sections.

### Part 4: Non-interference verification

7. Existing `<!-- Entry: ... -->` / `<!-- End entry -->` markers in `ludics-sync-learnings.md` are left unchanged (these are output format templates, not section anchors).
8. `orchestrator-conventions.md` letter-based sections (A-F) are left unchanged -- they already serve as stable named identifiers.
9. Orchestration template files (`skills/orchestration/`) that use `{{VAR}}` substitution continue to work -- HTML comments pass through `substituteTemplate()` unmodified. (Verified: the function only matches `{{...}}` patterns.)
10. Skill files are copied verbatim by `init.ts` to `.claude/commands/` -- HTML comments survive this copy with no special handling needed.

### Part 5: Low-priority files (out of scope)

11. The remaining ~36 files (mostly orchestration templates under 85 lines) are explicitly out of scope for this task. They can be anchored in a follow-up if the pattern proves valuable.

## Context

- **Existing best practice**: `orchestrator-conventions.md` already uses named sections (`## Section A -- Task Resolution`, etc.) referenced by letter from other skills. This works well and demonstrates the value of stable identifiers.
- **Existing HTML comments**: Only `ludics-sync-learnings.md` uses HTML comments currently (`<!-- Entry: ... -->` / `<!-- End entry -->`), for a different purpose (output format templates). The new `<!-- section:NAME -->` pattern is visually and semantically distinct.
- **Template substitution safety**: `substituteTemplate()` in `src/orchestration/skills.ts` processes only `{{VAR}}` and `{{#IF VAR}}...{{/IF}}` patterns. HTML comments are inert.
- **File copy safety**: `init.ts` uses `copyFileSync` to deploy skills to `.claude/commands/`. HTML comments pass through unchanged.
- **Evidence of fragility**: `ludics-briefing.md` has 3 step-number cross-references, `ludics-revise-proposal-worker.md` has 6. These would all break silently if steps were inserted, reordered, or merged -- a real maintenance hazard given the frequency of skill file edits.

## Approach

The implementation is a straightforward text-editing pass:

1. For each file in priority order, insert `<!-- section:NAME -->` comments before each section heading.
2. For the 5 high-priority files, also find-and-replace step-number cross-references with the corresponding section names.
3. NAME derivation rule: take the step's bold title (e.g., "Nudge stalled slotted tasks"), kebab-case it, truncate to the meaningful core (e.g., `nudge-stalled`). For top-level sections, use the heading text directly (e.g., `output-format`, `error-handling`, `delegation-strategy`).
4. Verify no `{{...}}` patterns are accidentally introduced and no existing comment markers are disrupted.

No TypeScript code changes are required. No tests need updating (the anchors are invisible to all consumers). The change is purely in skill markdown content.
