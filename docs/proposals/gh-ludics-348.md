# Dashboard shadow terminal labels — consolidate to a single terminalLinks field

## Goal

Fix [gh-ludics-348](https://github.com/lukstafi/ludics/issues/348): every
active slot tile currently renders each orchestration link twice — once as a
real clickable `<a class="link-t3code">` (from `slot.t3codeThreadLinks`) and
again immediately afterward as a gray, non-clickable
`<span class="terminal-label">` (from the `slot.terminals` fallback). Example
on a tile with an active tmux session:

```
[issue] [PR] [proposal] [coder] [reviewer] [coder] [reviewer]
```

The user picked the structural fix (option 3 from the issue body): consolidate
to a single authoritative field rather than papering over the shadow with a
one-line JS guard. This removes a latent data-shape hazard and cuts dead code
(a markdown parser and ttyd-session enrichment loop whose output is never
consumed in a user-visible way).

## Acceptance Criteria

- On a slot tile with an active backend, orchestration links (`coder`,
  `reviewer`, …) render exactly once — as clickable `<a>` tags. No gray
  `terminal-label` spans appear next to them.
- The dashboard slot JSON exposes a single field, `terminalLinks`, populated
  from orchestration state for both backends:
  - tmux: synthesized `http://<host>:<7681 + (slot-1)*2 + roleIndex>` URLs
    (as today for `t3codeThreadLinks`).
  - t3code: thread URLs of the form `<t3codeWebUrl>/<encoded-threadId>` (as
    today for `t3codeThreadLinks`).
- `slot.terminals` no longer appears in the emitted JSON, and no code path in
  `src/dashboard.ts` parses the slot record's Terminals markdown section into
  the slot JSON.
- The slot records themselves (`slot-N.md`) still contain the Terminals
  markdown section for human-readable diagnostics — adapter `readState`
  functions are unchanged.
- The top-level `terminals.json` produced by `generateTerminals` is unchanged
  (unrelated index used by the separate terminals page).
- `bun test` passes; `bun run build` succeeds; dashboard renders correctly
  against real slot state after the change.

## Context

All code anchors below are stable symbols; exact line numbers drift as other
PRs land.

### Files in scope

- **`src/dashboard.ts`**
  - `SlotJson` interface — declares both `terminals` and `t3codeThreadLinks`.
  - `lookupSlotOrchestrationLinks` — builds `t3codeThreadLinks` from
    orchestration state (authoritative for both backends; does **not** read
    the slot record's Terminals section).
  - `generateSlots` — reads `data.terminals` (the slot record's markdown
    Terminals section), parses it with `/^- ([^:]+):\s*(.+)$/`, runs an
    enrichment loop that tries to upgrade non-URL values by cross-referencing
    `ttydBySession` (from `discoverTtydUrls()`), then emits the result as
    `terminals` in the slot JSON.
  - `discoverTtydUrls` — helper that `pgrep`s for ttyd processes and maps
    tmux session names to URLs. Only caller is `generateSlots`; becomes dead
    code once the enrichment loop is removed.
- **`templates/dashboard/dashboard.js`**, `renderSlots` — builds the link
  strip in two loops. First loop iterates `slot.t3codeThreadLinks` and emits
  real `<a class="link-t3code">`. Second loop iterates `slot.terminals` and,
  on the non-URL branch, emits the shadow `<span class="terminal-label">`.
- **`src/dashboard.test.ts`** — currently has no assertions on the
  `terminals` or `t3codeThreadLinks` fields, so no JSON-shape expectations
  need updating. (The task elaboration mentioned updating these, but a grep
  of the test file confirms no such assertions exist. A small regression
  test could be added but is not strictly required.)

### Out of scope / retained

- **Terminals markdown section in slot records (`slot-N.md`)** — produced by
  `src/adapters/tmux-adapter.ts` `readState` (lines like
  `` `${agentName}: ttyd pid ${pid} (${alive ? "alive" : "dead"})` ``) and
  the equivalent in `src/adapters/t3code.ts` `readState`. Kept for
  human-readable diagnostics when reading slot records manually. Still
  consumed by `src/slots/migration.ts`, `src/slots/markdown.ts`,
  `src/slots/json.ts`, `src/slots/index.ts`, and `src/cluster-http.ts` — all
  unchanged.
- **`generateTerminals` and `data/terminals.json`** — separate top-level
  index of ttyd ports per role per slot, consumed by
  `templates/dashboard/terminals.html`. Unrelated; do not touch.
- **`.terminal-label` CSS class in `templates/dashboard/style.css` and
  `terminals.html`** — still used by `terminals.html`. Keep the CSS rule.
  Only the `<span class="terminal-label">…</span>` emission site in
  `dashboard.js renderSlots` goes away.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The fix is a straightforward structural consolidation with no design choices.

1. **`src/dashboard.ts`**
   - In `SlotJson`: drop the `terminals` field; rename `t3codeThreadLinks` →
     `terminalLinks`.
   - In `lookupSlotOrchestrationLinks`: rename the emitted field and its
     local variable from `t3codeThreadLinks` to `terminalLinks` (both return
     type and body). The two backend branches (tmux port synthesis, t3code
     thread URLs) are unchanged in behavior.
   - In `generateSlots`:
     - Delete the `terminals` local, the markdown-parse loop over
       `data.terminals`, and the enrichment loop over `ttydBySession`.
     - Delete the `discoverTtydUrls()` call and remove the `ttydBySession`
       local.
     - Remove the `terminals:` entry from the pushed `SlotJson` object
       literal; rename `t3codeThreadLinks:` → `terminalLinks:`.
   - Delete the now-unused `discoverTtydUrls` function. Remove any newly
     unused imports it relied on (e.g. `safeSyncOutput`, `getUrl`) if they
     have no other users in the file.

2. **`templates/dashboard/dashboard.js`**, `renderSlots`
   - In the first loop, change `slot.t3codeThreadLinks` →
     `slot.terminalLinks` (two references: the `if` guard and the
     `Object.entries` call).
   - Delete the entire second loop (`if (slot.terminals) { … terminal-label
     … }`).

3. **Tests & verification**
   - `bun test` must pass. `dashboard.test.ts` has no assertions on these
     fields today, so nothing to update there.
   - Optional: add a small regression test asserting that
     `generateSlots()` output has `terminalLinks` (not `terminals`, not
     `t3codeThreadLinks`) for an active slot. Low-priority; fine to skip.
   - `bun run build` must succeed.
   - Manual smoke: run the dashboard against real slot state and confirm
     each active slot tile shows each orchestration role label exactly once
     as a clickable link.

No migration or data-format concerns: `slots.json` is regenerated on every
dashboard tick; the field rename is invisible to anything outside the
TS/JS pair changed in the same PR.

## Scope

- **In**: `src/dashboard.ts`, `templates/dashboard/dashboard.js`, optionally
  a regression test in `src/dashboard.test.ts`.
- **Out**: adapter `readState` functions, slot record format, `generateTerminals`
  /`terminals.json`, `terminals.html`, `.terminal-label` CSS.
- **Dependencies**: none.
