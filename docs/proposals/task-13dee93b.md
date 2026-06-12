# Add `claude-fable` as a selectable high-end model class for coder/reviewer roles

## Goal

Let a user choose **Claude Fable** (`claude-fable-5`, the tier above Opus) as the
high-end model for an orchestration role (coder or reviewer), selectable from both
the dashboard role-switcher GUI and the harness config — without splitting the
`claude-code` provider.

"Fable" is a brand-new Claude model class that is **not guaranteed on subscription
plans**; it is **promotionally available until 2026-06-22**. The split should land
while Fable can be exercised in that promo window, so a user can A/B Opus vs. Fable
on real orchestration work before the promo expires.

Today `claude-code` is a single provider whose concrete model is effort-derived
(Opus for medium/large coders, Sonnet for tiny/small), and the user never names the
Claude model class directly. This task makes the high-end Claude class a first-class,
per-role user choice — `claude-opus` (current behaviour) vs. `claude-fable`.

Task: `task-13dee93b`. Builds on `task-c48b7beb` (latest-within-class model
resolution), `task-b43bd578` (dashboard model-role toggle), `task-1fbd4edf`
(configurable agent models).

## Acceptance Criteria

1. **`claude-fable` is a tracked model class.** `claude-fable` exists alongside
   `claude-opus`/`claude-sonnet` as a resolvable model class backed by the
   `mag.orchestration.model_classes` config table, resolving to `claude-fable-5`.

2. **Config seeds the new class atomically — no config throws.** Because adding a
   tracked class makes the throw-on-missing resolver fail for every config lacking
   the key, the change ships with `claude-fable: claude-fable-5` already present in
   **both** the harness `config.yaml` and `templates/config.reference.yaml`. After
   the change, a normal orchestration launch (any effort, any role) succeeds without
   a `model_classes.claude-fable is required` error.

3. **The high-end class is selectable per role from config.** A user can set, per
   role (coder and reviewer independently), whether the role's high-end (medium/large
   effort) Claude class is `claude-opus` or `claude-fable`, via a documented key in
   `mag.orchestration`. The default preserves today's behaviour (`claude-opus`).

4. **The high-end class is selectable per role from the dashboard.** The dashboard
   role-switcher GUI lets a user pick, for a `claude-code`-held role, between
   `claude-opus` and `claude-fable` for the high-end class. The choice persists to
   config (same source of truth as AC 3) and survives a dashboard reload.

5. **A Fable selection runs Fable on high-effort sessions.** When a role is configured
   for `claude-fable` and a **medium- or large-effort** session starts for that role,
   the launched agent runs `claude-fable-5`. Selecting `claude-opus` (or leaving the
   default) runs `claude-opus-4-8` exactly as today.

6. **The Sonnet low-effort override is unchanged.** The selection replaces **only**
   the high-end (medium/large) class. Tiny/small-effort `claude-code` agents still
   resolve to the Sonnet class regardless of the Opus/Fable choice; pilot/solo Sonnet
   suffixing is unaffected.

7. **No new provider.** `claude-code` remains the single Claude provider:
   `T3ProviderKind`, `AgentType`, the `PROVIDERS` constant, and the role-switcher's
   provider universe are unchanged. The Opus/Fable choice is a model-class sub-select,
   not a third `PROVIDERS` entry — the `PROVIDERS` lockstep sync test still passes
   unchanged.

8. **t3code and tmux stay consistent.** Both the t3code and tmux orchestration
   adapters resolve the same high-end class for a given role/effort/config, so a
   Fable selection takes effect identically on whichever adapter is active.

9. **Fable-unavailable fails loud.** When `claude-fable` is selected but the model is
   unreachable on the active plan (promo expired / not on the subscription), the
   session fails with a **clear, actionable hard error** telling the user to change
   the config to `claude-opus`. There is **no silent fallback** to Opus and the error
   names the config key to edit. (No pre-flight capability probe is required — a clear
   failure at launch / first-message time satisfies this.)

10. **State-migration test triple.** The config seeding (AC 2) ships with the standard
    state-migration test triple — positive backfill, negative control, and JSON/YAML
    round-trip — so `lint:state-migration` passes. Existing `model-defaults`,
    `orchestration-defaults`, and `PROVIDERS`-sync tests are updated to reflect the new
    tracked class and continue to pass.

## Context

How orchestration model selection works today (lukstafi/ludics):

- **Model classes vs. providers are orthogonal.** `TRACKED_MODEL_CLASSES` in
  `src/orchestration/model-defaults.ts` is `["codex", "claude-opus", "claude-sonnet"]`.
  `resolveModelClass(table, cls)` reads `mag.orchestration.model_classes.<cls>` and
  **throws loudly** when a tracked class is missing/blank/non-string (it is the single
  source of truth — no built-in fallback). `classForProvider(provider)` maps
  `codex → codex`, everything else (`claude-code`) → `claude-sonnet` (the generic
  default); effort-specific Opus selection happens later, not here.

- **Effort → class selection** lives in `selectOrchestrationFlags` in
  `src/adapters/t3code.ts`. For a `claude-code` coder it appends a model suffix:
  `classModel("claude-opus", orchCfg)` for `large`/`medium` effort, else
  `classModel("claude-sonnet", orchCfg)`. `tiny` (solo) and the `pilot` branch in
  `selectOrchestrationFlagsForTask` always suffix the Sonnet class. `classModel` calls
  `resolveModelClass`; `providerDefaultModel`/`classForProvider` give the generic
  non-effort default. `parseProviderToken` still accepts a raw `provider:model` token
  (e.g. `claude-code:claude-fable-5`) — the explicit-model path already works; this
  task is about the **named-choice** surface.

