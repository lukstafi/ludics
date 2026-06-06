# Resolve orchestration default models to latest-within-class

## Goal

Orchestration sessions that start with no explicit model silently inherit
hardcoded minor-version pins in `src/adapters/t3code.ts`. These go stale as new
minors ship: a slot was observed running the reviewer on `gpt-5.4` (latest is
GPT-5.5) and the coder on `claude-opus-4-6` (latest Opus is 4.8). Because the
default path (`--pair --coder claude-code --reviewer codex`, no explicit model)
is the common path, every unspecified session runs a 1–2-version-old model until
someone remembers to bump the constants.

A plain bump just re-pins to the next soon-to-be-stale string. The deliverable
is a *resolution mechanism*: a single per-class "latest" table in the global
`config.yaml`, so future staleness is a one-line config edit, not a code change.
This is the default-resolution complement to `task-1fbd4edf` (which made the
models configurable but left the underlying defaults pinned).

## Acceptance Criteria

- Orchestration sessions started with no explicit model resolve each role's
  model to the *latest* member of its class as named in the config table:
  - codex role → latest GPT-5 (`gpt-5.5`),
  - claude-opus role (medium/large coder) → latest Opus 4 (`claude-opus-4-8`),
  - claude-sonnet role (tiny/small coder, and the sonnet fallback) → latest
    Sonnet 4 (`claude-sonnet-4-6`).
  Verifiable on a running slot via `ludics orch status <slot>` (the resolved
  per-agent model is recorded in orchestration/slot state), and via unit tests
  over `selectOrchestrationFlags` / the model-resolution path.

- The per-class latest mapping lives in the global config file (`config.yaml`,
  under `mag.orchestration`) as the single source of truth. Bumping a class is
  a config edit, not a code change. No per-class concrete version strings remain
  hardcoded in `src/adapters/t3code.ts`; the code resolves each default by
  reading the config table.

- A test fails loudly if a tracked class (`codex`, `claude-opus`,
  `claude-sonnet`) has no resolved model in the config table — i.e. the table is
  missing the key, or holds an empty/blank value.

- Explicit overrides from `task-1fbd4edf` still win over the resolved default,
  with no regression in precedence order: adapter-arg flag
  (`--coder-model` / `--reviewer-model`) > explicit model in a
  `--coder`/`--reviewer` provider token > `mag.orchestration.coder_model` /
  `reviewer_model` config > the new latest-within-class table > provider's own
  default. Covered by tests asserting each tier wins over the ones below it.

- The stale pins are gone or routed through the config resolver:
  `grep -rn 'gpt-5\.4\|claude-opus-4-6' src/` returns nothing in non-test code
  (the concrete versions live only in the config table / reference YAML).
  The fallback provider tokens (`"coder:codex:gpt-5.4"` /
  `"reviewer:codex:gpt-5.4"`) and the constants `DEFAULT_MODEL`,
  `DEFAULT_CLAUDE_MODEL`, `CLAUDE_OPUS_MODEL` are removed or sourced from the
  resolver. (Test fixtures and the comment at the codex-default note may retain
  literal versions; production code paths must not.)

- The new config key is documented in `templates/config.reference.yaml` (and the
  matching TS interface / adapter-read path) so `lint:config-reference` passes —
  the reference-vs-code drift lint treats an undocumented `mag.orchestration.*`
  leaf, or one with no adapter read site, as an error.

- A short doc/comment states how to bump the table when a new minor ships, so
  the next staleness is a known, cheap, code-free operation.

## Context

All current pins are in `src/adapters/t3code.ts`:

- `DEFAULT_MODEL = "gpt-5.4"` and `DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6"`
  (module top). `DEFAULT_MODEL` is the codex/global default used by
  `parseProviderToken` (single-token branch), `parseOrchestrationAdapterArgs`
  (`parsed.model` initial value), `startSingleThread`
  (`defaultModelSelection`), `ensureThread` (model fallback), and
  `buildOrchestratedDesiredThreadConfig` (line ~1017). `DEFAULT_CLAUDE_MODEL` is
  the claude-code provider default and the tiny/small coder suffix.
- `CLAUDE_OPUS_MODEL = "claude-opus-4-6"` — the medium/large coder model suffix
  in `selectOrchestrationFlags`.
- Fallback provider tokens `"coder:codex:gpt-5.4"` / `"reviewer:codex:gpt-5.4"`
  in `parseOrchestrationAdapterArgs` (pair-mode default agents).
- A comment notes codex "picks gpt-5.4" as its own CLI default when no model is
  passed.

The three "classes" map onto the two providers plus the coder effort tier:
`codex` (GPT-5.x), `claude-opus` (Opus 4.x, used for medium/large coders), and
`claude-sonnet` (Sonnet 4.x, used for tiny/small coders and the claude-code
provider default). Provider ≠ class: `claude-code` resolves to either the opus
or sonnet class depending on effort, in `selectOrchestrationFlags`.

