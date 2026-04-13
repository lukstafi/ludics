# Proposal: Extract shared helper for interval-based trigger installation

**Task:** gh-ludics-255
**Date:** 2026-04-13

## Goal

Extract `installIntervalTrigger(name, defaultInterval)` to deduplicate the 5 identical interval trigger blocks in `triggers.ts`.

## Acceptance Criteria

1. A new `installIntervalTrigger(name, defaultInterval)` function handles both macOS (plist) and Linux (systemd) installation for interval-based triggers.
2. The 5 interval triggers (`sync`, `sessions`, `sessions-sweep`, `cluster`, `t3code-cleanup`) each reduce to a single function call.
3. Non-interval triggers (`startup`, `morning`, `health`) are left as-is (they have unique scheduling logic).
4. `bun run build` succeeds, all tests pass. `ludics init` still installs all triggers correctly.

## Context

Each interval trigger follows the same pattern (verified in triggers.ts:144-270):
1. Check `triggerGet(NAME, "enabled") === "true"`
2. Read action: `commandFromAction(triggerGet(NAME, "action"))`
3. Read interval with default: `triggerGet(NAME, "interval") || "DEFAULT"`
4. Build plist XML with `PLIST_HEADER`, Label, StartInterval, `plistEnv()`, `plistArgs()`, `plistLogs()`, `PLIST_FOOTER`
5. `installPlist(label, content)` + log message

5 triggers x ~16 lines each = ~80 lines of near-identical code. The helper reduces this to ~16 lines total + the helper definition.

Non-interval triggers have unique logic: `startup` uses `RunAtLoad`, `morning` uses `StartCalendarInterval` with hour/minute, `health` uses multi-entry `StartCalendarInterval` array with fallback to interval. These stay as-is.

## Approach

Add helper function in `triggers.ts`:

```typescript
function installIntervalTrigger(name: string, defaultInterval: number): void {
  if (triggerGet(name, "enabled") !== "true") return;
  const action = commandFromAction(triggerGet(name, "action"));
  const interval = triggerGet(name, "interval") || String(defaultInterval);
  const label = `com.ludics.${name}`;
  
  if (process.platform === "darwin") {
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs(name),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
  } else {
    // Linux systemd path
    writeSystemdUnit(name, action, interval);
    enableSystemdUnit(name);
  }
  
  const secs = parseInt(interval);
  const desc = secs >= 3600 ? `${Math.floor(secs / 3600)}h` : `${Math.floor(secs / 60)}m`;
  console.log(`Installed trigger: ${name} (every ${desc})`);
}
```

Replace each trigger block with:
```typescript
installIntervalTrigger("sync", 3600);
installIntervalTrigger("sessions", 300);
installIntervalTrigger("sessions-sweep", 86400);
installIntervalTrigger("cluster", 300);
installIntervalTrigger("t3code-cleanup", 86400);
```

### Files to modify

- `src/triggers.ts` — add helper, replace 5 interval trigger blocks
