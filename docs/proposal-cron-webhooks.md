# Proposal: Dynamic Cron and Inbound Webhooks

## Current State

Triggers are **static** — defined in `config.yaml`, installed as launchd plists or systemd units via `ludics triggers install`. Adding or changing a trigger requires editing config and re-running install.

Task ingestion is **periodic** — `tasks sync` runs on a fixed interval (default 3600s), fetches GitHub issues via `gh`, and converts them to task files. Events between sync intervals are invisible.

## Problem

1. **Latency**: A critical GitHub issue filed at 09:01 isn't seen until the next sync at 10:00.
2. **Rigidity**: Mag can't schedule its own follow-ups ("check if task-042's PR passes CI in 30 minutes").
3. **No external event sources** beyond GitHub issues and watched files.

## Proposal A: Event-Driven Task Ingestion via GitHub Actions + ntfy

### The problem with webhooks

A local webhook server (on the dashboard port) can't receive GitHub webhooks — GitHub's servers can't reach a Tailscale address. Options like Tailscale Funnel or ngrok add a public attack surface and infrastructure complexity that contradicts ludics' philosophy.

### Two-topic design: reserved (human) + public (machine, whitelisted)

The existing reserved incoming topic requires an auth token — fine for phone messages but impractical for GitHub Actions (storing the token in GitHub secrets is possible but adds a trust boundary). Instead, add a **second, public ntfy topic** dedicated to machine events, with strict whitelist validation on the subscriber side.

```yaml
# config.yaml
notifications:
  topics:
    outgoing: lukstafi-from-Mag       # reserved, token-protected
    incoming: lukstafi-to-Mag         # reserved, token-protected (human messages)
    events: lukstafi-events           # public, no auth (machine events)
    agents: lukstafi-agents           # reserved, token-protected
```

### Whitelist validation (prompt injection defense)

The subscriber validates messages on the `events` topic against a strict pattern whitelist before they reach the queue. Anything that doesn't match is dropped silently:

```typescript
// In subscribeIncoming(), when processing events topic:
const EVENT_PATTERNS: RegExp[] = [
  /^new-issue [\w-]+\/[\w.-]+#\d+: .{1,200}$/,
  /^pr-event [\w-]+\/[\w.-]+#\d+ (opened|closed|merged)$/,
  /^pr-comment [\w-]+\/[\w.-]+#\d+$/,
  /^priority-change [\w-]+\/[\w.-]+#\d+: [ABC]$/,
  /^sync$/,
];

function isWhitelistedEvent(message: string): boolean {
  return EVENT_PATTERNS.some(p => p.test(message));
}
```

An attacker posting freeform text to the public topic gets dropped. Only structured, length-bounded, pattern-matched messages reach Mag. The patterns are tight enough that crafting a prompt injection within them is infeasible.

### GitHub Actions workflow (no secrets needed)

```yaml
# .github/workflows/ludics-notify.yml
name: Notify ludics
on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, closed, merged]
  issue_comment:
    types: [created]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Send to ludics events channel
        run: |
          EVENT="${{ github.event_name }}"
          REPO="${{ github.repository }}"
          case "$EVENT" in
            issues)
              MSG="new-issue ${REPO}#${{ github.event.issue.number }}: ${{ github.event.issue.title }}"
              ;;
            pull_request)
              MSG="pr-event ${REPO}#${{ github.event.pull_request.number }} ${{ github.event.action }}"
              ;;
            issue_comment)
              MSG="pr-comment ${REPO}#${{ github.event.issue.number }}"
              ;;
          esac
          # Public topic, no auth needed
          curl -s -d "$MSG" https://ntfy.sh/lukstafi-events
```

No secrets, no tokens. The topic name can even be hardcoded or passed as a non-secret variable.

### How it flows

```
GitHub event (issue opened, PR merged, comment)
    │
    ▼
GitHub Actions workflow
    │
    ▼
ntfy.sh public events topic (curl POST, no auth)
    │
    ▼
ludics events subscriber (SSE listener)
    │
    ▼
whitelist validation ──► DROP if no pattern match
    │
    ▼ (match)
queueRequest() with structured action
    │
    ▼
Mag processes (e.g., tasks sync + /ludics-elaborate)
```

**Result**: new issues reach Mag within one queue cycle (~60s), no secrets in CI, no prompt injection surface.

### What this covers

| GitHub event | ntfy message | Whitelist pattern | Mag action |
|---|---|---|---|
| Issue opened | `new-issue repo#N: title` | `^new-issue [\w-]+/[\w.-]+#\d+: .{1,200}$` | `tasks sync` + `/ludics-elaborate` |
| Issue labeled | `priority-change repo#N: A` | `^priority-change [\w-]+/[\w.-]+#\d+: [ABC]$` | Update task file |
| PR merged/closed | `pr-event repo#N merged` | `^pr-event [\w-]+/[\w.-]+#\d+ (opened\|closed\|merged)$` | Task completion check |
| PR comment | `pr-comment repo#N` | `^pr-comment [\w-]+/[\w.-]+#\d+$` | Factor into health check |

### Per-repo setup

Each monitored repo gets a copy of the workflow file. The topic name is the only configuration — no secrets needed. A template is provided in `templates/github/ludics-notify.yml`.

### Subscriber implementation

The existing `subscribeIncoming()` gains a second SSE connection for the events topic:

