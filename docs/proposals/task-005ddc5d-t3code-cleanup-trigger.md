# Proposal: Add periodic t3code cleanup trigger

**Task:** task-005ddc5d
**Date:** 2026-04-09

## Goal

Add a periodic `t3code-cleanup` trigger (launchd on macOS, systemd on Linux) that runs `ludics t3code cleanup` daily, preventing stale threads from accumulating in t3code between slot clears.

## Acceptance Criteria

- [ ] `t3code-cleanup` added to `KNOWN_LUDICS_TRIGGER_NAMES` in `src/triggers.ts`
- [ ] macOS launchd plist generated in `triggersInstallMacos()` using interval-based pattern (matching `sessions-sweep`)
- [ ] Linux systemd service + timer generated in `triggersInstallLinux()` using interval-based pattern (matching `sessions-sweep`)
- [ ] Default interval is 86400 seconds (24 hours), configurable via `config.yaml`
- [ ] Trigger reads `action` from config (default: `t3code cleanup`)
- [ ] `ludics triggers status` correctly reports the new trigger
- [ ] `ludics triggers pause` and `ludics triggers uninstall` handle the new trigger (automatic via `KNOWN_LUDICS_TRIGGER_NAMES`)
- [ ] No changes to `cleanupStaleItems()` itself (it already works correctly)

## Context

- `cleanupStaleItems()` in `src/t3code/index.ts:339` handles all cleanup logic: identifies stale threads (>25h old, task in terminal status, not in active slots), stops running sessions, soft-deletes threads, reports stale projects. Supports `--dry-run`.
- Currently only invoked on `slot clear` and manual `ludics t3code cleanup`. Crashes and force-kills leave stale threads.
- The `sessions-sweep` trigger is the exact pattern to copy: interval-based, oneshot service, daily cadence.
- Pause, uninstall, and status functions iterate `KNOWN_LUDICS_TRIGGER_NAMES` automatically, so adding the name there is sufficient for those to work.

## Approach

1. **`src/triggers.ts` line 8**: Add `"t3code-cleanup"` to the `KNOWN_LUDICS_TRIGGER_NAMES` array.

2. **`triggersInstallMacos()`** (after the `sessions-sweep` block, ~line 250): Add a new block:
   ```typescript
   if (triggerGet("t3code-cleanup", "enabled") === "true") {
     const action = commandFromAction(triggerGet("t3code-cleanup", "action"));
     const interval = triggerGet("t3code-cleanup", "interval") || "86400";
     const label = "com.ludics.t3code-cleanup";
     const content = [
       PLIST_HEADER,
       `  <key>Label</key>\n  <string>${label}</string>`,
       `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
       plistEnv(),
       plistArgs(bin, ...action.split(" ")),
       plistLogs("t3code-cleanup"),
       PLIST_FOOTER,
     ].join("\n");
     installPlist(label, content);
     console.log(`Installed launchd trigger: t3code-cleanup (every ${Math.floor(parseInt(interval) / 3600)}h)`);
   }
   ```

3. **`triggersInstallLinux()`** (after the `sessions-sweep` block, ~line 447): Add a new block:
   ```typescript
   if (triggerGet("t3code-cleanup", "enabled") === "true") {
     const action = commandFromAction(triggerGet("t3code-cleanup", "action"));
     const interval = triggerGet("t3code-cleanup", "interval") || "86400";
     writeSystemdUnit("ludics-t3code-cleanup.service",
       `[Unit]\nDescription=ludics t3code stale thread cleanup\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
     writeSystemdUnit("ludics-t3code-cleanup.timer",
       `[Unit]\nDescription=ludics t3code cleanup timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-t3code-cleanup.service\n\n[Install]\nWantedBy=timers.target\n`);
     enableSystemdUnit("ludics-t3code-cleanup.timer");
     console.log(`Installed systemd trigger: t3code-cleanup (every ${Math.floor(parseInt(interval) / 3600)}h)`);
   }
   ```

4. **Harness `config.yaml`**: Add trigger entry:
   ```yaml
   t3code-cleanup:
     enabled: true
     interval: 86400
     action: t3code cleanup
   ```

Total: ~20 lines of new code in `triggers.ts` plus 1 line in the known-names array and a config entry.
