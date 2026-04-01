# Consolidate duplicate proposal-value extraction in skills.ts

## Goal

Three call sites in `src/orchestration/skills.ts` duplicate the frontmatter `proposal:` field extraction logic (regex match + quote stripping) that `readFrontmatterField` in `src/adapters/task-launch.ts` already provides. Consolidating these removes the duplication and ensures consistent parsing behavior.

## Acceptance Criteria

- All three inline `proposal:` regex+strip patterns in `skills.ts` are replaced by calls to `readFrontmatterField(content, "proposal")`
- The `"inline"` sentinel check is preserved after each call (not handled by `readFrontmatterField`)
- `readFrontmatterField` is imported from `../adapters/task-launch.ts` in `skills.ts`
- `bun run build` succeeds with no new errors or warnings
- Existing tests pass (`bun test`)
- Behaviour is unchanged: proposal path extraction, summary generation, and brief text all produce the same output as before

## Context

`readFrontmatterField(content, field)` in `src/adapters/task-launch.ts` (line 15) extracts a named field from YAML frontmatter between `---` fences, strips surrounding quotes via `normalizeYamlScalar`, and returns `null` for empty or `"null"` values.

Three sites in `src/orchestration/skills.ts` duplicate this with inline code:

1. **`taskSpecBriefText`** (line ~97): `content?.match(/^proposal:\s*(.+)$/m)` + `.trim().replace(/^["']|["']$/g, "")`
2. **`taskSpecText`** (line ~119): same pattern, used to decide whether to append proposal file content
3. **`buildSkillContext`** (line ~243): same pattern with underscore-prefixed variables

All three sites also check for the `"inline"` sentinel value after extraction, which `readFrontmatterField` does not filter -- those guards must remain.

Key difference: the inline regex matches `proposal:` anywhere in the file, while `readFrontmatterField` restricts to the frontmatter block. Since task files always have proper `---` fences, results are equivalent.

**Key files:**
- `src/orchestration/skills.ts` -- the three duplicate extraction sites
- `src/adapters/task-launch.ts` -- exports `readFrontmatterField` (line 15) and `assertRepoRelativeProposalPath` (already imported on line 3 of skills.ts)

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Add `readFrontmatterField` to the existing import from `../adapters/task-launch.ts` on line 3.
2. Replace each inline regex+strip with a call to `readFrontmatterField(content, "proposal")`, wrapping in a ternary for nullable content (`content ? readFrontmatterField(content, "proposal") : null`).
3. Preserve all existing `"inline"` sentinel checks unchanged.

## Scope

**In scope:** The three extraction sites in `skills.ts` and the new import.

**Out of scope:** Changing `readFrontmatterField` itself, modifying other files, or altering the `"inline"` sentinel behavior.

**Dependencies:** None.
