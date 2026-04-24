# Wire lint:contracts into .github/workflows/ci.yml

## Goal

The `lint:contracts` npm script is defined in `package.json` alongside four
other `lint:*` scripts, but is the only one of those five not wired into the
`build` job in `.github/workflows/ci.yml`. The omission was accidental (per
elaboration of gh-ludics-376, 2026-04-24). This proposal adds a single CI step
so contract drift between worker/orchestrator skill-pair markdown files is
caught in CI instead of silently passing until a human runs the script locally.

## Acceptance Criteria

- [ ] `.github/workflows/ci.yml` runs `bun run lint:contracts` as part of the
      `build` job on every push to `main`/`TypeScript-migration` and every PR
      to `main` (i.e., under the same triggers as the sibling lint steps).
- [ ] The step runs unconditionally (no `if:` gating), matching the pattern of
      the other four `lint:*` steps.
- [ ] The step name starts with `Lint ` to match the voice of neighboring
      steps.
- [ ] After the change, `bun run lint:contracts` passes against current `main`
      (verified locally; no drift at time of writing).
- [ ] No other changes to `ci.yml` or `package.json`.

## Context

**Script definition** (`package.json`, under `scripts`):

```json
"lint:contracts": "bun run scripts/lint-contracts.ts",
```

The script `scripts/lint-contracts.ts` (~333 lines) detects field-name drift
between worker and orchestrator skill-pair markdown files — specifically the
`### Response Contract` block in worker skills vs. `## Status routing` /
`## Verdict routing` blocks in orchestrators. Exits `1` on drift, `0` on clean.
Runtime is ~30ms locally; no CI wall-time concern.

**CI workflow** (`.github/workflows/ci.yml`): single `build` job on
`ubuntu-latest`. After `Install dependencies` / `Type check` / `Build binary`,
four sibling lint steps run in sequence:

- `Lint CLI/README drift` → `bun run lint:cli-readme`
- `Lint config reference drift` → `bun run lint:config-reference`
- `Lint template variable safety` → `bun run lint:template-safety`
- `Lint — no mock.module() in tests` → `bun run lint:no-mock-module`
- `Lint — eslint` → `bun run lint`

None of them use conditional gating. `lint:contracts` is the only sibling
`scripts/lint-*.ts`-style script not represented here.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Insert one new step into the `build` job, after `Lint — no mock.module() in
tests` and before `Lint — eslint` (keeping the `scripts/lint-*.ts`-style
checks grouped together, with the broader eslint pass last):

```yaml
      - name: Lint worker/orchestrator contracts
        run: bun run lint:contracts
```

Step-name wording is flexible as long as it starts with `Lint ` and describes
what is checked. No other edits are needed.

## Scope

**In scope**: single additive edit to `.github/workflows/ci.yml`.

**Out of scope**:
- Changes to `scripts/lint-contracts.ts` itself.
- Reordering or renaming of existing CI steps.
- Adding contract-drift checks to pre-commit hooks or other workflows.
- Any changes to `package.json`.

**Dependencies**: none. Related to gh-ludics-376 (which spawned this
follow-up), but independent.
