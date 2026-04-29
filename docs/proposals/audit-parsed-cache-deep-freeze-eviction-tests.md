# Audit parsed-object caches for missing deep-freeze + identity-based eviction tests

## Goal

Issue: https://github.com/lukstafi/ludics/issues/405

The deep-freeze + identity-eviction-test pattern landed at the canonical site
in PR #396 (`parseTaskFrontmatter` in `src/tasks/markdown.ts`, with the
five-test cache `describe` block in `src/tasks/markdown.test.ts`). The
deliverable here is the *retrofit*: audit the four other parsed/computed-object
cache sites, decide per-site whether the freeze is warranted, and add the
missing identity-based eviction tests where they would prevent real bugs.

This is a code audit, not a blanket policy roll-out. The user has explicitly
locked in **per-site judgment** (see Notes in the task file): some sites get
the retrofit, some get a documented skip-with-rationale. Defense-in-depth at
every cache is the anti-pattern flagged by gh-ludics-410.

## Acceptance Criteria

- [ ] All four cache sites audited; for each site, the audit summary records
      either (a) the freeze strategy + identity-eviction test that was added,
      or (b) a skip-with-rationale stating why the freeze is academic and the
      test is not warranted.
- [ ] **`skill-queue-registry`** site: caller audit recorded. If the audit
      confirms `SkillQueueEntry` records never escape the module's public API
      (current public surface returns only resolved `string | null` and
      `boolean`), document the skip. Otherwise freeze entries on insertion
      mirroring `deepFreezeParsed`.
- [ ] **`config.ts` `_postponedProjectsCache` and `_priorityProjectsCache`**
      sites: a single freeze strategy chosen and applied to **both**
      consistently. The strategy must address the `Set`-freeze gotcha
      (`Object.freeze` is inert for `.add()`/`.delete()` on `Set`). Acceptable
      strategies: convert the public return type to `ReadonlySet<string>` and
      wrap the underlying `Set` in a `Proxy` that throws on mutator methods;
      or change the public return type to a frozen `readonly string[]`.
      The choice is a reviewer-relevant judgment call; whichever is picked,
      apply it identically at both sites.
- [ ] **`dashboard.ts` `doctorCache`** site: audit confirms the existing
      shallow-wrapper return at `generateHealthData` (the `{ output,
      timestamp }` literal returned beside `healthReport`) means callers do
      not receive the cached record by reference. The freeze step is
      therefore a skip-with-rationale. The identity-based eviction test is
      still added: the existing "doctor cache prevents re-spawn within TTL"
      test in `src/dashboard.test.ts` proves field equality but not record
      replacement on TTL expiry. The new test must drive the cache past TTL
      deterministically and assert that the returned `doctor` object's
      `timestamp` (a stable identity proxy for the cached record) is replaced
      across the boundary, mirroring the pre-eviction / post-eviction
      identity assertions in `markdown.test.ts:583-680`'s LRU test.
- [ ] For every site that gets a freeze retrofit, an identity-based test is
      added that mirrors the canonical pattern from
      `src/tasks/markdown.test.ts`'s `parseTaskFrontmatter cache` describe
      block: capture pre-eviction reference, mid-fill identity assertion
      (cache *is* serving by identity until eviction), post-eviction `!==`
      assertion, plus nested-mutation-throws assertions where nested
      containers exist.
- [ ] For every retrofitted site, underscore-prefixed test-only helpers
      (`_resetXCache()` and where useful `_xCacheSize()`) are added if not
      already present, mirroring `_resetParseTaskFrontmatterCache` and
      `_parseTaskFrontmatterCacheSize` in `src/tasks/markdown.ts`. These
      helpers must NOT be re-exported from `src/index.ts`.
- [ ] Tests pass: `bun test` is green.
- [ ] The audit summary (the per-site decision log) is preserved either as a
      brief comment block above each cache declaration in the source files,
      or in the PR description — wherever a future reader will find it
      while reading the cache code. (Reviewer judgment on placement.)

## Context

### Canonical worked example (already landed)

