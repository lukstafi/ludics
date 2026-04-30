# Sub-command CLI drift: lint sub-dispatchers + registry refactor for `runMag`

## Goal

Close the silent-drift gap where adding a new sub-command (e.g. `mag <new-sub>`)
requires three coordinated edits — a `case` in the dispatcher, a USAGE line in
`src/index.ts`, and the literal listing in the dispatcher's `default` clause —
none of which are currently caught by `lint:cli-readme`. The third edit (the
literal listing) drifts silently: typecheck stays green even when the
user-facing help text lies. The `runMag` listing on `main` already drifts today
(`analyze` is listed but has no `case`; `auto-start-evaluate` and
`revise-proposal` have cases but are missing from the listing).

In addition, eliminate the vestigial `"ludics ${cmd}: not yet migrated"` error
at the top-level dispatcher in `src/index.ts` — every command in `USAGE` is
already wired through `MIGRATED_COMMANDS`, so the message is misleading for any
unrecognized command (typo, deprecated alias, future addition not yet wired).

Issue: https://github.com/lukstafi/ludics/issues/438

## Acceptance Criteria

1. **New lint script** (e.g. `scripts/lint-cli-subcommands.ts`) runs as part of
   `bun run lint` (or whichever umbrella npm/bun script aggregates lints today)
   and fails CI with a non-zero exit when any of the following invariants are
   violated for the **9 covered sites**:
   - 8 sub-dispatchers: `runMag` (`src/mag.ts`), `runFlow` (`src/flow.ts`),
     `runTasks` (`src/tasks/index.ts`), `runTriggers` (`src/triggers.ts`),
     `runNotify` (`src/notify.ts`), `runCluster` (`src/cluster.ts`),
     `runDashboard` (`src/dashboard.ts`),
     `runOrchestrationCli` (`src/orchestration/index.ts`).
   - 1 top-level dispatcher: the `MIGRATED_COMMANDS`-driven `main` in
     `src/index.ts`.

   For each site the lint enforces `cases ≡ USAGE-subs ≡ default-listing` (set
   equality, modulo a documented allow-list of canonical/alias pairs).

2. **Allow-list constant** in the lint script names every legitimate
   canonical/alias pair currently in the codebase, e.g.:
   - `runTriggers`: `pause` ↔ `disable`, `status` ↔ `""` (empty default).
   - `runCluster`: `status` ↔ `""`.
   - `runOrchestrationCli`: `status` ↔ `""` (default).
   - `runNotify`: `outgoing` ↔ `pai`.
   - Top-level: `orch` ↔ `orchestration`.
   - `runMag`: `queue-pop` (deprecated alias of `on-stop`) — exact mapping per
     comment at the case site.
   Aliases listed here may legitimately be missing from USAGE/listing as long
   as the canonical name is present.

3. **Canonical default-case format**: every covered site emits a default-case
   error matching the regex
   `unknown <prefix> command: \$\{<var>\} \(use: <comma-separated list>\)`
   (e.g. `"unknown mag command: ${sub} (use: a, b, c)"`). Outliers patched as
   part of this PR:
   - `runOrchestrationCli` currently throws `"unknown orch subcommand:
     ${sub}"` with no listing — gains the canonical listing.
   - `src/index.ts` line ~389 currently does
     `console.error(\`ludics ${cmd}: not yet migrated\`); process.exit(1)` —
     replaced with `throw new Error(\`unknown ludics command: ${cmd} (use:
     …)\`)` (or equivalent `console.error` + `exit(1)` in the same canonical
     shape, whichever the rest of the file convention prefers — see Approach).
   - `runTasks` uses `unknown tasks subcommand:` (singular "subcommand"
     — preserve as-is; the lint regex accepts both "command" and "subcommand"
     after the prefix).

