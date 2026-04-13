# Migrate remaining project: regex reads in slots/index.ts and mag.ts to readFrontmatterField

## Goal

The `readFrontmatterField` helper (introduced in gh-ludics-170) correctly scopes field reads to YAML frontmatter, preventing false matches from markdown body content. Four `project:` regex reads in `src/slots/index.ts` and `src/mag.ts` still use raw `/^project:\s*(.+)$/m` patterns that scan the entire file content, making them vulnerable to the same body-scope bug. This task migrates those remaining call sites to use the shared helper.

Related: [gh-ludics-170](https://github.com/lukstafi/ludics/issues/170)

## Acceptance Criteria

- All `content.match(/^project:\s*(.+)$/m)` calls in `src/slots/index.ts` (1 site) and `src/mag.ts` (3 sites) are replaced with `readFrontmatterField(content, "project")`.
- `readFrontmatterField` is added to the existing import from `../tasks/markdown.ts` in `src/slots/index.ts`.
- Existing behavior is preserved: null/missing project values continue to be handled identically (the helper returns `null` just like a failed regex match).
- The project builds without errors (`bun run build`).
- Adjacent `title:` and `priority:` regex reads in the same code blocks may optionally be migrated if the implementer judges it worthwhile, but are not required.

## Context

**`readFrontmatterField`** (`src/tasks/markdown.ts:85`): Parses YAML frontmatter via `YAML.parse`, returns `string | null`. Already imported and used in `mag.ts` (line 27, used at line 917). Exported from `src/tasks/markdown.ts`.

**`src/slots/index.ts`** (1 call site):
- Line 660: `content.match(/^project:\s*(.+)$/m)` -- resolves project path when slot path is empty. The file already imports from `../tasks/markdown.ts` (line 14) but does not yet import `readFrontmatterField`.

**`src/mag.ts`** (3 call sites):
- Line 1817: `content.match(/^project:\s*(.+)$/m)` -- builds `projectsInSlots` map.
- Line 1866: `content.match(/^project:\s*(.+)$/m)` -- groups ready tasks by project.
- Line 2084: `content.match(/^project:\s*(.+)$/m)` -- checks if task is from a postponed project.

**Return value compatibility**: The regex returns `null` on no match. `readFrontmatterField` returns `null` when the field is missing, the value is `"null"`, or frontmatter is absent. The `.trim()` calls on regex results are unnecessary with the helper since YAML parsing handles whitespace.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Add `readFrontmatterField` to the existing import in `src/slots/index.ts` line 14.
2. Replace each regex call with `readFrontmatterField(content, "project")`, adjusting the surrounding code to use the `string | null` return (drop `.trim()`, replace `match[1]!` indexing with direct use of the returned string).
3. Build and verify no type errors or regressions.

## Scope

**In scope**: The 4 `project:` regex-to-helper migrations listed above.

**Optionally in scope**: Adjacent `title:` and `priority:` regex reads in the same code blocks (~lines 1870-1874 of `mag.ts`), at implementer discretion.

**Out of scope**: Other field regex reads (`status:`, `effort:`, `title:` elsewhere) -- those are a separate, larger effort. No new tests required for this mechanical refactor since `readFrontmatterField` is already tested.
