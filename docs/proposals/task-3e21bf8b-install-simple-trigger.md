# Extract `installSimpleTrigger` helper for non-interval triggers

## Goal

Reduce boilerplate duplication in `src/triggers.ts` by extracting a shared `installSimpleTrigger` helper for the four non-interval triggers (`startup`, `mag`, `dashboard`, `ntfy-subscribe`) that each repeat the same plist-build / systemd-unit-write-and-enable skeleton with only scheduling config, args, and enabled-check differing. This mirrors the existing `installIntervalTrigger` pattern and makes it easier to add new simple triggers in the future.

## Acceptance Criteria

- A new `installSimpleTrigger` function exists in `src/triggers.ts` that generates and installs platform-appropriate service definitions (launchd plist on macOS, systemd units on Linux).
- The `startup`, `mag`, `dashboard`, and `ntfy-subscribe` trigger blocks in both `triggersInstallMacos` and `triggersInstallLinux` are replaced by calls to `installSimpleTrigger`, with each caller resolving its own enabled-check and arguments before calling.
- The generated plist and systemd unit content for each trigger is byte-identical to the current output (no functional change to installed services). Verify by diffing `ludics init --no-triggers` dry-run output before and after, or by inspecting the generated files.
- The `morning`, `health`, and watch triggers are NOT refactored (their scheduling logic is bespoke and would add complexity to the helper).
- `installIntervalTrigger` is unchanged.
- All existing tests pass. No new tests required (this is a pure refactoring with no behavior change and no public API changes).
- The file compiles cleanly (`bun run build` succeeds).

## Context

### Current state

`src/triggers.ts` contains two platform-specific install functions:

- `triggersInstallMacos()` (line 124) -- builds plist XML and calls `installPlist`
- `triggersInstallLinux()` (line 339) -- calls `writeSystemdUnit` + `enableSystemdUnit`

The four candidate triggers each follow this skeleton:

**macOS pattern:**
```
if (enabled) {
  const label = "com.ludics.<name>";
  const content = [PLIST_HEADER, Label, <scheduling keys>, plistEnv(), plistArgs(bin, ...args), plistLogs(name), PLIST_FOOTER].join("\n");
  installPlist(label, content);
  console.log(...);
}
```

**Linux pattern:**
```
if (enabled) {
  writeSystemdUnit("ludics-<name>.service", serviceUnitContent);
  // optionally: writeSystemdUnit("ludics-<name>.timer", timerContent);
  enableSystemdUnit("ludics-<name>.<activation-unit>");
  console.log(...);
}
```

### Divergences between the four triggers

| Trigger | macOS scheduling keys | Linux unit type | Enabled check | Args |
|---|---|---|---|---|
| `startup` | `RunAtLoad: true` | `.service` with `WantedBy=default.target` | `triggerGet("startup","enabled") === "true"` | action from config |
| `mag` | `RunAtLoad: true` + `StartInterval` | `.timer` with `OnBootSec=60` + `OnUnitActiveSec` | `config.mag.enabled === true\|"true"` | `["mag", "start"]` (hardcoded) |
| `dashboard` | `KeepAlive: true` + `RunAtLoad: true` | `.service` with `Restart=on-failure`, `WantedBy=default.target` | `triggerGet("dashboard","enabled") === "true"` | `["dashboard", "serve", port]` |
| `ntfy-subscribe` | `KeepAlive: true` + `RunAtLoad: true` | `.service` with `Restart=on-failure`, `WantedBy=default.target` | `!!config.notifications?.topics?.incoming` | `["notify", "subscribe"]` |

### Existing `installIntervalTrigger` (line 309)

This is the model to follow. It is a cross-platform helper: checks `process.platform`, builds plist or systemd units accordingly, and logs. The new helper will follow the same structure but accept a `SimpleTriggerSpec` instead of an interval parameter.

### Key helpers already available

- `plistEnv()`, `plistArgs()`, `plistLogs()`, `PLIST_HEADER`, `PLIST_FOOTER` -- plist XML fragments
- `installPlist(label, content)` -- writes plist and bootstraps via launchctl
- `writeSystemdUnit(name, content)` -- writes unit file to `~/.config/systemd/user/`
- `enableSystemdUnit(unitName)` -- daemon-reload + enable + restart

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### 1. Define the `SimpleTriggerSpec` type (above `installSimpleTrigger`)

