# lint:vendor-sync — fail when templates/dashboard/vendor/* drifts from node_modules versions

## Goal

The dashboard markdown renderer test imports `marked` and `dompurify` from
`node_modules/`, while the browser loads vendored copies from
`templates/dashboard/vendor/`. The only thing keeping these aligned today is
the manual "To bump" ritual in `templates/dashboard/vendor/README.md` — if a
future bump touches one side and forgets the other, the test still passes
against the npm copy while the browser silently serves a different version.

Add a CI lint that fails when any vendored file differs byte-for-byte from
its upstream `node_modules/` copy, so version skew is impossible to land
silently. Auto-generated from durable learning #6 in the retrospective for
`task-61aee08e` (PR #436, merged 2026-04-29).

## Acceptance Criteria

- [ ] `scripts/lint-vendor-sync.ts` exists and exits non-zero when any
      pairing differs byte-for-byte; exits 0 when all match. Follows the
      shape of sibling lint scripts (`#!/usr/bin/env bun` shebang,
      `import.meta.main` CLI block, exported pure helpers, path resolution
      via `import.meta.dir` so it works from any cwd).
- [ ] Pairings are declared in a single `readonly` array (or equivalent
      data-driven structure) at the top of the script — adding a new
      vendored library is one entry.
- [ ] `scripts/lint-vendor-sync.test.ts` exists and is invokable via
      `bun test scripts/lint-vendor-sync.test.ts`. Test does not depend on
      real `node_modules/` content (uses tmp fixture directories or accepts
      the pairing array as input). Covers: matching bytes → 0; differing
      bytes on at least one pairing → non-zero; missing upstream file →
      non-zero with a distinct message.
- [ ] `package.json` has a `lint:vendor-sync` script entry that runs
      `bun run scripts/lint-vendor-sync.ts`. The top-level `lint` script
      is **not** modified — it remains `eslint "src/**/*.ts" --max-warnings=0`,
      consistent with how every other `lint:*` script in this repo is wired.
- [ ] `.github/workflows/ci.yml` has a new step (alongside the other
      `Lint — …` steps in the `build` job) that runs
      `bun run lint:vendor-sync`.
- [ ] `templates/dashboard/vendor/README.md` "To bump" section references
      `bun run lint:vendor-sync` as the post-bump verification step (either
      a new step or replacing the manual `bun test …` step).
- [ ] Failure messages name both paths, both byte counts, and the exact
      `cp` command that would resolve the drift. When upstream is missing,
      the message hints to run `bun install`.

## Context

### How vendoring works today

`templates/dashboard/vendor/` is the source of truth for what the browser
loads. `dashboardInstall` in `src/dashboard.ts` copies these files to
`~/self-improve/harness/dashboard/vendor/` on every install — the harness
copy is a derived artifact and out of scope for this lint.

Current vendored files (verified `ls`):
- `templates/dashboard/vendor/marked.esm.js`
- `templates/dashboard/vendor/purify.es.js`
- `templates/dashboard/vendor/README.md`

Current upstream paths (verified):
- `node_modules/marked/lib/marked.esm.js`
- `node_modules/dompurify/dist/purify.es.mjs` — note the **filename-extension
  skew** (`.mjs` upstream vs `.js` vendored). Pairings must store both
  sides as full paths, not derive one from the other.

Both vendored files currently match upstream byte-for-byte (`diff -q` is
silent), so the lint will land green and any later drift bisects to the
PR that introduced it.

### Existing lint script conventions

Sibling scripts in `scripts/`:
- `lint-template-safety.ts` + `lint-template-safety.test.ts` —
  `import.meta.main` block at the bottom, `runLint(dir)` exported helper,
  `Violation[]`-shaped return type, path resolution via
  `join(import.meta.dir, "..")`, optional CLI argv override that lets the
  test exercise real exit-code paths against a temp dir.
- `lint-cli-readme.ts` + `lint-cli-readme.test.ts` — same shape; test
  exercises pure helpers with in-memory strings.
- `lint-test-isolation.ts` + `lint-test-isolation.test.ts` — same shape;
  test writes tmp files.
- `lint-contracts.ts` + `lint-contracts.test.ts` — same shape.

### CI wiring convention

`.github/workflows/ci.yml` has one `Lint — …` step per `lint:*` script in
`package.json`. There is no aggregate `bun run lint:all`. The `lint`
entry in `package.json` is `eslint "src/**/*.ts" --max-warnings=0`, **not**
a fan-out — this contradicts the wording of the task's original AC bullet
about "the aggregate `lint` script invokes it." This proposal resolves
that ambiguity in favor of the existing convention (option (a) from the
elaboration question, confirmed by the user 2026-04-30): one new
`lint:vendor-sync` script, one new CI step, top-level `lint` unchanged.

### Vendor README "To bump"

`templates/dashboard/vendor/README.md` lines 27-34 list the current 4-step
ritual. The lint should be added either as a new step 5 ("`bun run
lint:vendor-sync` to verify alignment") or as a replacement for step 5
that subsumes the manual test re-run.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Script shape

```ts
#!/usr/bin/env bun
// scripts/lint-vendor-sync.ts
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Pair {
  vendored: string; // repo-relative
  upstream: string; // repo-relative
}

export const PAIRS: ReadonlyArray<Pair> = [
  {
    vendored: "templates/dashboard/vendor/marked.esm.js",
    upstream: "node_modules/marked/lib/marked.esm.js",
  },
  {
    vendored: "templates/dashboard/vendor/purify.es.js",
    upstream: "node_modules/dompurify/dist/purify.es.mjs",
  },
];

export interface Violation {
  pair: Pair;
  kind: "missing-upstream" | "missing-vendored" | "bytes-differ";
  vendoredBytes?: number;
  upstreamBytes?: number;
  hint: string;
}

export function checkPairs(root: string, pairs: ReadonlyArray<Pair> = PAIRS): Violation[] {
  // …readFileSync both sides, Buffer.equals(); produce Violation per mismatch
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const violations = checkPairs(root);
  if (violations.length === 0) {
    console.log("✅  All vendored files match their node_modules upstreams byte-for-byte.");
    process.exit(0);
  }
  // Print one line per violation: paths + byte counts + hint (cp command, or "did you forget bun install?")
  process.exit(1);
}
```

### Test shape

`scripts/lint-vendor-sync.test.ts` writes tmp directories with synthetic
vendored/upstream files (the test parameterizes `checkPairs` with a custom
pairing array pointing at the tmp dir), and asserts:

- Identical bytes on every pair → empty `Violation[]`.
- One pair with differing bytes → exactly one `bytes-differ` violation
  naming that pair.
- Missing upstream file → `missing-upstream` violation with bytes-info
  absent on the upstream side.
- Optional: missing vendored file → `missing-vendored` violation.

The test does **not** read real `node_modules/` content — it stays
hermetic.

### `package.json`

Add one entry alongside the existing `lint:*` scripts:

```json
"lint:vendor-sync": "bun run scripts/lint-vendor-sync.ts"
```

Leave the existing `lint` entry (`eslint "src/**/*.ts" --max-warnings=0`)
unchanged.

### `.github/workflows/ci.yml`

Add one new step in the `build` job, alongside the other `Lint — …` steps:

```yaml
      - name: Lint — vendor sync
        run: bun run lint:vendor-sync
```

Position it adjacent to the other lint steps (order doesn't matter
functionally; pick a sensible alphabetical or thematic spot).

### `templates/dashboard/vendor/README.md`

Either append a new step to "To bump":

```markdown
5. Run `bun run lint:vendor-sync` to verify the vendored copies match
   the freshly installed npm copies byte-for-byte.
```

…or replace the existing step 5 (`bun test templates/dashboard/markdown.test.ts`)
with a combined `bun run lint:vendor-sync && bun test templates/dashboard/markdown.test.ts`
so both verifications stay in the ritual. Either is acceptable — the lint
is the load-bearing addition; the test re-run is still useful.

## Scope

**In scope:**
- New `scripts/lint-vendor-sync.ts` + `scripts/lint-vendor-sync.test.ts`.
- One new `package.json` script entry.
- One new CI step in `.github/workflows/ci.yml`.
- README "To bump" amendment.

**Out of scope:**
- Comparing dependency versions in `package.json` against the README
  header text inside vendored files (the byte-for-byte check subsumes
  this for any meaningful drift).
- Auto-fixing drift (`--fix` mode that runs the cp commands). The
  bump workflow is rare enough that manual is fine.
- Verifying that `~/self-improve/harness/dashboard/vendor/*.js` (the
  install target) matches templates — that copy is regenerated on
  `dashboardInstall` and lives outside this repo.
- `.gitattributes` rules for line-ending normalization. Today's repo
  is single-developer, all macOS/Linux. Surface as a follow-up only if
  the lint starts failing for line-ending reasons in practice.

**Dependencies:** none. The original durable learning is from PR #436
(already merged); the existing vendored files match upstream today.
