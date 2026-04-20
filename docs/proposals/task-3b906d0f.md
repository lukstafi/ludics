# Template Empty-Value Lint

## Goal

Add a CI lint script that detects `{{VAR}}` patterns in shell contexts within orchestration templates where VAR could resolve to an empty string, silently producing broken shell commands (e.g., `--repo ""`, `https://github.com/.git`). This catches the class of bugs exemplified by gh-ludics-302 at CI time, before they reach production.

## Acceptance Criteria

- [ ] New script `scripts/lint-template-safety.ts` scans all `skills/orchestration/*.md` templates and flags `{{VAR}}` patterns used inside fenced `sh`/`bash` code blocks or inline backtick commands where the variable is not guaranteed non-empty and not guarded by `{{#IF VAR}}`
- [ ] The script maintains a list of "always-populated" variables (derived from `buildSkillContext()` literal assignments) and only warns about variables outside this list when used in shell contexts
- [ ] Variables used inside a `{{#IF VAR}}...{{/IF}}` block are recognized as guarded and not flagged
- [ ] The lint exits non-zero when violations are found, failing CI
- [ ] The current template set either passes the lint cleanly or any violations are fixed in the same PR
- [ ] Wired into `package.json` as `lint:template-safety` and added to `.github/workflows/ci.yml`
- [ ] `bun test` passes with no regressions

## Context

### The problem

`substituteTemplate()` in `src/orchestration/skills.ts:305-333` substitutes `{{VAR}}` with `values[VAR] ?? ""`. Many variables can legitimately be empty (`UPSTREAM_REPO`, `VERIFICATION_CONTEXT`, `PROPOSAL_INSTRUCTION`, `PEER_PR_URL`, etc.). When these appear inside shell commands, empty substitution produces syntactically valid but semantically broken commands:
- `--repo "{{PROJECT_REPO}}"` becomes `--repo ""` (gh resolves to wrong repo)
- `https://github.com/{{UPSTREAM_REPO}}.git` becomes `https://github.com/.git`

The gh-ludics-302 fix introduced the `{{#IF PROJECT_REPO}}...{{/IF}}` guard pattern in `pr-create.md` and `pair-coder-pr-create.md`. However, `forward-pr.md` and `upstream-final-merge.md` still use raw `{{PROJECT_REPO}}` and `{{UPSTREAM_REPO}}` in shell code blocks (these are upstream-only templates so the variables should always be set in practice, but the lack of a safety net is the fragility this lint addresses).

### Always-populated variables

From `buildSkillContext()` (lines 232-271), these variables are always assigned non-empty string values by construction:

`PHASE`, `ROUND`, `MODE`, `TASK_ID`, `AGENT_NAME`, `AGENT_PROVIDER`, `AGENT_ROLE`, `PEER_NAME`, `PEER_PROVIDER`, `TASK_SPEC`, `TASK_SPEC_BRIEF`, `PEER_REVIEW`, `PEER_STATUS`, `PEER_PLAN`, `GIT_DIFF_STAT`, `PREVIOUS_ROUND_SUMMARY`, `MERGE_VOTES`, `WORKTREE_PATH`, `PEER_WORKTREE_PATH`, `STATUS_FILE`, `PLAN_FILE`, `MERGED_PLAN_FILE`, `PLAN_MERGE_ROUND`, `REVIEW_FILE`, `PR_FILE`, `INTERRUPT_FILE`, `MERGE_VOTE_FILE`, `SUGGEST_REFACTOR_FILE`, `WORKFLOW_FEEDBACK_FILE`, `MERGE_REVIEW_DECISION_FILE`, `MERGED_MARKER_FILE`, `UPSTREAM_PR_FILE`, `UPSTREAM_MERGED_MARKER_FILE`, `FORWARDED_MARKER_FILE`, `PEER_SYNC_DIR`, `DONE_STATUS`

These are safe in shell contexts and should not be flagged.

### Potentially-empty variables (must be guarded in shell contexts)

`VERIFICATION_CONTEXT`, `UPSTREAM_REPO`, `PROPOSAL_PATH`, `PROPOSAL_INSTRUCTION`, `PROJECT_REPO`, `PROJECT_*` (auto-injected, absent when config field missing), `PEER_SLOT`, `PEER_PR_URL`, `PEER_BRANCH`, `PEER_PEER_SYNC_DIR`

### Existing safe patterns to recognize