- `src/tasks/markdown.ts` — `PARSE_CACHE`, `deepFreezeParsed`,
  `parseTaskFrontmatter`, `_resetParseTaskFrontmatterCache`,
  `_parseTaskFrontmatterCacheSize`. FIFO eviction at `PARSE_CACHE_MAX = 512`.
- `src/tasks/markdown.test.ts` — `describe("parseTaskFrontmatter cache", …)`
  block: identity hit + `Object.isFrozen`, top-level mutation throws, two
  nested-mutation throws (dependencies.blocks, then merged_from /
  t3code_threads), and the LRU eviction test that asserts identity
  pre-fill, identity-still-served-mid-fill, and `!==` post-eviction with
  cache size held at the cap.

### Site 1: `src/skill-queue-registry.ts` — `cache: Map<string, SkillQueueEntry>`

The cache is a module-level `let cache: Map<string, SkillQueueEntry> | null`,
populated lazily by `buildRegistry()`. Each `SkillQueueEntry` has mutable
`args: string[]`, `defaults: Record<string, string>`, and
`requiredArgs: string[]` fields.

**Caller audit** (verify during implementation): the only public exports are
`resolveSkillCommand`, `hasRegisteredAction`, and `clearSkillQueueCache`.
`hasRegisteredAction` returns a boolean. `resolveSkillCommand` returns a
`string | null`. The `entry` value retrieved from the cache stays internal
to the function — it is read for `entry.requiredArgs`, `entry.args`,
`entry.defaults` (via `resolveArg`), and `entry.command`, then the function
builds and returns a fresh string. Callers in `src/mag.ts` (the only
non-test importer) consume only the resolved string.

If the audit confirms this, the freeze is academic. Document the skip and
move on. If a future caller surface returns `SkillQueueEntry` directly, that
PR will need to add the freeze; that is a separate concern.

### Site 2: `src/config.ts` — `_postponedProjectsCache` and `_priorityProjectsCache`

Both are module-level `Set<string> | null` singletons returned by
`postponedProjectSet()` and `priorityProjectSet()` respectively. The hazard
is structural: a singleton mutable `Set` exposed through getters means any
caller doing `postponedProjectSet().add("x")` permanently pollutes the
cache for the rest of the process.

Current callers (verify during implementation): `postponedProjectSet` is
called from `src/mag.ts` (twice) and `src/flow.ts` (once); all three call
sites use only `.has()`. `priorityProjectSet` is called from
`effectivePriority` in the same file, again only `.has()`. So the bug is
not live today, but the structural hazard remains.

**The Set-freeze gotcha is real**: `Object.freeze(set)` does **not** prevent
`.add()` or `.delete()` from mutating the set's backing store. Tests that
only do `expect(Object.isFrozen(s)).toBe(true)` would falsely pass while the
mutation still goes through. The retrofit must address this.

Acceptable strategies (pick one and apply to **both** sites):

1. **`ReadonlySet<string>` + `Proxy` mutator-trap.** Change the public
   return type of both functions to `ReadonlySet<string>`. Wrap the cached
   `Set` in a `Proxy` whose `get` trap throws (or returns an inert function)
   for `add`, `delete`, `clear`. TypeScript blocks the call at compile time,
   the Proxy blocks it at runtime.

2. **Frozen `readonly string[]`.** Change both functions' return type to
   `readonly string[]`. Construct via `Object.freeze([...set])`. Callers
   change from `.has(x)` to `.includes(x)` (worse asymptotic, but the sets
   are tiny). This trades ergonomics for simplicity.

Whichever is picked, do it the same way at both sites. The reviewer is the
right place to debate the choice.

### Site 3: `src/dashboard.ts` — `doctorCache`

Module-level `let doctorCache: { output: string; timestamp: string;
cachedAt: number } | null`, with TTL eviction at
`DOCTOR_CACHE_TTL = 300_000` ms (5 minutes). `_resetDoctorCache()` already
exists.