```typescript
export async function subscribeEvents(): Promise<void> {
  const topic = getTopic("events");
  if (!topic) return;  // events topic not configured, skip

  // Same SSE pattern as subscribeIncoming(), but:
  // - No auth header (public topic)
  // - Whitelist validation before queueRequest()
  // - Different queue action based on parsed message prefix
}
```

Both subscribers run in the same `notify subscribe` process (or as separate launchd/systemd units).

### Optional: Local webhook for LAN sources

For events originating within the Tailscale network (CI servers, other machines, scripts), a minimal endpoint on the dashboard server is still useful:

```typescript
// In dashboard-server.ts
app.post("/hook/:action", (req, res) => {
  const action = req.params.action;
  if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: "unknown action" });
  const id = queueRequest(action, req.body ? `"payload":${JSON.stringify(req.body)}` : undefined);
  res.json({ queued: id });
});
```

This is Tailscale-only (no public exposure), uses a bearer token for auth, and is optional — the ntfy events path handles the primary use case.

## Proposal B: Dynamic Cron (Mag-Scheduled Tasks)

### The idea

Let Mag (or any CLI caller) schedule one-shot or recurring future actions:

```bash
ludics cron add --in 30m "health-check"           # One-shot: 30 minutes from now
ludics cron add --at "2026-02-18T09:00" "briefing" # One-shot: specific time
ludics cron add --every 2h "health-check"          # Recurring: every 2 hours
ludics cron list                                    # Show scheduled items
ludics cron remove <id>                             # Cancel a scheduled item
```

### Implementation: File-based cron with tick evaluation

```typescript
// src/cron.ts
interface CronEntry {
  id: string;
  action: string;
  extra?: string;
  runAt?: string;      // ISO timestamp for one-shot
  interval?: number;   // seconds for recurring
  lastRun?: string;    // ISO timestamp
  created: string;
}
```

Storage: `mag/cron.jsonl` (one entry per line, same pattern as queue).

**Evaluation**: The existing mag keepalive trigger (runs every 60s) calls `cronTick()`:

```typescript
export function cronTick(): void {
  const now = Date.now();
  for (const entry of loadCronEntries()) {
    if (entry.runAt && new Date(entry.runAt).getTime() <= now) {
      queueRequest(entry.action, entry.extra);
      removeCronEntry(entry.id);  // one-shot: delete after firing
    }
    if (entry.interval && entry.lastRun) {
      const elapsed = now - new Date(entry.lastRun).getTime();
      if (elapsed >= entry.interval * 1000) {
        queueRequest(entry.action, entry.extra);
        updateCronEntryLastRun(entry.id, new Date().toISOString());
      }
    }
  }
}
```

This piggybacks on the existing keepalive mechanism — no new daemon or trigger needed.

### Use cases

1. **Mag schedules follow-ups**: After elaborating a task, Mag runs `ludics cron add --in 4h "health-check"` to verify the slot picked it up.
2. **CI monitoring**: After a PR is created, schedule a check in 20 minutes to see if CI passed.
3. **User-scheduled reminders**: `ludics cron add --at "2026-02-18T14:00" "message" --extra "Review POPL draft"`
4. **Adaptive health checks**: Instead of fixed 4h interval, Mag schedules health checks more frequently when deadlines are near.

### Interaction with static triggers

Dynamic cron doesn't replace static triggers — they serve different roles:

| | Static triggers | Dynamic cron |
|---|---|---|
| **Defined in** | `config.yaml` | `mag/cron.jsonl` |
| **Installed by** | `ludics triggers install` | `ludics cron add` or Mag |
| **Lifetime** | Permanent until uninstalled | One-shot or until removed |
| **Evaluated by** | OS scheduler (launchd/systemd) | Mag keepalive tick |
| **Use case** | Always-on infrastructure | Situational follow-ups |

## Proposal C: Events + Cron Combined

The two proposals are complementary and share the queue as their integration point:

```
GitHub event (issue opened, PR merged)
    │
    ▼
GitHub Actions workflow
    │
    ▼
ntfy public events topic ──► subscribeEvents() ──► whitelist ──► queueRequest()
                                                                       │
                                                                       ▼
                                                                 Mag processes
                                                                       │
                                                                       ▼
                                                                cronAdd("check CI in 20m")
                                                                       │
                                                                       ▼
                                                                cronTick() (keepalive)
                                                                       │
                                                                       ▼
                                                                queueRequest() ──► Mag processes
```

### Implementation cost

| Component | Effort | New code |
|-----------|--------|----------|
| GitHub Actions workflow template | Small | ~30 lines YAML |
| Events subscriber + whitelist validation | Small | ~60 lines |
| Optional LAN webhook route | Small | ~40 lines |
| `src/cron.ts` | Medium | ~120 lines |
| `cronTick()` in mag keepalive | Small | ~20 lines |
| CLI commands (`cron add/list/remove`) | Small | ~60 lines |
| Config schema additions | Small | ~20 lines |
| **Total** (TypeScript) | | **~320 lines** |

### What we don't need

- Auth tokens in GitHub secrets — the events topic is public, validation is on the subscriber side
- A public-facing webhook server — GitHub Actions posts to ntfy, which we already subscribe to
- A separate cron daemon — piggyback on mag keepalive
- Complex scheduling (crontab syntax) — `--in`, `--at`, `--every` cover the use cases
- Outbound webhooks — ntfy.sh already serves that role
- Tailscale Funnel / ngrok / tunnels — ntfy.sh is the relay
