# Proposal: Remove the ludics-read-inbox skill and the associated inbox file handling

**Task**: gh-ludics-21
**GitHub**: https://github.com/lukstafi/ludics/issues/21
**Effort**: Small
**Status**: Ready to implement

---

## Summary

The `mag/inbox.md` file and `/ludics-read-inbox` skill predate the ntfy.sh queue-based messaging
channel. With the "lightweight incoming" proposal implemented
(`docs/proposals/proposal-lightweight-incoming.md`), incoming ntfy messages are written directly
to the queue with content via `queueRequest("message", '"content":...')`, and `queuePopSkill()`
returns the message content as a direct user turn. The `/ludics-read-inbox` fallback path in
`queuePopSkill()`, the `appendToInbox()` function in `notify.ts`, and the `magInbox()` function in
`mag.ts` are all dead code. This proposal removes them along with associated CLI commands, help
text, and documentation references.

The `magMessage()` function (`ludics mag message "text"`) is **retained** — it queues a `message`
action with content, which flows through the live queue path as a direct user turn. It is still
useful CLI behavior.

---

## Verification of Current State

### Queue flow (working, no regression risk)

The current `queuePopSkill()` for `"message"` actions (src/mag.ts line 1005-1039):

```typescript
case "message": {
  const content = String(request.content ?? "");
  if (!content) return "/ludics-read-inbox"; // fallback for legacy queue entries
  // ... pattern matching for button-tap messages ...
  return content; // send directly as user turn
}
```

The fallback at line 1007 fires only when `request.content` is empty/missing. The current
`subscribeIncoming()` always populates content (`queueRequest("message", '"content":...')`), and
`magMessage()` also always populates content. There are no remaining code paths that create a
`message` queue entry without content.

### appendToInbox() is already dead

`appendToInbox()` is defined at `src/notify.ts:982-991` but is **not called anywhere** — not in
`subscribeIncoming()` or any other function. The `subscribeIncoming()` function already calls
`queueRequest()` directly (lines 1187-1208). The function is unreachable dead code.

---

## Changes Required

### 1. Delete skill file

**File**: `skills/ludics-read-inbox.md` (55 lines)

Delete the entire file.

---

### 2. src/mag.ts — Remove fallback, magInbox(), inbox CLI route

#### 2a. Remove legacy fallback in queuePopSkill()

**Location**: line 1007

```typescript
// REMOVE this line:
if (!content) return "/ludics-read-inbox"; // fallback for legacy queue entries
```

After removal, empty-content `message` queue entries will fall through to the button-tap pattern
matching and ultimately `return content` (returning an empty string). To handle this gracefully,
add an early return for empty content:

```typescript
case "message": {
  const content = String(request.content ?? "");
  if (!content) return null; // no content to process
  // ... rest of the handler unchanged ...
}
```

#### 2b. Remove magInbox() function

**Location**: lines 2286-2304 (19 lines)

```typescript
function magInbox(consume: boolean = false): void {
  const inboxFile = join(harnessDir(), "mag", "inbox.md");
  if (!existsSync(inboxFile)) {
    console.log("No pending messages");
    return;
  }
  const content = readFileSync(inboxFile, "utf-8");
  console.log(content);

  if (consume && content.trim()) {
    // Append to past-messages.md
    const pastFile = join(harnessDir(), "mag", "past-messages.md");
    const existing = existsSync(pastFile) ? readFileSync(pastFile, "utf-8") : "# Past Messages\n";
    writeFileSync(pastFile, existing + "\n" + content.replace(/^# Mag Inbox\n?/, ""));

    // Clear inbox
    writeFileSync(inboxFile, "# Mag Inbox\n");
  }
}
```

Delete the entire function.

#### 2c. Remove mag inbox CLI route

**Location**: lines 2419-2421

```typescript
case "inbox":
  magInbox(args.includes("--consume"));
  break;
```

Delete these 3 lines.

#### 2d. Remove "inbox" from error message in default case

**Location**: line 2558

```typescript
throw new Error(`unknown mag command: ${sub} (use: start, stop, status, attach, logs, doctor, briefing, suggest, analyze, elaborate, draft-proposal, split-task, verify-completion, health-check, adopt-sessions, completed, message, inbox, queue, queue-pop, context, feedback-digest)`);
```

Remove `, inbox` from the list:

```typescript
throw new Error(`unknown mag command: ${sub} (use: start, stop, status, attach, logs, doctor, briefing, suggest, analyze, elaborate, draft-proposal, split-task, verify-completion, health-check, adopt-sessions, completed, message, queue, queue-pop, context, feedback-digest)`);
```

---

### 3. src/notify.ts — Remove appendToInbox()

**Location**: lines 982-992 (11 lines)

```typescript
function appendToInbox(message: string, title?: string): void {
  const inboxFile = join(harnessDir(), "mag", "inbox.md");
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const heading = title ? `## ntfy: ${title} - ${timestamp}` : `## ntfy Message - ${timestamp}`;
  const entry = `\n${heading}\n\n${message}\n`;

  const existing = existsSync(inboxFile) ? readFileSync(inboxFile, "utf-8") : "# Mag Inbox\n";
  writeFileSync(inboxFile, existing + entry);
}
```

Delete the entire function. There are no call sites to clean up.

Check whether any imports become unused after this deletion (`existsSync`, `mkdirSync`,
`readFileSync`, `writeFileSync` are likely used elsewhere in `notify.ts` — no import cleanup
expected).

---

### 4. src/index.ts — Remove inbox from help text

**Location**: line 135

```
  mag inbox                    Show and consume pending messages