```typescript
type SimpleTriggerSpec = {
  /** macOS plist scheduling lines (between Label and EnvironmentVariables) */
  plistScheduling: string;
  /** systemd [Service] section body (everything after [Unit] section) */
  systemdServiceBody: string;
  /** Optional: systemd activation unit type ("timer") if a secondary unit is needed */
  systemdActivationUnit?: string;
  /** Optional: full content of the systemd timer/path unit file */
  systemdActivationBody?: string;
  /** Log file name suffix (defaults to `name`) */
  logName?: string;
};
```

### 2. Implement `installSimpleTrigger`

Place it near `installIntervalTrigger` (around line 308). The function:

```typescript
function installSimpleTrigger(
  name: string,
  description: string,
  args: string[],
  isEnabled: boolean,
  spec: SimpleTriggerSpec,
  logMessage: string,
): void {
  if (!isEnabled) return;
  const bin = binPath();
  const logName = spec.logName ?? name;

  if (process.platform === "darwin") {
    const label = `com.ludics.${name}`;
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      spec.plistScheduling,
      plistEnv(),
      plistArgs(bin, ...args),
      plistLogs(logName),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
  } else {
    writeSystemdUnit(`ludics-${name}.service`,
      `[Unit]\nDescription=ludics ${description}\n\n${spec.systemdServiceBody}`);
    if (spec.systemdActivationUnit && spec.systemdActivationBody) {
      writeSystemdUnit(`ludics-${name}.${spec.systemdActivationUnit}`,
        spec.systemdActivationBody);
      enableSystemdUnit(`ludics-${name}.${spec.systemdActivationUnit}`);
    } else {
      enableSystemdUnit(`ludics-${name}.service`);
    }
  }

  const platform = process.platform === "darwin" ? "launchd" : "systemd";
  console.log(`Installed ${platform} trigger: ${logMessage}`);
}
```

### 3. Replace the four trigger blocks

Each trigger block in both `triggersInstallMacos` and `triggersInstallLinux` is replaced by a single `installSimpleTrigger(...)` call. The enabled-check and arg resolution remain in the caller (before the call). Examples:

**startup:**
```typescript
installSimpleTrigger("startup", "startup trigger",
  action.split(" "),
  triggerGet("startup", "enabled") === "true",
  {
    plistScheduling: `  <key>RunAtLoad</key>\n  <true/>`,
    systemdServiceBody: `[Service]\nType=oneshot\nExecStart=${bin} ${action}\n\n[Install]\nWantedBy=default.target\n`,
  },
  "startup");
```

**mag:**
```typescript
installSimpleTrigger("mag", "Mag keepalive",
  ["mag", "start"],
  magEnabled === true || magEnabled === "true",
  {
    plistScheduling: `  <key>RunAtLoad</key>\n  <true/>\n  <key>StartInterval</key>\n  <integer>${keepaliveInterval}</integer>`,
    systemdServiceBody: `[Service]\nType=oneshot\nExecStart=${bin} mag start\n`,
    systemdActivationUnit: "timer",
    systemdActivationBody: `[Unit]\nDescription=ludics Mag keepalive timer\n\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=${keepaliveInterval}s\nUnit=ludics-mag.service\n\n[Install]\nWantedBy=timers.target\n`,
  },
  `mag (keepalive every ${intervalLabel})`);
```

**dashboard:**
```typescript
installSimpleTrigger("dashboard", "dashboard server",
  ["dashboard", "serve", port],
  triggerGet("dashboard", "enabled") === "true",
  {
    plistScheduling: `  <key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>\n  <true/>`,
    systemdServiceBody: `[Service]\nType=simple\nExecStart=${bin} dashboard serve ${port}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
  },
  `dashboard (port ${port}, KeepAlive)`);
```

**ntfy-subscribe:**
```typescript
installSimpleTrigger("ntfy-subscribe", "ntfy incoming message subscriber",
  ["notify", "subscribe"],
  !!incomingTopic,
  {
    plistScheduling: `  <key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>\n  <true/>`,
    systemdServiceBody: `[Service]\nType=simple\nExecStart=${bin} notify subscribe\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
  },
  "ntfy-subscribe (KeepAlive)");
```

### 4. Remove dead code from both platform functions

After replacement, `triggersInstallMacos` and `triggersInstallLinux` no longer need the inline blocks for these four triggers. The `config` variable and `magEnabled`/`keepaliveInterval`/`port`/`incomingTopic` reads should remain (they feed into the `installSimpleTrigger` calls).

### 5. Validate

- `bun run build` compiles cleanly
- Run `bun test` to confirm all tests pass
- On macOS: `ludics init` and verify the installed plist files are identical to the pre-refactor versions (diff `~/Library/LaunchAgents/com.ludics.*.plist`)