1. **`{{#IF VAR}}` guards**: `pr-create.md` line 9 uses `{{#IF PROJECT_REPO}}--repo "{{PROJECT_REPO}}" {{/IF}}` -- the variable inside the conditional block is safe because the block is removed when the variable is empty.
2. **Non-shell contexts**: Variables in markdown prose (outside fenced code blocks and inline backticks) are harmless when empty.

### Existing lint infrastructure

- `scripts/lint-config-reference.ts` -- CI lint for config schema drift (exits 0/1)
- `scripts/lint-cli-readme.ts` -- CI lint for CLI/README drift (exits 0/1)
- Both follow the pattern: `#!/usr/bin/env bun`, read files with `readFileSync`, report errors to stderr, exit non-zero on failures
- CI workflow at `.github/workflows/ci.yml` runs both as named steps

### Templates to scan

All `skills/orchestration/*.md` files (~30 templates). The lint should glob these automatically.

### Current violations

Based on codebase analysis, the following templates use potentially-empty variables in shell contexts without `{{#IF}}` guards:

- `forward-pr.md`: `{{PROJECT_REPO}}` (3 uses in `gh pr view`/`gh pr comment` inside code blocks), `{{UPSTREAM_REPO}}` (3 uses in `git remote add`/`gh pr list`/`gh pr create`)
- `upstream-final-merge.md`: `{{PROJECT_REPO}}` (2 uses in `gh pr comment`/`gh pr close`), `{{UPSTREAM_REPO}}` (1 use in `git remote add`)

These are upstream-only templates (only resolved when `hasUpstream` is true), so both variables should always be populated in practice. The fix options are:
1. Add `{{#IF VAR}}` guards around the relevant command fragments
2. Add these templates to a per-file allowlist with a comment explaining why the variables are guaranteed non-empty
3. Add the templates' vars to a "contextually safe" annotation (e.g., a comment at the top of the template)

Option 2 (per-file allowlist in the lint script) is the pragmatic choice: these templates are only reached when upstream is configured, which guarantees both `UPSTREAM_REPO` and `PROJECT_REPO` are set. Adding `{{#IF}}` guards would add noise without real safety benefit for these specific templates.

## Approach

### Script structure

Create `scripts/lint-template-safety.ts` following the existing lint script conventions:

1. **Glob** all `skills/orchestration/*.md` files
2. **Parse** each template to identify shell contexts:
   - Fenced code blocks: lines between ` ```sh ` / ` ```bash ` and ` ``` ` markers
   - Inline backtick commands: backtick-enclosed spans containing shell-like patterns (e.g., starting with `git `, `gh `, `printf `, `cat `, etc.)
3. **Extract** all `{{VAR}}` references within shell contexts
4. **Filter out** safe usages:
   - Variables in the always-populated set
   - Variables that appear inside a `{{#IF VAR}}...{{/IF}}` block encompassing the shell usage
   - Variables in the per-file allowlist (with required comment explaining why)
5. **Report** remaining violations and exit non-zero if any found

### IF-guard detection

The `{{#IF VAR}}` guard detection needs to handle the nesting structure: if a `{{VAR}}` reference appears between a `{{#IF VAR}}` and its matching `{{/IF}}`, it is guarded. The simplest approach: for each flagged variable occurrence, walk backward through the template to find an unclosed `{{#IF VAR}}` for the same variable. If found, the usage is guarded.

### Allowlist format

```ts
const TEMPLATE_ALLOWLIST: Record<string, Set<string>> = {
  // Upstream-only templates: only resolved when hasUpstream is true,
  // guaranteeing PROJECT_REPO and UPSTREAM_REPO are populated.
  "forward-pr.md": new Set(["PROJECT_REPO", "UPSTREAM_REPO"]),
  "upstream-final-merge.md": new Set(["PROJECT_REPO", "UPSTREAM_REPO"]),
};
```

### CI integration

Add to `package.json`:
```json
"lint:template-safety": "bun run scripts/lint-template-safety.ts"
```

Add to `.github/workflows/ci.yml`:
```yaml
- name: Lint template variable safety
  run: bun run lint:template-safety
```

## Scope

**In scope:**
- New lint script `scripts/lint-template-safety.ts`
- CI integration (package.json script + workflow step)
- Per-file allowlist for upstream-only templates

**Out of scope:**
- Runtime changes to `substituteTemplate()` (Approach B/D from elaboration)
- Expanding the computed-flag pattern to more variables (Approach C)
- Linting non-orchestration templates (Mag skills, etc.)
- Automated fix/rewrite of flagged templates