4. **`runMag` registry refactor**: `runMag` in `src/mag.ts` is rewritten so the
   listing in the `default` clause is **derived** from the registry rather
   than hand-maintained. Concretely, the ~25 `case` clauses migrate to a
   `Record<string, MagSubHandler>` (or `Map`) whose keys feed both the
   dispatch and the `(use: …)` string. After this refactor, adding a new
   `mag <new-sub>` requires touching exactly one place in `runMag` (plus the
   USAGE line — which the new lint catches if missed).

   Other 7 sub-dispatchers and the top-level dispatcher are **not** refactored
   to a registry in this PR — they remain `switch`-shaped and are protected by
   the lint instead. (The top-level dispatcher already uses
   `MIGRATED_COMMANDS`, so its listing can also be derived; doing so as part
   of fixing the "not yet migrated" bug is in-scope.)

5. **`runMag`'s drifted listing is fixed as a side effect** of the registry
   refactor — `analyze` removed from the listing (or a `case "analyze"` added
   if the user intends one — see Scope), `auto-start-evaluate` and
   `revise-proposal` automatically appear in the derived listing.

6. **Floor-count meta-test** on the new extractor (matching the convention
   established by gh-ludics-406): the lint's test file asserts
   `extractedCases.size >= <floor>` for at least one of the 9 sites (likely
   `runMag` as the largest), so a future DRY refactor that collapses the
   `case` literals (e.g. moving them into a generated table) trips the test
   instead of silently passing. If gh-ludics-406 has shipped a shared
   floor-count helper by the time 438's implementation starts, the new
   extractor consumes it.

7. **Test coverage** for the new lint at `scripts/lint-cli-subcommands.test.ts`
   (or co-located with `lint-cli-readme.test.ts` if the conventions differ
   between scripts):
   - Unit tests for the per-site extractor (cases, USAGE-subs, listing) using
     small fixture strings.
   - Integration test that runs against the real `src/` (smoke test — should
     pass after the registry refactor and outlier patches land).
   - At least one negative fixture per invariant (case missing from USAGE,
     case missing from listing, listing entry with no case, alias outside the
     allow-list).

8. **The new lint runs in `lint:cli-readme`'s sibling slot** — i.e. it's wired
   into whatever umbrella script CI uses for lints today, with a name like
   `lint:cli-subcommands` (so a CI failure points cleanly at the right
   surface).

## Context

### Current state on `main`

- **`runMag` (`src/mag.ts`)**: ~25 `case` clauses (lines ~3414–3722).
  `default` at ~3725 throws with a hand-maintained literal listing. Verified
  drift on `main` (extractor diff over the function body):
  - In cases not in listing: `auto-start-evaluate`, `revise-proposal`.
  - In listing not in cases: `analyze` (genuine drift),
    `queue pop one`, `queue pop all` (these are *nested* — first-level case
    is `queue`, the inner dispatch is hand-rolled with its own
    `(use: pop one, pop all, promote <id>, cancel <id>)` listing inside the
    `queue` case body — see Scope for nested handling).

- **`runFlow` (`src/flow.ts`)**: 6 cases (`ready`, `blocked`, `critical`,
  `impact`, `context`, `check-cycle`). Listing matches.

