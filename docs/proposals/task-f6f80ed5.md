# Prefix automated request-queue feeds with 'Ludics:' to distinguish from user-typed messages

## Goal

When the keepalive auto-feeds a queue entry into the Mag conversation, the fed turn should be visibly distinguishable from a user-typed slash command. Specifically, queue-fed automated slash commands should be prefixed with `Ludics: ` so that:

- Claude Code's slash-command parser does not auto-dispatch the embedded `/ludics-X` (the turn no longer starts with `/`), giving Mag the natural pushback step (decide whether to act, push back if appropriate).
- Conversation transcripts and `mag_queue_feed` event logs unambiguously mark which turns originated from the harness queue versus the user.

The discriminator is structural: the `QueueAction` `message` variant carries a `content` field while every other (automated) variant carries `task` (or no payload). User-typed messages — should they ever reach this seam — go through unchanged; everything else gets prefixed.

## Acceptance Criteria

Falsifier-style tests in `src/mag.test.ts` (or a new sibling file targeting the prefix logic):

1. **Automated action prefix test (positive):** Feed a queue entry with shape `{ action: "draft-proposal", task: "task-X", ... }` through the prefix logic and assert the resulting fed prompt starts with `Ludics: ` and that the original `/ludics-draft-proposal …` slash command appears immediately after the prefix. Fails if the prefix is absent or applied only conditionally on action name rather than structural shape.

2. **Message action no-prefix test (negative):** Feed a queue entry with shape `{ action: "message", content: "hello" }` through the prefix logic and assert the result does NOT start with `Ludics: `. Fails if the prefix is unconditionally applied.

   **2a. `/compact` no-prefix sub-case (load-bearing):** Feed `{ action: "message", content: "/compact" }` and assert the result is exactly `/compact` — no prefix. The keepalive auto-schedules `/compact` after health checks (visible as `delivered: /compact` in `journal/events.jsonl`); the prefix would prevent Claude Code from parsing it as a slash command and break the auto-compact behavior. Do **not** add a special case for `/compact` — the structural rule (content-bearing → no prefix) already gives the correct outcome, and special-casing would couple the prefix logic to slash-command syntax. Fails if any caller adds a `command.startsWith("/") → prefix` shortcut, or if the structural rule is replaced by an action-name allowlist that omits `message`.

3. **Inversion falsifier:** Both tests above must fail if a developer accidentally inverts the structural condition (prefixing `content`-bearing entries and not prefixing `task`-bearing entries). The test suite continues to fail if the prefix decision is removed altogether (positive test fails) or always applied (negative test fails).

4. **Event-log alignment:** The `mag_queue_feed` event's `message` field carries the same prefixed string that is sent to `triggerSkill`, so log inspection in `journal/events.jsonl` reflects what Mag actually saw. Verified by reading the event payload in the positive test (or by inspection — the implementation must use a single locally-scoped `delivered` string for both calls).

5. **Programmatic side-effect actions remain unaffected:** Tier-3 programmatic-only actions (e.g. `Approve task …`, `adapter-followup`, `complete-task`) that today return `null` from `resolveQueueRequestCommand` continue to never reach `triggerSkill`. The prefix change does not perturb the requeue-on-failure path: the unprefixed raw `popped.line` is what gets reinserted via `queueReinsertHead`. Existing tests (e.g. `resolveQueueRequestCommand — backward compat parsing` in `src/mag.test.ts`) continue to pass.

## Context

User-driven observability fix surfaced during a 2026-04-30 Mag session. When the keepalive auto-queues a request (e.g. `draft-proposal task-X`, `elaborate task-Y`), the queue feeder translates the queue entry into a slash command and pipes it into the Mag conversation. Today those auto-fed slash commands are visually identical to user-typed slash commands — Mag has no signal to distinguish them and may skip the natural pushback step.

User's discrimination rule (confirmed in elaboration): user-typed messages also enter via the request queue, but their `QueueAction` shape is distinct — `{ action: "message", content: string }` carries `content`, while every automated variant carries `task` or no payload. So the prefix decision is made structurally at feed time rather than via a new provenance flag at every `queueRequest()` callsite.

Both elaboration questions are resolved:

- **Q1 — Slash-command auto-dispatch (resolved):** Suppressing auto-dispatch is the intended behavior. With the `Ludics: ` prefix, the fed turn no longer starts with `/`, so Claude Code parses it as a normal user prompt that *mentions* a `/ludics-X` command. Mag reads it, decides whether to act, and may push back. This is the natural pushback step.

- **Q2 — Stall-nudge consistency (resolved, out of scope):** The periodic `Continue previous work if any. (ludics, ${now})` nudge keeps its existing `(ludics, ${now})` parenthetical and does NOT gain a `Ludics: ` prefix. The prefix is strictly for queue-fed slash commands.

### Why this matters