`generateHealthData` already returns a fresh shallow `{ output, timestamp }`
literal alongside `healthReport` — the cached record itself is never handed
to callers. Mutation hazard is muted; the freeze step is a documented skip.

The eviction test, however, is incomplete. The current "doctor cache
prevents re-spawn within TTL" test asserts only field equality
(`second.doctor.output === first.doctor.output`,
`second.doctor.timestamp === first.doctor.timestamp`). That passes whether
the cache is working or whether `doctor` shells out twice and happens to
return the same output (it does — it's a deterministic command in tests).
There is no assertion that the cached object was *replaced* on TTL expiry.

**TTL-clock translation of the LRU pattern.** Pick whichever is consistent
with existing test conventions in `src/dashboard.test.ts`:

- **Parameterized TTL via a module-level setter.** Add a test-only
  `_setDoctorCacheTtl(ms: number)` (underscore-prefixed, not re-exported via
  `index.ts`) that the test can drive. The test sets the TTL to a small
  value (e.g. 1 ms), reads twice with a `setTimeout` gap or a busy wait, and
  asserts the second read produces a record with a fresh `timestamp` —
  identity-equivalent for this cache, since `timestamp` is set inside the
  cache-miss branch.
- **Manipulate `doctorCache.cachedAt` via a test-only handle.** Add an
  underscore-prefixed `_setDoctorCacheCachedAt(epoch: number)` that the test
  uses to back-date the cache past the TTL boundary, then re-read.

The first option is cleaner (it tests the actual TTL gate). The second
option is a hair faster. Either is acceptable; reviewer can call it.

The new test asserts: pre-expiry identity is held (the second read returns
the same `timestamp`), post-expiry identity is broken (the third read
returns a different `timestamp`), mirroring `markdown.test.ts:583-680`'s
pre/post-eviction structure.

### Edge cases to remember during implementation

- `Object.isFrozen(x)` is shallow. Tests that assert immutability of nested
  containers must include explicit nested-mutation-throws assertions, not
  rely on `Object.isFrozen` alone.
- `Object.freeze` mutations throw `TypeError` only in strict mode. ESM
  modules and `bun test` are strict by default; this is fine.
- `Object.freeze` on a `Set` does not block `.add()` / `.delete()`. The
  config-site retrofit must use one of the two strategies above.
- Underscore-prefixed test-only exports (`_resetXCache`, `_xCacheSize`,
  `_setXTtl`) follow the convention from `markdown.ts`. They live next to
  the cache and are NOT surfaced via `src/index.ts`.

### Per-site judgment (locked-in user decision, 2026-04-29)

The user has explicitly opted into per-site judgment rather than a uniform
freeze policy. Each of the four sites either gets the retrofit (with
documented strategy and test) or a documented skip with rationale. The PR
description / audit summary records the per-site decision so a future
reader can see why a particular site was skipped.

### Co-located test files

- `src/skill-queue-registry.ts` → `src/skill-queue-registry.test.ts`
  (already exists). If the site is skipped, no test changes here.
- `src/config.ts` → no `src/config.test.ts` exists today. Create it for the
  retrofit's identity-based test (or co-locate in an adjacent test file —
  reviewer judgment).
- `src/dashboard.ts` → `src/dashboard.test.ts` (already exists, already has
  the `generateHealthData` describe block to extend).

## Scope

**In scope:**

- The four cache sites listed above and their tests.
- Test-only underscore-prefixed helpers needed by the new tests.
- A short audit summary recording the per-site decision (in code comments
  next to each cache declaration, or in the PR description).

**Out of scope:**

- Adding caches to sites that don't have one.
- Changing the cache policy (FIFO / TTL / LRU) at any site.
- Generalizing the pattern into a shared `freezeCache` utility — the
  per-site type differences (object vs. Set vs. TTL record) make a generic
  helper less readable than per-site freeze logic. (If a future site comes
  along and the pattern repeats meaningfully, factor then.)
- Documenting the meta-pattern in a separate memo. The original framing of
  gh-ludics-405 was a doc-only memo; that has been explicitly de-scoped in
  favor of this code audit (see task Context).