```

Delete this line.

---

### 5. docs/ARCHITECTURE.md — Remove read-inbox references

#### 5a. Skill classification table (line 132)

Remove row:
```
| `/ludics-read-inbox` | Process incoming messages | Inline |
```

#### 5b. Light skills list (line 223)

```
| Light (inline) | health-check, read-inbox, suggest, preempt, learn, split-task, new-quote | Mostly CLI commands with minimal reads |
```

Change to:
```
| Light (inline) | health-check, suggest, preempt, learn, split-task, new-quote | Mostly CLI commands with minimal reads |
```

#### 5c. Incoming topic description (line 427)

```
Mag processes incoming messages via the `/ludics-read-inbox` skill.
```

Replace with:
```
Mag processes incoming messages by inserting the message content directly as a user turn.
```

#### 5d. Skills directory tree (line 658)

Remove line:
```
│   ├── ludics-read-inbox.md          # Inline
```

#### 5e. Harness directory tree (line 700)

Remove line:
```
    │   ├── inbox.md               # Async messages from humans
```

#### 5f. CLI reference block (line 801)

Remove line:
```
ludics mag inbox               # Show pending messages
```

---

### 6. Other references (informational only — no changes needed)

The following files contain `inbox` or `read-inbox` references but do **not** require changes:

- `docs/proposals/proposal-lightweight-incoming.md` — historical design doc describing the
  transition; leave as-is (implemented/ directory is an archive)
- `docs/proposals/skill-context-isolation.md` — historical doc; leave as-is
- `docs/proposals/TypeScript_migration/` — historical migration notes; leave as-is
- `docs/proposal-memory-compaction.md` — references `past-messages.md` as a compaction target;
  after deletion of the file, this reference becomes moot but the proposal doc itself is
  low-priority to update
- `docs/proposal-dashboard-improvements.md` — mentions "inbox" in a UI filter list; unrelated
  to the inbox.md file; leave as-is
- `docs/codex_app_ideas.md` — uses "inbox" as a generic UX term; leave as-is
- `templates/harness/CLAUDE.md` — says `mag/` contains "inbox"; could be updated but is a minor
  cosmetic change; defer
- `skills/ludics-briefing.md` lines 19 and 72 — mentions "inbox" in context of briefing context
  gathering. Line 19 says "All data gathering (slots refresh, session discovery, flow computations,
  **inbox**, journal...)". Line 72 says "Factor in inbox messages as high-priority context". These
  refer to the pre-computed briefing context which already reads from `notifications.jsonl`, not
  `inbox.md`. The references are conceptually accurate (recent incoming messages are included) but
  technically misleading. **Recommend updating** both to say "recent incoming" rather than "inbox".

---

## Deletion Order

To avoid broken intermediate states if the implementation is interrupted:

1. **Delete `skills/ludics-read-inbox.md`** — the skill file first, so no new sessions can invoke
   it even if the queue fallback still exists briefly
2. **Remove fallback in `queuePopSkill()` and `magInbox()`/CLI route in `src/mag.ts`** — together
   in one edit pass; the skill is already gone so the fallback return value would be harmless but
   is now dead
3. **Remove `appendToInbox()` from `src/notify.ts`** — already unreachable, can be done at any
   point
4. **Update `src/index.ts` help text** — cosmetic, any time
5. **Update `docs/ARCHITECTURE.md`** — documentation, any time
6. **(Optional) Update `skills/ludics-briefing.md`** — replace "inbox" with "recent incoming"

---

## Edge Cases and Risks

### Legacy queue entries

Any `message` entries in `mag/queue.jsonl` written before the lightweight-incoming refactor (i.e.,
entries without a `content` field) would previously trigger `/ludics-read-inbox`, which would then
run `ludics mag inbox --consume`. After this change, those entries will return `null` from
`queuePopSkill()` and be silently dropped.

**Risk level**: Low. The queue is typically short-lived (seconds to minutes). Any pre-refactor
entries would be months old. If any exist, they represent a lost notification that has long since
been superseded.

**Mitigation**: Before deploying, check `mag/queue.jsonl` for any `"action":"message"` entries
lacking a `"content"` field. If found, either process them manually or discard.

### inbox.md file in harness

The `mag/inbox.md` file may exist in the harness directory. After this change, no code reads or
writes it. It becomes a harmless orphan.

**Recommendation**: Do not delete it automatically. Leave cleanup to the user (it may contain
manually written notes).

### past-messages.md file in harness

Similarly, `mag/past-messages.md` becomes an orphan. Leave it for the user to clean up.

### TypeScript unused imports

After removing `magInbox()`, check whether `existsSync`, `readFileSync`, `writeFileSync` are still
used elsewhere in `src/mag.ts`. They almost certainly are, but verify before submitting.

---

## Files Changed

| File | Change |
|------|--------|
| `skills/ludics-read-inbox.md` | Delete entire file |
| `src/mag.ts` | Remove fallback (~line 1007), remove `magInbox()` (~lines 2286-2304), remove `inbox` case (~lines 2419-2421), remove `inbox` from error message (~line 2558) |
| `src/notify.ts` | Remove `appendToInbox()` (~lines 982-992) |
| `src/index.ts` | Remove `mag inbox` help line (~line 135) |
| `docs/ARCHITECTURE.md` | Remove 6 references across lines 132, 223, 427, 658, 700, 801 |
| `skills/ludics-briefing.md` | (Optional) Replace "inbox" with "recent incoming" at lines 19, 72 |

**Total deletions**: ~90 lines across 5-6 files. No new logic required.
