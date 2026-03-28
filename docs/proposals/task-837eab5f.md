# Proposal: Dashboard slot tiles — display round number next to workflow phase

## Summary

Add the orchestration round number to dashboard slot tiles so users see "work (round 3)" instead of just "work". This is a 2-file change: pass `round` through `SlotJson` in `src/dashboard.ts`, then render it in `templates/dashboard/dashboard.js`.

## Current state

Slot tiles display the orchestration phase (e.g., "work", "review", "plan-merge") via `slot.phase` but not the round number. The round is already available in `OrchestrationState.round` (state.ts:91), and the orchestration state is already read in `generateSlots()` at dashboard.ts:198 to extract `phase`. The round value is simply not carried through to the JSON output or rendered in the UI.

## Changes

### 1. Add `round` to `SlotJson` interface (src/dashboard.ts ~line 31)

Add `round: number | null;` after the `phase` field in the interface definition.

### 2. Extract round from orchestration state (src/dashboard.ts ~lines 196-202)

The orchestration state is already read and the `phase` extracted. Piggyback on the same read to also grab `round`:

```ts
let phase: string | null = null;
let round: number | null = null;
if (!empty) {
  const orchState = readOrchestrationState(num);
  if (orchState && (!taskId || orchState.taskId === taskId || orchState.feature === taskId)) {
    phase = orchState.phase ?? null;
    round = orchState.round ?? null;
  }
}
```

### 3. Include `round` in slot JSON output (src/dashboard.ts ~line 237)

Add `round: empty ? null : round,` after the `phase` line in the returned object.

### 4. Render round in dashboard JS (templates/dashboard/dashboard.js ~line 145)

Change:
```js
if (slot.phase) html += `<p class="phase"><span class="label">Phase:</span> ${escapeHtml(slot.phase)}</p>`;
```
To:
```js
if (slot.phase) {
    let phaseText = escapeHtml(slot.phase);
    if (slot.round != null && slot.round > 0) phaseText += ` (round ${slot.round})`;
    html += `<p class="phase"><span class="label">Phase:</span> ${phaseText}</p>`;
}
```

## Risks and edge cases

- **Round is 0 or undefined**: The guard `slot.round != null && slot.round > 0` ensures no display for uninitialized or zero values. Round starts at 1 in normal orchestration flow.
- **No orchestration state file**: Already handled — when `orchState` is null, both `phase` and `round` remain null.
- **No CSS changes needed**: The round text is appended inline to the existing phase text.

## Effort

Small — two files, four insertion points, no new dependencies or tests needed beyond manual verification.
