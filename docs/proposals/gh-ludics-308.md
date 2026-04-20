# Proposal: Timestamp guard for settled sentinel race condition

**Task:** gh-ludics-308
**Project:** ludics

## Goal

Fix the race condition where `clearStaleSettled()` clears the settled sentinel prematurely because the stop hook's own output changes the tmux pane hash, breaking instant queue delivery and causing fallback to the 2+ minute stall nudge.

## Acceptance Criteria

- [ ] `clearStaleSettled()` does NOT clear the sentinel when it is younger than `keepalive_interval * 1.5` seconds (default: 90s), even if the pane hash has changed.
- [ ] `clearStaleSettled()` still clears the sentinel when it is older than the threshold AND the pane hash has changed (existing behavior preserved for genuinely stale sentinels).
- [ ] `maybeFeedMagQueue()` continues to work for instant delivery via the stop hook (sentinel survives the race window).
- [ ] Dashboard Send button (`POST /api/queue`) instant delivery works because the sentinel persists through the grace period.
- [ ] `maybeNudgeStalledMag()` is NOT invoked when `maybeFeedMagQueue()` successfully delivers (existing behavior, unchanged).
- [ ] The keepalive interval is read from `config.mag.keepalive_interval` with a default of 60 seconds, consistent with `triggers.ts`.
- [ ] New unit tests cover: (a) sentinel kept when young despite hash change, (b) sentinel cleared when old and hash changed, (c) sentinel kept when old but hash unchanged, (d) sentinel kept on first observation regardless of age.

## Context

### Race condition mechanism

The `on-stop` handler (`mag.ts`, case `"on-stop"`) calls three functions in sequence:
1. `markMagSettled()` -- writes `mag/settled` with a Unix epoch timestamp
2. `clearStallState()` -- deletes `last-pane.hash`, `last-pane-change.epoch`, `last-stall-nudge.epoch`
3. `maybeFeedMagQueue()` -- if queue has items, atomically claims sentinel and delivers; if empty, sentinel persists

When the queue is empty at stop time, the sentinel persists but no pane hash baseline exists (deleted by `clearStallState`). Claude Code then renders additional output (cost summaries, idle prompt), changing the pane content.

The keepalive tick (runs every `keepalive_interval` seconds, default 60) calls `clearStaleSettled()`:
- **Tick 1**: `previousHash` is null (deleted), records current hash as baseline, does NOT clear sentinel.
- **Between ticks**: Pane output changes (Claude Code rendering).
- **Tick 2**: `previousHash` differs from `currentHash` -- clears sentinel. All subsequent `maybeFeedMagQueue()` calls fail.

### Key symbols

- `settledSentinelFile()` -- returns path `mag/settled`
- `markMagSettled()` -- writes sentinel with `Math.floor(Date.now() / 1000)` as content
- `clearMagSettled()` -- deletes sentinel
- `isMagSettled()` -- checks sentinel existence
- `clearStaleSettled()` -- the function to fix; checks pane hash to detect stale sentinels
- `readEpochFile()` -- parses epoch from file content (already exists, reusable)
- `clearStallState()` -- deletes pane hash and related epoch files
- `maybeFeedMagQueue()` -- atomic claim + pop + deliver; guards on `isMagSettled()`
- `maybeNudgeStalledMag()` -- stall detection fallback, 2-minute threshold
- `triggerSkill()` -- delivers command to tmux pane via `tmuxSendKeys`
- `loadConfigSync()` -- returns config with `mag?: Record<string, unknown>` including `keepalive_interval`

### Existing test structure

`mag.test.ts` has two relevant `describe` blocks:
- `"settled sentinel atomic claim"` -- tests the rename-based atomic claim in `maybeFeedMagQueue`
- `"stale settled sentinel detection"` -- tests `clearStaleSettled` logic with a local reimplementation (inline function using tmpDir)

The stale detection tests use a local `clearStaleSettled()` function that mirrors the production code. The new tests should follow the same pattern, adding the timestamp guard logic to the local function.

## Approach

### 1. Add a helper to read the keepalive interval

Add a `keepaliveIntervalMs()` function in `mag.ts` (near the existing `stallThresholdMs()` / `stallNudgeCooldownMs()` helpers):

```typescript
function keepaliveIntervalMs(): number {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.keepalive_interval);
  if (Number.isFinite(configured) && configured > 0) return configured * 1000;
  return 60_000; // default 60s, matching triggers.ts
}
```

### 2. Add timestamp guard to `clearStaleSettled()`

After the `isMagSettled()` early return, read the sentinel's epoch content using `readEpochFile(settledSentinelFile())`. Compute the sentinel's age. If the age is less than `keepaliveIntervalMs() * 1.5`, return immediately without clearing.

The modified `clearStaleSettled()`:

```typescript
function clearStaleSettled(): void {
  if (!isMagSettled()) return;

  // Timestamp guard: don't clear a young sentinel — the pane hash change
  // is likely from the stop hook's own output aftermath, not user activity.
  const settledEpoch = readEpochFile(settledSentinelFile());
  if (settledEpoch !== null) {
    const ageMs = Date.now() - settledEpoch * 1000;
    if (ageMs < keepaliveIntervalMs() * 1.5) return;
  }

  const currentHash = tmuxPaneOutputHash(MAG_SESSION_NAME);
  if (currentHash === null) return;
  const previousHash = readPaneHash();
  if (previousHash !== null && currentHash !== previousHash) {
    clearMagSettled();
    writePaneHash(currentHash);
    writePaneChangeEpoch();
  } else if (previousHash === null) {
    writePaneHash(currentHash);
    writePaneChangeEpoch();
  }
}
```

The guard goes before the pane hash check because there is no point computing and comparing hashes if the sentinel is too young to clear.

### 3. Update tests in `mag.test.ts`

Add new test cases to the `"stale settled sentinel detection"` describe block. Update the local `clearStaleSettled()` reimplementation to include the timestamp guard (parameterized with a `graceMs` argument). New tests:

- **"keeps settled when sentinel is young despite hash change"**: Write sentinel with current epoch, write a prior hash, call with different hash. Expect sentinel NOT cleared.
- **"clears settled when sentinel is old and hash changed"**: Write sentinel with epoch from 5 minutes ago, write a prior hash, call with different hash. Expect sentinel cleared.
- **"keeps settled when sentinel is old but hash unchanged"**: Write sentinel with old epoch, write a prior hash, call with same hash. Expect sentinel NOT cleared (existing behavior preserved).
- **"keeps settled on first observation regardless of sentinel age"**: Write sentinel with old epoch, no prior hash. Expect sentinel NOT cleared and baseline recorded.

### 4. No changes to other files

The `on-stop` handler, `maybeFeedMagQueue()`, `maybeNudgeStalledMag()`, and the dashboard endpoint require no changes. The fix is entirely within `clearStaleSettled()` plus the new helper.