- **The config table** is `mag.orchestration.model_classes` in the harness `config.yaml`
  (`codex: gpt-5.5`, `claude-opus: claude-opus-4-8`, `claude-sonnet: claude-sonnet-4-6`)
  and documented in `templates/config.reference.yaml`. The role defaults
  (`default_coder`/`default_reviewer`) are provider names, not classes — there is no
  per-role *class* key today.

- **The provider universe** is `PROVIDERS = ["claude-code", "codex"]` in
  `src/orchestration-defaults.ts`, kept in lockstep with
  `templates/dashboard/role-switcher.js` (`export const PROVIDERS`) by the sync test in
  `src/orchestration-defaults.test.ts`. The role-switcher renders one `<select>` per
  role whose options are the providers; it persists `coder`/`reviewer` provider choices
  to config via the dashboard server (`src/dashboard-server.ts` role-switcher POST
  handler, exposed by `src/dashboard.ts`). The AC-13a asymmetry comment documents that
  the toggle deliberately defers an N≥3 provider extension.

- **tmux mirror.** `src/adapters/tmux-adapter.ts` has the parallel
  `agent.provider === "claude-code"` branch and calls `providerDefaultModel`; it must
  resolve the same high-end class so tmux orchestration matches t3code.

**Fable model facts** (verified against the claude-api skill): `claude-fable-5` is the
tier above Opus, served by the **same Claude Agent runner surface** as `claude-opus-4-8`
— same wire provider, same request shape — so no new provider/runner is needed. One
gotcha: an explicit `thinking: {type:"disabled"}` returns 400 for Fable (omit the field
rather than disabling it). The t3code Claude Agent runner abstracts the raw Messages API,
so this likely does not surface in ludics — but any `thinking`-config passthrough for the
Claude provider should be grepped during implementation.

**Deadline 2026-06-22** is the Fable promo expiry. If Fable becomes unavailable right as
or after this lands, AC 9's hard-error path is what keeps the harness usable — prioritize
it. Resolved decisions are recorded in `tasks/task-13dee93b.md` under
`## Resolved (2026-06-12, user)`.

## Approach

*Suggested approach — agents may deviate if they find a better path. The data model
(class not provider, high-end-only, hard-error) is user-resolved and is NOT open for
redesign; the concrete key names and wiring below are suggestions.*

1. **Tracked class + config seed (atomic).** Add `claude-fable` to
   `TRACKED_MODEL_CLASSES`. In the **same change**, add `claude-fable: claude-fable-5`
   to `mag.orchestration.model_classes` in the harness `config.yaml` and
   `templates/config.reference.yaml`, so the throw-on-missing resolver never fires for
   an existing config. Ship the state-migration test triple for the seeding.

2. **Per-role high-end class config keys.** Introduce per-role keys under
   `mag.orchestration` (suggested: `coder_class` / `reviewer_class`, valid values
   `claude-opus` | `claude-fable`, default `claude-opus`) capturing which high-end
   Claude class each role uses. Keep them independent of `default_coder`/`default_reviewer`
   (those stay provider names). Document the keys in `config.reference.yaml`.

3. **Apply the choice in the effort→class block.** In `selectOrchestrationFlags`
   (and the tmux mirror), where the `claude-code` coder currently hard-codes
   `classModel("claude-opus", …)` for medium/large, resolve the class from the role's
   configured high-end choice instead — falling back to `claude-opus`. Leave the Sonnet
   branch (tiny/small + pilot/solo) untouched. Mirror for the reviewer role wherever its
   high-end model is resolved.

4. **Dashboard sub-select.** Extend the role-switcher so a `claude-code`-held role
   exposes an Opus/Fable high-end choice, persisting through the existing role-switcher
   POST handler into the AC-2 config keys. Do **not** add `claude-fable` (or
   `claude-opus`) to `PROVIDERS` — the provider universe and its sync test stay
   unchanged; this is a sub-select layered on the provider select.

5. **Fable-unavailable hard error.** When a Fable-selected session fails to launch /
   first-message because the model is unreachable, surface a clear hard error that names
   the config key to switch to `claude-opus`. No silent fallback. During implementation,
   grep for any `thinking` passthrough on the Claude provider path and ensure no explicit
   `thinking:{type:"disabled"}` is sent for Fable.

6. **Build/test hygiene.** After code changes run `bun run build; ludics init
   --no-triggers`. Update `model-defaults`/`orchestration-defaults`/`PROVIDERS`-sync
   and any role-switcher tests.

## Scope

**In scope:** `claude-fable` as a tracked, config-backed model class; per-role high-end
class selection in config and the dashboard role-switcher; effort→class application on
both t3code and tmux adapters (high-end/medium-large only); hard-error handling when
Fable is unavailable; config seeding with migration test triple; test updates.

**Out of scope:**
- Any new provider / `T3ProviderKind` / `AgentType` / `PROVIDERS` entry, or a new agent
  runner backend (Fable runs on the existing Claude Agent surface).
- Changing the tiny/small Sonnet default or the pilot/solo Sonnet suffix.
- The raw `--coder`/`--reviewer` `provider:model` token path (already supports an explicit
  `claude-fable-5`).
- A pre-flight capability probe for Fable availability (explicitly not required —
  launch-time failure is sufficient).
- The actual code implementation lands later via a fix worktree + PR; this document is
  the planning artifact only.

**Dependencies:** builds on completed `task-c48b7beb`, `task-b43bd578`, `task-1fbd4edf`;
relates to `task-1fbd4edf`, `task-b43bd578`, `task-c48b7beb`.
