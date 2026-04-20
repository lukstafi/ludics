# Proposal: Extend config-reference lint to also check templates/harness/config.yaml

**Task:** task-d4b83ebe
**Date:** 2026-04-20

## Goal

Extend `scripts/lint-config-reference.ts` to verify that every key path in `templates/harness/config.yaml` is a subset of the key paths in `templates/config.reference.yaml`. This prevents the harness template from containing keys that don't exist in the reference, catching drift that was flagged during gh-ludics-203 review.

## Acceptance Criteria

1. The lint script parses `templates/harness/config.yaml` and flattens its keys using the existing `flattenYamlPaths()` helper with the same `FREEFORM_CHILDREN` and `WILDCARD_MAP_PATHS` sets.
2. Any key path present in the harness config but absent from the reference YAML is reported as an error (with a distinct message identifying the harness file).
3. The check is one-directional: harness keys must be a subset of reference keys. Missing reference keys that aren't in the harness config are not flagged.
4. The existing integration test (`lint-config-helpers.test.ts:213`) continues to pass (exit 0), confirming the current harness template is already a valid subset.
5. The lint exit code reflects the new check: any harness-only keys cause exit 1 alongside existing TS/YAML drift errors.

## Context

- **`scripts/lint-config-reference.ts`** (107 lines): The existing lint with Direction 1 (TS -> YAML) and Direction 2 (YAML -> TS) checks. The new Direction 3 (harness -> reference) check goes after line 100, before the exit.
- **`scripts/lint-config-helpers.ts`**: Provides `flattenYamlPaths()` (lines 238-284) which handles arrays, wildcard map paths, and freeform children. Reused as-is.
- **`templates/config.reference.yaml`** (283 lines): Exhaustive reference with all defaults.
- **`templates/harness/config.yaml`** (119 lines): Sparse user-facing example. Contains freeform triggers, notification topics/priorities, and wildcard adapter entries -- all handled by existing skip/wildcard sets.
- **Integration test** (`lint-config-helpers.test.ts:213-225`): Runs `bun run lint-config-reference.ts` and expects exit 0. Automatically covers the new check.

## Approach

After the existing Direction 1+2 comparison and error reporting (around line 100), add approximately 15-20 lines:

1. Read and parse `templates/harness/config.yaml` with the YAML library (already imported).
2. Flatten it with `flattenYamlPaths(harnessObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS)` -- reusing the same constants already defined in the script.
3. Compute the set difference: keys in `harnessPaths` that are not in `yamlPaths` (the already-computed reference paths).
4. Report any extras as errors with a message like "templates/harness/config.yaml has keys not in config.reference.yaml".
5. Add the count to the existing `errors` accumulator so exit code reflects the result.

No new dependencies, no new helper functions, no changes to the test file needed.