- **`runTasks` (`src/tasks/index.ts`)**: ~17 cases. Listing currently misses
  `queue-elaborations` (verified — `case "queue-elaborations"` exists at line
  ~713 but the `(use: …)` string at line ~789 doesn't list it). Another live
  drift this PR fixes as a side effect.

- **`runTriggers` (`src/triggers.ts`)**: cases `install`, `pause`, `disable`,
  `uninstall`, `status`, `""`. Listing has `install, pause, uninstall,
  status` — `disable` and `""` are aliases.

- **`runNotify` (`src/notify.ts`)**: cases `outgoing`, `pai`, `agents`,
  `proposal`, `subscribe`, `recent`. Listing has `outgoing, agents, proposal,
  subscribe, recent` — `pai` is alias of `outgoing`.

- **`runCluster` (`src/cluster.ts`)**: cases `status`, `""`, `tick`,
  `heartbeat`, `ping`. Listing matches modulo the `""` alias.

- **`runDashboard` (`src/dashboard.ts`)**: cases `generate`, `serve`,
  `install`, `stop`, `restart`. Listing matches.

- **`runOrchestrationCli` (`src/orchestration/index.ts`)**: cases `status`,
  `confirm`, `interrupt`, `skip`, `log`, `diff`, `run-internal`, `on-stop`.
  Listing currently empty — `default` throws
  `"unknown orch subcommand: ${sub}"`. Patch: add the canonical
  `(use: status, confirm, interrupt, skip, log, diff, on-stop)` listing.
  (`run-internal` is an internal entrypoint invoked only by the orchestrator
  runner self-relaunch — exclude from the public listing; document via
  allow-list comment.)

- **Top-level `src/index.ts`**: `MIGRATED_COMMANDS` keys (verified at lines
  26–101): `sessions`, `slots`, `slot`, `tasks`, `flow`, `mag`, `notify`,
  `dashboard`, `network`, `cluster`, `triggers`, `stop`, `init`, `quote`,
  `config`, `events`, `t3code`, `tmux`, `orch`, `orchestration`, `sync`,
  `state`, `journal`, `status`, `briefing`, `doctor`, `queue`. The `main`
  function at lines ~376–392 has a fallthrough that prints
  `"ludics ${cmd}: not yet migrated"` and exits 1 — vestigial; every USAGE
  command is wired. Replace with the canonical
  `"unknown ludics command: ${cmd} (use: …)"` shape.

### Existing precedents

- **`scripts/lint-cli-readme.ts`** (the precedent): top-level extractor with
  `extractUsageBlock`, `extractUsageCommands` (regex `^\s{1,4}([a-z][\w-]*)\b`
  scoped to the `USAGE` template literal), and `lintCliReadme`. Uses a
  backtick-aware regex to avoid the bug from gh-ludics-431. The new lint
  reuses `extractUsageBlock`'s shape and adds a per-prefix variant.
- **`scripts/lint-template-safety.test.ts:569–602`**: the canonical
  floor-count meta-test pattern. The new extractor's test should mirror it.
- **gh-ludics-406** (status: `ready`, blocking dependency for this work):
  ships floor-count assertions across the four existing regex extractors.
  When 406 lands, it may build a shared `expectExtractorFloor(set, label,
  floor)` helper or similar — 438's new extractor should consume it. If 406
  ships only the in-line `expect(set.size).toBeGreaterThanOrEqual(N)` form,
  438 follows the same shape inline.
- **Top-level `commandTable` precedent**: `MIGRATED_COMMANDS` in
  `src/index.ts:26` is the working example of the registry pattern that
  `runMag` will adopt — same `Record<string, (args: string[]) => Promise<void>>`
  signature.

### Why this is not a duplicate of gh-ludics-406

- 406: regex-source extractors going *empty* after DRY refactors → fix is
  floor-count assertions on existing extractors.
- 438: `lint:cli-readme` doesn't even *attempt* to look at sub-commands → fix
  is a new extractor (sub-command surface) plus a registry refactor for
  `runMag` to eliminate the drift class at its largest source.

The new extractor in 438 is itself a regex-source extractor, so it adopts
406's floor-count convention from day one — both as the 5th covered extractor
and as part of 406's broader floor-count net. (See `blocked_by` below.)

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Phase 0: confirm gh-ludics-406 is merged

If 406 has not yet landed by the time implementation starts, **do not start**
— wait for the merge. 438's lint extractor consumes 406's floor-count
helper/convention, and merging in the wrong order risks duplicating the
helper or merge conflicts in `scripts/` test fixtures. (See `blocked_by` in
frontmatter.)

### Phase 1: normalize default-case format across the 9 sites

Touch the **outliers only** (no behavior change for compliant dispatchers):

- `src/orchestration/index.ts`: change line ~198 from
  `throw new Error(\`unknown orch subcommand: ${sub}\`);` to
  `throw new Error(\`unknown orch subcommand: ${sub} (use: status, confirm, interrupt, skip, log, diff, on-stop)\`);`
- `src/index.ts`: replace the `console.error(\`ludics ${cmd}: not yet
  migrated\`); process.exit(1)` block at lines ~388–390 with
  `throw new Error(\`unknown ludics command: ${cmd} (use: ${Object.keys(MIGRATED_COMMANDS).sort().join(", ")})\`);`
  *(or, if convention prefers `console.error`+`exit(1)` here, use that —
  match the file's existing error-emission style; the lint matches both
  `throw new Error` and `console.error` arguments structurally on the
  literal-template-string body)*. Deriving the listing from
  `Object.keys(MIGRATED_COMMANDS)` makes this dispatcher trivially
  drift-proof — the lint still validates the keys against USAGE-subs.

### Phase 2: registry refactor for `runMag`

Rewrite `runMag` so the cases live in a `Map<string, MagSubHandler>`
(insertion order preserved) where:

```ts
type MagSubHandler = (args: string[]) => Promise<void> | void;

const magSubcommands: ReadonlyMap<string, MagSubHandler> = new Map([
  ["start",                     async (_args) => magStart()],
  ["stop",                      async (_args) => magStop()],
  ["status",                    async (_args) => magStatus()],
  ["attach",                    async (_args) => magAttach()],
  ["logs",                      async (args)  => { /* ... */ }],
  // ... etc.
  ["queue",                     queueDispatcher],   // nested dispatch — inner switch stays
  ["queue-pop",                 queuePopHandler],   // deprecated alias of on-stop
  ["on-stop",                   onStopHandler],
  // ... etc.
]);

export async function runMag(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  const handler = magSubcommands.get(sub);
  if (!handler) {
    const listing = [...magSubcommands.keys()].join(", ");
    throw new Error(`unknown mag command: ${sub} (use: ${listing})`);
  }
  await handler(args.slice(1));
}
```

Notes:
- **Lazy imports** inside cases (e.g. `await import("./queue.ts")`) move into
  the corresponding handler closure unchanged — the registry preserves the
  laziness boundary.
- **Heterogeneous bodies** (some cases destructure args inline, some throw on
  missing args, some pass through args verbatim) all conform to
  `(args: string[]) => Promise<void>`; arg-parsing stays inside each handler.
- **Nested dispatch** (`queue`'s pop/promote/cancel) stays as-is — the inner
  switch is small (4 sub-commands), and the lint's scope is explicitly
  first-level only (see Scope). If the user wants the inner `queue` dispatch
  also registry-shaped, that's a follow-up — flag in PR description but do
  not expand scope here.
- **Drifted listing entries are fixed mechanically**: `analyze` is dropped
  from the listing because it has no handler in the registry;
  `auto-start-evaluate` and `revise-proposal` appear automatically.

### Phase 3: write the new lint

Create `scripts/lint-cli-subcommands.ts` mirroring `lint-cli-readme.ts`'s
shape:

```ts
interface DispatcherSite {
  file: string;          // e.g. "src/mag.ts"
  prefix: string;        // e.g. "mag" (used in error string + USAGE block)
  fnName: string;        // e.g. "runMag" — used to scope case-extraction to the function body
  // For the registry-shaped runMag and the top-level src/index.ts (post-Phase 1):
  // optional `registryName` so the lint can also accept Map/Record literals.
}

const DISPATCHERS: ReadonlyArray<DispatcherSite> = [ /* 9 entries */ ];

const ALIASES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  triggers:  [["pause", "disable"], ["status", ""]],
  cluster:   [["status", ""]],
  orch:      [["status", ""]],
  notify:    [["outgoing", "pai"]],
  ludics:    [["orch", "orchestration"]],   // top-level
  mag:       [["on-stop", "queue-pop"]],
};

// Per-site invariants:
//   cases       — { case "X": } strings inside fnName's body, OR keys of
//                 a Map/Record literal if the dispatcher uses the registry
//                 pattern (matched by registryName).
//   usageSubs   — `^\s+<prefix>\s+([\w-]+)\b` over USAGE block.
//   listing     — split-on-comma of the (use: …) capture from the default
//                 throw inside fnName's body.
//
// Assert (cases ≡ usageSubs ≡ listing) modulo aliases; emit set-difference
// errors with site labels.
```

Minor regex notes:
- Use `extractUsageBlock` from `lint-cli-readme.ts` — extract to a shared
  module (or re-import) rather than duplicating the backtick-aware regex.
- Function-body scoping: find `function fnName` (or `const fnName = `) and
  walk balanced braces. Brace-counter is enough — no AST needed.
- The same regex catches both `throw new Error(\`...\`)` and
  `console.error(\`...\`)` patterns (capture the inside of the backticks).
- Floor-count: `expect(extractCases("src/mag.ts", "runMag").size).toBeGreaterThanOrEqual(20)`
  (current count is 25 — leave slack for normal additions/removals).
  If gh-ludics-406 builds a shared helper, prefer it.

### Phase 4: tests

`scripts/lint-cli-subcommands.test.ts`:
- Unit tests with small in-memory fixtures (one per extractor function:
  `extractCasesFromFn`, `extractListingFromFn`, `extractUsageSubcommands`).
- One per-invariant negative test (case missing from USAGE / listing,
  listing entry with no case, alias outside allow-list).
- Integration test against the real `src/` — passes after Phases 1+2 land.
- Floor-count meta-test on at least the `runMag` extractor.

### Phase 5: wire into CI

Add `lint:cli-subcommands` to `package.json` scripts (parallel to
`lint:cli-readme`). Ensure the umbrella `lint` script (or whatever CI runs)
includes it.

## Scope

**In scope:**
- All 9 sites listed in Acceptance Criteria #1.
- Default-case format normalization (Phase 1) for outliers
  (`runOrchestrationCli`, top-level `src/index.ts`).
- `runMag` registry refactor (Phase 2) — `runMag` only.
- New lint script + tests + CI wiring (Phases 3–5).
- Side-effect fixes to drifted listings on `main` (`runMag`'s `analyze`
  entry, `runMag`'s missing `auto-start-evaluate`/`revise-proposal`,
  `runTasks`'s missing `queue-elaborations`).
- Floor-count assertion on the new extractor (consuming gh-ludics-406's
  helper if one exists by then).

**Out of scope:**
- **Nested sub-dispatches** (e.g. `queue pop one|all`,
  `queue promote <id>`, `queue cancel <id>` inside `runMag`'s `queue` case).
  The hand-rolled inner listing inside the `queue` case body stays
  hand-maintained — nesting is rare enough that a regex-shape lint over
  nested cases would need a real parser.
- **Registry refactor for the other 7 sub-dispatchers**. They are
  lint-protected only. The hybrid is the explicit user choice (Q1: lint
  across all 8, registry refactor only for `runMag`).
- **`runMag`'s `analyze` case**: the listing claims it but no case exists.
  Default behavior in this PR: drop from listing. If `analyze` is meant to
  be a real handler (the elaboration mentions a coder ran a "duo analyze"
  flow at some point), file a follow-up — do not invent the handler here.
- **AST-based extraction** (alternative to regex). Deferred — same rationale
  as gh-ludics-406's deferral.
- **`run-internal` exposure**: `runOrchestrationCli`'s `run-internal` is an
  internal self-relaunch entrypoint, not a user-facing command. Add to the
  allow-list (or exclude via comment in the registry) — do not list in the
  user-facing `(use: …)` string.

**Dependencies:**
- `blocked_by: gh-ludics-406` — wait for 406 to merge before starting
  implementation. The proposal is drafted now and queued to start
  immediately on 406's merge.
- `relates_to: task-44a074da` (top-level CLI surface — already merged;
  precedent for the lint-cli-readme infrastructure this proposal extends).
