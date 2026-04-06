# Proposal: Unify briefing and health-check into single 6h cycle

**Task**: task-b0bb07cc
**Date**: 2026-04-06

## Goal

Replace the drifting `StartInterval`-based health-check trigger with three wall-clock-aligned `StartCalendarInterval` entries (2:20 PM, 8:20 PM, 2:20 AM) so that briefing and health-checks form a clean 6h cycle with no redundant overnight wakeups.

## Acceptance Criteria

- `config.yaml` `triggers.health` no longer uses `interval`; instead uses a `schedule` array of `{hour, minute}` entries for 14:20, 20:20, 2:20.
- `triggersInstallMacos()` detects `schedule` array on health trigger and emits a `StartCalendarInterval` array plist (launchd supports an array of dicts for multi-time calendars).
- `triggersInstallLinux()` detects `schedule` array and emits multiple `OnCalendar=` lines in the systemd timer unit.
- Total daily wakeups drops from ~7 to 4 (08:20 briefing + 14:20/20:20/02:20 health-checks).
- `ludics init` (re-installs triggers) produces the new schedule without manual plist/unit editing.
- Old `StartInterval`-based health plist/unit is replaced (bootout + bootstrap on macOS, daemon-reload on Linux) after install.
- `KNOWN_LUDICS_TRIGGER_NAMES` still includes `"health"` (no rename needed).

## Context

### Current behavior

`config.yaml` (lines 135–138):
```yaml
health:
  enabled: true
  interval: 14400           # 4 hours in seconds
  action: mag health-check
```

`triggersInstallMacos()` (triggers.ts lines 166–181) reads `triggerGet("health", "interval")` and emits:
```xml
<key>StartInterval</key>
<integer>14400</integer>
```
`StartInterval` counts seconds from load/boot time — it drifts relative to wall clock and does not align with the 08:20 morning briefing.

`triggersInstallLinux()` (triggers.ts lines 369–376) similarly uses `OnUnitActiveSec=${interval}s`, which also drifts.

The morning briefing already covers health-check scope, so a 4h rolling interval creates redundant consecutive wakeups (e.g., briefing at 08:20, health at 08:26 if launchd loaded at 04:26).

### Code locations

- `harness/config.yaml` — `triggers:` section, lines 130–138
- `/Users/lukstafi/ludics/src/triggers.ts`
  - `KNOWN_LUDICS_TRIGGER_NAMES` — line 7
  - `triggersInstallMacos()` health block — lines 165–181
  - `triggersInstallLinux()` health block — lines 368–376
  - `triggerGet()` helper — lines 33–42 (reads a single string key; needs companion helper or inline array read)

## Approach

### 1. Config change (`harness/config.yaml`)

Replace `interval: 14400` with a `schedule` array:

```yaml
health:
  enabled: true
  schedule:
    - { hour: 14, minute: 20 }
    - { hour: 20, minute: 20 }
    - { hour: 2,  minute: 20 }
  action: mag health-check
```

### 2. Helper to read schedule array (`triggers.ts`)

Add a `triggerGetSchedule(section)` function alongside `triggerGet()`:

```ts
function triggerGetSchedule(section: string): { hour: number; minute: number }[] | null {
  const config = loadConfigSync();
  const triggers = config.triggers as Record<string, unknown> | undefined;
  if (!triggers) return null;
  const sectionData = triggers[section] as Record<string, unknown> | undefined;
  if (!sectionData) return null;
  const schedule = sectionData["schedule"];
  if (!Array.isArray(schedule)) return null;
  return schedule.map((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    return { hour: Number(e.hour ?? 0), minute: Number(e.minute ?? 0) };
  });
}
```

### 3. macOS: replace `StartInterval` with `StartCalendarInterval` array

Replace the health block in `triggersInstallMacos()`:

```ts
if (triggerGet("health", "enabled") === "true") {
  const action = commandFromAction(triggerGet("health", "action"));
  const label = "com.ludics.health";
  const schedule = triggerGetSchedule("health");

  let calendarXml: string;
  if (schedule && schedule.length > 0) {
    // Array of dicts — launchd fires at each specified time
    const entries = schedule
      .map(({ hour, minute }) =>
        `    <dict>\n      <key>Hour</key>\n      <integer>${hour}</integer>\n      <key>Minute</key>\n      <integer>${minute}</integer>\n    </dict>`
      )
      .join("\n");
    calendarXml = `  <key>StartCalendarInterval</key>\n  <array>\n${entries}\n  </array>`;
  } else {
    // Fallback: interval-based
    const interval = triggerGet("health", "interval") || "14400";
    calendarXml = `  <key>StartInterval</key>\n  <integer>${interval}</integer>`;
  }

  const content = [
    PLIST_HEADER,
    `  <key>Label</key>\n  <string>${label}</string>`,
    calendarXml,
    plistEnv(),
    plistArgs(bin, ...action.split(" ")),
    plistLogs("health"),
    PLIST_FOOTER,
  ].join("\n");
  installPlist(label, content);

  const desc = schedule
    ? schedule.map(({ hour, minute }) => `${hour}:${String(minute).padStart(2, "0")}`).join(", ")
    : "interval";
  console.log(`Installed launchd trigger: health (${desc})`);
}
```

### 4. Linux: replace `OnUnitActiveSec` with multiple `OnCalendar` lines

Replace the health block in `triggersInstallLinux()`:

```ts
if (triggerGet("health", "enabled") === "true") {
  const action = commandFromAction(triggerGet("health", "action"));
  const schedule = triggerGetSchedule("health");

  writeSystemdUnit(
    "ludics-health.service",
    `[Unit]\nDescription=ludics health check\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`
  );

  let timerSection: string;
  if (schedule && schedule.length > 0) {
    const onCalendarLines = schedule
      .map(({ hour, minute }) => `OnCalendar=*-*-* ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`)
      .join("\n");
    timerSection = `[Timer]\n${onCalendarLines}\nPersistent=true\nUnit=ludics-health.service`;
  } else {
    const interval = triggerGet("health", "interval") || "14400";
    timerSection = `[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-health.service`;
  }

  writeSystemdUnit(
    "ludics-health.timer",
    `[Unit]\nDescription=ludics health check timer\n\n${timerSection}\n\n[Install]\nWantedBy=timers.target\n`
  );
  enableSystemdUnit("ludics-health.timer");

  const desc = schedule
    ? schedule.map(({ hour, minute }) => `${hour}:${String(minute).padStart(2, "0")}`).join(", ")
    : "interval";
  console.log(`Installed systemd trigger: health (${desc})`);
}
```

### 5. After implementation

Run `ludics init --no-triggers` then `ludics init` (or `ludics triggers install`) to reload the new plist/units. Verify with `launchctl list | grep ludics` on macOS or `systemctl --user list-timers` on Linux.