- Disambiguates conversation provenance for the Mag agent (avoids the failure mode where Mag treats an auto-fed `/ludics-draft-proposal X` as a user directive and skips the pushback step).
- Makes retrospective debugging easier — `journal/events.jsonl` lines and conversation transcripts will show which directives Mag chose to act on vs which it was fed.
- Tiny diff at one seam.

### Verified pointers

- `maybeFeedMagQueue()` at `src/mag.ts:294` — emits `mag_queue_feed` with `message: \`delivered: ${popped.command}\`` at line 321 and calls `triggerSkill(MAG_SESSION_NAME, popped.command)` at line 319.
- `queuePopSkill()` at `src/mag.ts:1216` — returns `{ command, line }` where `line` is the raw JSONL record string.
- `resolveQueueRequestCommand()` at `src/mag.ts:1247` — three-tier dispatcher. **Correction to the Tentative Design's reading:** the `message` branch does NOT uniformly return `null`. The keepalive auto-schedules `/compact` as a `message` action whose `content` is fed through to `triggerSkill` today (see `journal/events.jsonl` for repeated `delivered: /compact` entries). So `message`-with-`content` IS reachable at this seam — which makes the structural rule (content-bearing → no prefix) load-bearing rather than forward-compatible-only. The implementation must preserve this path: `/compact` and any other content-bearing message must continue to be fed verbatim so Claude Code's parser dispatches them.
- `QueueAction` at `src/queue.ts:132-139` — discriminator confirmed: `message` variant carries `content`, every other variant carries `task` (or no payload).
- Existing test scaffold: `src/mag.test.ts` (already covers `resolveQueueRequestCommand` with `bun:test`).

## Approach

Apply the prefix in `maybeFeedMagQueue()` (Option A from the Tentative Design — single seam, structural test). Concretely:

1. **In `maybeFeedMagQueue()` after `queuePopSkill()` returns** (`src/mag.ts:316`):
   - Parse `popped.line` as JSON (it's the raw queue record). Default to "no `content` field" on parse failure (treat as automated → prefix).
   - Compute a single `delivered` string used for both the `triggerSkill` call and the `mag_queue_feed` event message:
     - If the parsed record has a `content` field (string), `delivered = popped.command`.
     - Otherwise, `delivered = \`Ludics: ${popped.command}\``.
   - Pass `delivered` to `triggerSkill` (replacing `popped.command` at line 319).
   - Use `delivered` in the `mag_queue_feed` event (replacing `popped.command` at line 321) so journal observability matches what Mag actually saw.

2. **Extract the prefix decision into a small pure helper** (e.g. `applyQueueFeedPrefix(rawLine: string, command: string): string`) so the unit tests can exercise it without spinning up tmux. Keep the helper local to `src/mag.ts` (export for testing).

3. **Requeue-on-failure path is unchanged:** the existing branch reinserts based on `popped.line` (raw JSONL), not the fed string. Prefix is transient at feed time — never persisted in the queue file.

4. **Tests in `src/mag.test.ts`:**
   - Add a `describe("applyQueueFeedPrefix")` block with the positive (`task`-bearing) and negative (`content`-bearing) cases described in Acceptance Criteria. Use the helper directly — no tmux, no filesystem.
   - Optionally add a parse-failure case that asserts the prefix is applied (defensive default).

5. **Out of scope** (per Q2):
   - The `Continue previous work if any. (ludics, ${now})` heartbeat at `src/mag.ts:385` keeps its current shape.
   - No changes to `queueRequest()` or any callsite in `src/queue.ts`.
   - No changes to `resolveQueueRequestCommand()` — Tier-3 programmatic actions still return `null` and never reach `triggerSkill` via this feeder.

### Edge cases

- **Visually-redundant double signal:** A fed prompt looks like `Ludics: /ludics-draft-proposal task=task-X`. The `/ludics-` substring is duplicated semantically with the `Ludics: ` prefix; this is intentional — the prefix at the start of the turn is what Claude Code's parser uses to decide auto-dispatch vs plain prompt.
- **`popped.line` JSON parse failure:** Should not happen (the queue file is always JSONL written by `queueRequest`), but if it does, default to applying the prefix (treat as automated). This matches the structural rule's intent.
- **Auto-fed `/compact` (already wired up):** The keepalive queues `/compact` as a `message` action; today it's fed verbatim so Claude Code's parser dispatches it. The structural rule preserves this — do NOT add a `command.startsWith("/") → prefix` shortcut, which would break auto-compact. The prefix is for *automated skill invocations*, not for *automated slash commands fed via the message channel*; the `content`-vs-`task` distinction encodes that line.
- **Future free-form messages:** Any future `{ action: "message", content: "…" }` entries (user-typed or otherwise) inherit the no-prefix behavior automatically — the structural rule does the right thing without further changes.