The model-resolution precedence already exists in `resolveAgentModel`
(`src/adapters/t3code.ts`, duplicated in `src/adapters/tmux-adapter.ts`): flag
override → explicit token model → `coder_model`/`reviewer_model` config →
provider default. The new table slots in *below* the config per-role override
and *above* the provider's own default — it supplies what the pinned constants
supply today.

Config plumbing: `loadConfigSync` (`src/config.ts`) parses `config.yaml` and
exposes `mag` as a freeform record; `loadConfigOrchestration` in
`t3code.ts`/`tmux-adapter.ts` reads `mag.orchestration`. `config.yaml`'s
orchestration block currently holds `default_mode`, `default_coder`,
`default_reviewer`, `coder_model`, `reviewer_model`, `coder_effort`,
`reviewer_effort`, `phase_timeouts`, `substantive_stall`. The reference schema
is `templates/config.reference.yaml`; `scripts/lint-config-reference.ts`
enforces that every documented `mag.orchestration.*` leaf has an adapter read
site and that the reference matches the TS interfaces in `src/config.ts`.

Existing tests that pin literal versions and will need updating:
`src/adapters/t3code.test.ts` (tiny-effort asserts `:claude-sonnet-4-6`;
several fixtures use `gpt-5.4`/`claude-opus-4-6`) and
`src/adapters/tmux-adapter.test.ts`. The constant-sync style is established by
`src/orchestration-defaults.test.ts`; the lint-script + companion `.test.ts`
pattern is established across `scripts/lint-*.ts`.

The lint scripts referenced (`lint:config-reference`, etc.) are wired in
`package.json`'s `scripts` block.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add a `model_classes` map under `mag.orchestration` in the global config,
   keyed by the three class names with concrete latest versions:

   ```yaml
   model_classes:        # latest-within-class defaults; bump a value when a new minor ships
     codex: gpt-5.5
     claude-opus: claude-opus-4-8
     claude-sonnet: claude-sonnet-4-6
   ```

   Document it in `templates/config.reference.yaml`, `templates/harness/config.yaml`
   (or the harness `config.yaml`), and the TS config interface so
   `lint:config-reference` stays green. The doc comment is the "how to bump"
   note required by the last AC.

2. Add a resolver (e.g. `resolveClassModel(class, orchCfg)` in `t3code.ts`, or a
   shared helper consumed by both adapters) that reads the table and throws /
   surfaces a loud error when the class key is absent or blank. Replace the
   three constants and the two fallback tokens with calls through this resolver:
   - `DEFAULT_MODEL` → `resolveClassModel("codex", …)`
   - `DEFAULT_CLAUDE_MODEL` → `resolveClassModel("claude-sonnet", …)`
   - `CLAUDE_OPUS_MODEL` → `resolveClassModel("claude-opus", …)`
   - the `"coder:codex:gpt-5.4"` / `"reviewer:codex:gpt-5.4"` fallback tokens →
     build the codex token from the resolved codex-class model.

   Keep `resolveAgentModel`'s precedence intact; the table is the new lowest
   tier above the provider default, replacing what the constants returned.

3. Add the loud-failure test (a tracked class missing from the table → the
   resolver throws / the orchestration-flag selection fails with a clear
   message), mirroring the constant-sync test style. Decide whether to also add
   a `scripts/lint-*.ts` grep guard that forbids literal minor-version strings
   in non-test `src/` code (parallels `lint:state-migration`); a unit test over
   the resolver plus the existing `lint:config-reference` may suffice — the
   reviewer can weigh whether the extra lint earns its keep.

4. Update the fixtures in `t3code.test.ts` / `tmux-adapter.test.ts` that assert
   the old literal versions to read from / match the resolved table.

Note for the implementer on resilience: the resolver must handle a config where
the table is entirely absent (older harness checkouts). The AC says the *test*
fails loudly when a tracked class is unset; at runtime, decide deliberately
between (a) a hard throw — surfaces staleness immediately, consistent with
"fail loud", or (b) a built-in fallback constant. The task framing ("a test
fails loudly when a class is unset") leans toward (a) for the test while a
narrow built-in last-resort default avoids bricking a slot on a malformed
config; this is a small design call for the plan phase.

## Scope

In scope:
- The per-class `model_classes` table in `config.yaml` + reference + TS interface.
- Routing the three pinned constants and two fallback tokens through a resolver.
- Loud-failure test for an unset tracked class.
- Updating existing tests/fixtures that pin literal versions.
- A "how to bump" doc/comment.

Out of scope (per task Questions):
- Runtime auto-tracking / querying providers for available models (approach C —
  rejected: no network call at thread-start).
- Class-alias passthrough that defers to the CLI's own latest (approach A —
  rejected as the sole mechanism; the table is the source of truth).
- Additional provider classes beyond the three (e.g. a Cursor provider per
  `gh-agent-duo-48`) — build the table so adding a class later is a config edit,
  but do not add non-existent classes now.
- `max_model` / denylist safety valve — the existing per-task / per-project /
  adapter-arg override from `task-1fbd4edf` is the escape hatch.
- The dashboard model-role toggle (`task-b43bd578`) and per-task/per-project
  model overrides (`task-1fbd4edf`, already shipped).

Relates to: `task-1fbd4edf` (configurability half; done).
