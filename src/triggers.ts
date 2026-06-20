// Trigger installation — launchd (macOS) and systemd (Linux)

import { existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { loadConfigSync, ludicsRoot } from "./config.ts";
import { safeSyncOutput } from "./spawn.ts";
import { clusterRole } from "./cluster.ts";

const KNOWN_LUDICS_TRIGGER_NAMES = [
  "startup",
  "sync",
  "morning",
  "health",
  "sessions",
  "sessions-sweep",
  "cluster",
  "mag",
  "dashboard",
  "ntfy-subscribe",
  "t3code-cleanup",
];

/**
 * Triggers that are leader/controller duties — never installed on a worker node
 * (AC 7). Installing these on a worker would be split-brain pollution (a second
 * dashboard server, duplicate morning briefings / health checks, a duplicate ntfy
 * subscriber, and repo/staging sync + watch automation that belong to the leader).
 */
export const CONTROLLER_ONLY_TRIGGER_NAMES: ReadonlySet<string> = new Set([
  "dashboard",
  "ntfy-subscribe",
  "morning",
  "health",
  "sync",
  "watch",
]);

/**
 * Whether a trigger named `name` should be installed for the given cluster role.
 * Workers install only worker-relevant units (startup, mag keepalive, cluster
 * heartbeat, sessions adoption/sweeper, t3code-cleanup); controllers and
 * standalone nodes install everything (still subject to per-trigger enabled
 * checks at each call site).
 */
export function triggerAllowedForRole(
  name: string,
  role: "controller" | "worker" | "standalone",
): boolean {
  if (role === "worker") return !CONTROLLER_ONLY_TRIGGER_NAMES.has(name);
  return true;
}

/**
 * Disable + delete any installed unit(s) for trigger `name`. Used on a worker to
 * actively remove controller-only units left over from a prior standalone /
 * controller install (AC 7): skip-only logging in the install paths does not stop
 * an already-running `ludics-dashboard` (etc.) unit, so re-running `triggers
 * install` after a role change would otherwise leave leader duties running on the
 * worker. `platform` is injectable for tests; both branches read `HOME`.
 */
export function removeControllerTriggerUnits(
  name: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    const agentsDir = join(process.env.HOME!, "Library/LaunchAgents");
    if (!existsSync(agentsDir)) return;
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const removeLabel = (label: string): void => {
      const plist = join(agentsDir, `${label}.plist`);
      if (!existsSync(plist)) return;
      safeSyncOutput(["launchctl", "disable", `gui/${uid}/${label}`]);
      safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
      unlinkSync(plist);
      console.log(`Removed stale controller trigger on worker: ${label.replace("com.ludics.", "")}`);
    };
    if (name === "watch") {
      for (const f of readdirSync(agentsDir)) {
        if (f.startsWith("com.ludics.watch-") && f.endsWith(".plist")) removeLabel(f.replace(".plist", ""));
      }
    } else {
      removeLabel(`com.ludics.${name}`);
    }
  } else if (platform === "linux") {
    const systemdDir = join(process.env.HOME!, ".config/systemd/user");
    if (!existsSync(systemdDir)) return;
    const removeUnit = (unit: string): void => {
      const f = join(systemdDir, unit);
      if (!existsSync(f)) return;
      safeSyncOutput(["systemctl", "--user", "disable", "--now", unit]);
      unlinkSync(f);
      console.log(`Removed stale controller trigger on worker: ${unit}`);
    };
    if (name === "watch") {
      for (const f of readdirSync(systemdDir)) {
        if (f.startsWith("ludics-watch-") && (f.endsWith(".service") || f.endsWith(".path"))) removeUnit(f);
      }
    } else {
      for (const ext of ["timer", "service", "path"]) removeUnit(`ludics-${name}.${ext}`);
    }
  }
}

function binPath(): string {
  // The binary is the compiled entry point
  return join(ludicsRoot(), "bin", "ludics");
}

function sanitizeAction(action: string): string {
  return action.replace(/ /g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
}

function commandFromAction(action: string): string {
  return action || "mag briefing --auto";
}

function triggerGet(section: string, key: string): string {
  const config = loadConfigSync();
  const triggers = config.triggers as Record<string, unknown> | undefined;
  if (!triggers) return "";
  const sectionData = triggers[section] as Record<string, unknown> | undefined;
  if (!sectionData) return "";
  const val = sectionData[key];
  if (val === null || val === undefined) return "";
  return String(val);
}

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

function triggerGetWatchRules(): { action: string; paths: string[] }[] {
  const config = loadConfigSync();
  const triggers = config.triggers as Record<string, unknown> | undefined;
  if (!triggers) return [];
  const watch = triggers.watch as Array<{ paths?: string[]; action?: string }> | undefined;
  if (!Array.isArray(watch)) return [];

  return watch
    .filter((r) => r.action && Array.isArray(r.paths) && r.paths.length > 0)
    .map((r) => ({
      action: String(r.action),
      paths: r.paths!.map((p) => p.replace(/^~/, process.env.HOME!)),
    }));
}

// --- Plist generation helpers ---

const PLIST_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>`;

const PLIST_FOOTER = `</dict>
</plist>`;

function plistEnv(): string {
  return `  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin</string>
  </dict>`;
}

function plistArgs(bin: string, ...args: string[]): string {
  let xml = `  <key>ProgramArguments</key>\n  <array>\n    <string>${bin}</string>\n`;
  for (const arg of args) {
    xml += `    <string>${arg}</string>\n`;
  }
  xml += `  </array>`;
  return xml;
}

function plistLogs(name: string): string {
  return `  <key>StandardOutPath</key>
  <string>${process.env.HOME}/Library/Logs/ludics-${name}.log</string>
  <key>StandardErrorPath</key>
  <string>${process.env.HOME}/Library/Logs/ludics-${name}.err</string>`;
}

function installPlist(label: string, content: string): void {
  const agentsDir = join(process.env.HOME!, "Library/LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  const plist = join(agentsDir, `${label}.plist`);

  writeFileSync(plist, content);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  safeSyncOutput(["launchctl", "enable", `gui/${uid}/${label}`]);
  // Use bootout/bootstrap (modern API) instead of deprecated load/unload
  safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
  safeSyncOutput(["launchctl", "bootstrap", `gui/${uid}`, plist]);
}

// --- macOS launchd ---

function triggersInstallMacos(): void {
  const bin = binPath();
  const role = clusterRole();

  // Interval-based triggers (sync is controller-only — AC 7)
  if (triggerAllowedForRole("sync", role)) {
    installIntervalTrigger("sync", "sync trigger", 3600);
  } else {
    console.log("Skipping controller trigger on worker: sync");
  }

  // Morning briefing trigger (controller-only — AC 7)
  if (triggerAllowedForRole("morning", role) && triggerGet("morning", "enabled") === "true") {
    const action = commandFromAction(triggerGet("morning", "action"));
    const hour = triggerGet("morning", "hour") || "8";
    const minute = triggerGet("morning", "minute") || "0";
    const label = "com.ludics.morning";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${hour}</integer>\n    <key>Minute</key>\n    <integer>${minute}</integer>\n  </dict>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("morning"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: morning (daily at ${hour}:${minute.padStart(2, "0")})`);
  }

  // Health check trigger (controller-only — AC 7)
  if (triggerAllowedForRole("health", role) && triggerGet("health", "enabled") === "true") {
    const action = commandFromAction(triggerGet("health", "action"));
    const label = "com.ludics.health";
    const schedule = triggerGetSchedule("health");

    let scheduleXml: string;
    if (schedule && schedule.length > 0) {
      const entries = schedule
        .map(({ hour, minute }) =>
          `    <dict>\n      <key>Hour</key>\n      <integer>${hour}</integer>\n      <key>Minute</key>\n      <integer>${minute}</integer>\n    </dict>`
        )
        .join("\n");
      scheduleXml = `  <key>StartCalendarInterval</key>\n  <array>\n${entries}\n  </array>`;
    } else {
      const interval = triggerGet("health", "interval") || "14400";
      scheduleXml = `  <key>StartInterval</key>\n  <integer>${interval}</integer>`;
    }

    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      scheduleXml,
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

  installIntervalTrigger("sessions", "session adoption", 300);
  installIntervalTrigger("sessions-sweep", "detached session sweeper", 86400);
  installIntervalTrigger("t3code-cleanup", "t3code stale thread cleanup", 86400);

  // Watch triggers (controller-only — AC 7)
  for (const rule of triggerAllowedForRole("watch", role) ? triggerGetWatchRules() : []) {
    const sanitized = sanitizeAction(rule.action);
    const label = `com.ludics.watch-${sanitized}`;
    const actionCmd = commandFromAction(rule.action);

    let watchPaths = `  <key>WatchPaths</key>\n  <array>\n`;
    for (const p of rule.paths) {
      watchPaths += `    <string>${p}</string>\n`;
    }
    watchPaths += `  </array>`;

    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      watchPaths,
      plistEnv(),
      plistArgs(bin, ...actionCmd.split(" ")),
      plistLogs(`watch-${sanitized}`),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: watch-${sanitized} (${rule.paths.length} paths)`);
  }

  installIntervalTrigger("cluster", "cluster heartbeat", 300);

  installSimpleTriggers();
}

// --- Linux systemd ---

function writeSystemdUnit(name: string, content: string): void {
  const dir = join(process.env.HOME!, ".config/systemd/user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function enableSystemdUnit(unitName: string): void {
  safeSyncOutput(["systemctl", "--user", "daemon-reload"]);
  safeSyncOutput(["systemctl", "--user", "enable", "--now", unitName]);
  // Restart to pick up changed unit definitions (enable --now alone may keep the old config)
  safeSyncOutput(["systemctl", "--user", "restart", unitName]);
}

type SimpleTriggerSpec = {
  /** macOS plist scheduling lines (between Label and EnvironmentVariables) */
  plistScheduling: string;
  /** systemd [Service] section body (everything after [Unit] section) */
  systemdServiceBody: string;
  /** Optional: systemd activation unit type ("timer") if a secondary unit is needed */
  systemdActivationUnit?: string;
  /** Optional: full content of the systemd timer/path unit file */
  systemdActivationBody?: string;
  /** Log file name suffix (defaults to name) */
  logName?: string;
};

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

function installIntervalTrigger(name: string, description: string, defaultInterval: number): void {
  if (triggerGet(name, "enabled") !== "true") return;
  const bin = binPath();
  const action = commandFromAction(triggerGet(name, "action"));
  const interval = triggerGet(name, "interval") || String(defaultInterval);

  if (process.platform === "darwin") {
    const label = `com.ludics.${name}`;
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
    writeSystemdUnit(`ludics-${name}.service`, `[Unit]\nDescription=ludics ${description}\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit(`ludics-${name}.timer`, `[Unit]\nDescription=ludics ${description} timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-${name}.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit(`ludics-${name}.timer`);
  }

  const secs = parseInt(interval);
  const desc = secs >= 3600 ? `${Math.floor(secs / 3600)}h` : `${Math.floor(secs / 60)}m`;
  const platform = process.platform === "darwin" ? "launchd" : "systemd";
  console.log(`Installed ${platform} trigger: ${name} (every ${desc})`);
}

function installSimpleTriggers(): void {
  const bin = binPath();
  const role = clusterRole();

  // Startup
  const startupAction = commandFromAction(triggerGet("startup", "action"));
  installSimpleTrigger("startup", "startup trigger",
    startupAction.split(" "),
    triggerGet("startup", "enabled") === "true",
    {
      plistScheduling: `  <key>RunAtLoad</key>\n  <true/>`,
      systemdServiceBody: `[Service]\nType=oneshot\nExecStart=${bin} ${startupAction}\n\n[Install]\nWantedBy=default.target\n`,
    },
    "startup");

  // Mag keepalive
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const magEnabled = mag?.enabled;
  const keepaliveInterval = String(mag?.keepalive_interval ?? "60");
  const magSecs = parseInt(keepaliveInterval);
  const intervalLabel = magSecs >= 60 ? `${Math.floor(magSecs / 60)}m${magSecs % 60 ? magSecs % 60 + "s" : ""}` : `${magSecs}s`;
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

  // Dashboard (controller-only — skipped on workers, AC 7)
  if (triggerAllowedForRole("dashboard", role)) {
    let dashPort = triggerGet("dashboard", "port");
    if (!dashPort) dashPort = String(config.dashboard?.port ?? 7678);
    installSimpleTrigger("dashboard", "dashboard server",
      ["dashboard", "serve", dashPort],
      triggerGet("dashboard", "enabled") === "true",
      {
        plistScheduling: `  <key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>\n  <true/>`,
        systemdServiceBody: `[Service]\nType=simple\nExecStart=${bin} dashboard serve ${dashPort}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
      },
      `dashboard (port ${dashPort}, KeepAlive)`);
  } else {
    console.log("Skipping controller trigger on worker: dashboard");
  }

  // ntfy-subscribe (incoming messages) — controller-only (AC 7)
  if (triggerAllowedForRole("ntfy-subscribe", role)) {
    const incomingTopic = config.notifications?.topics?.incoming;
    installSimpleTrigger("ntfy-subscribe", "ntfy incoming message subscriber",
      ["notify", "subscribe"],
      !!incomingTopic,
      {
        plistScheduling: `  <key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>\n  <true/>`,
        systemdServiceBody: `[Service]\nType=simple\nExecStart=${bin} notify subscribe\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
      },
      "ntfy-subscribe (KeepAlive)");
  } else {
    console.log("Skipping controller trigger on worker: ntfy-subscribe");
  }
}

function triggersInstallLinux(): void {
  const bin = binPath();
  const role = clusterRole();

  // Interval-based triggers (sync is controller-only — AC 7)
  if (triggerAllowedForRole("sync", role)) {
    installIntervalTrigger("sync", "sync trigger", 3600);
  } else {
    console.log("Skipping controller trigger on worker: sync");
  }

  // Morning (controller-only — AC 7)
  if (triggerAllowedForRole("morning", role) && triggerGet("morning", "enabled") === "true") {
    const action = commandFromAction(triggerGet("morning", "action"));
    const hour = triggerGet("morning", "hour") || "8";
    const minute = (triggerGet("morning", "minute") || "0").padStart(2, "0");
    writeSystemdUnit("ludics-morning.service", `[Unit]\nDescription=ludics morning briefing\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-morning.timer", `[Unit]\nDescription=ludics morning briefing timer\n\n[Timer]\nOnCalendar=*-*-* ${hour}:${minute}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-morning.timer");
    console.log(`Installed systemd trigger: morning (daily at ${hour}:${minute})`);
  }

  // Health (controller-only — AC 7)
  if (triggerAllowedForRole("health", role) && triggerGet("health", "enabled") === "true") {
    const action = commandFromAction(triggerGet("health", "action"));
    const schedule = triggerGetSchedule("health");
    writeSystemdUnit("ludics-health.service", `[Unit]\nDescription=ludics health check\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);

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

    writeSystemdUnit("ludics-health.timer", `[Unit]\nDescription=ludics health check timer\n\n${timerSection}\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-health.timer");

    const desc = schedule
      ? schedule.map(({ hour, minute }) => `${hour}:${String(minute).padStart(2, "0")}`).join(", ")
      : "interval";
    console.log(`Installed systemd trigger: health (${desc})`);
  }

  installIntervalTrigger("sessions", "session adoption", 300);
  installIntervalTrigger("sessions-sweep", "detached session sweeper", 86400);
  installIntervalTrigger("t3code-cleanup", "t3code stale thread cleanup", 86400);

  // Watch (controller-only — AC 7)
  for (const rule of triggerAllowedForRole("watch", role) ? triggerGetWatchRules() : []) {
    const sanitized = sanitizeAction(rule.action);
    const unitName = `ludics-watch-${sanitized}`;
    const actionCmd = commandFromAction(rule.action);

    writeSystemdUnit(`${unitName}.service`, `[Unit]\nDescription=ludics watch trigger (${rule.action})\n\n[Service]\nType=oneshot\nExecStart=${bin} ${actionCmd}\n`);

    let pathUnit = `[Unit]\nDescription=ludics watch for file changes (${rule.action})\n\n[Path]\n`;
    for (const p of rule.paths) {
      pathUnit += `PathModified=${p}\n`;
    }
    pathUnit += `Unit=${unitName}.service\n\n[Install]\nWantedBy=default.target\n`;

    writeSystemdUnit(`${unitName}.path`, pathUnit);
    enableSystemdUnit(`${unitName}.path`);
    console.log(`Installed systemd trigger: watch-${sanitized} (${rule.paths.length} paths)`);
  }

  installIntervalTrigger("cluster", "cluster heartbeat", 300);

  installSimpleTriggers();
}

// --- Pause/Disable ---

function triggersPauseMacos(): void {
  const agentsDir = join(process.env.HOME!, "Library/LaunchAgents");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  let foundAny = false;

  for (const name of KNOWN_LUDICS_TRIGGER_NAMES) {
    const label = `com.ludics.${name}`;
    const plist = join(agentsDir, `${label}.plist`);
    if (!existsSync(plist)) continue;
    foundAny = true;
    safeSyncOutput(["launchctl", "disable", `gui/${uid}/${label}`]);
    safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
    console.log(`Paused launchd trigger: ${name}`);
  }

  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (!f.startsWith("com.ludics.watch-") || !f.endsWith(".plist")) continue;
      foundAny = true;
      const label = f.replace(".plist", "");
      const name = label.replace("com.ludics.", "");
      safeSyncOutput(["launchctl", "disable", `gui/${uid}/${label}`]);
      safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
      console.log(`Paused launchd trigger: ${name}`);
    }
  }

  if (!foundAny) {
    console.log("No ludics launchd triggers installed");
    return;
  }

  console.log("Ludics launchd triggers paused");
}

function triggersPauseLinux(): void {
  const systemdDir = join(process.env.HOME!, ".config/systemd/user");
  let foundAny = false;

  for (const name of KNOWN_LUDICS_TRIGGER_NAMES) {
    const serviceFile = join(systemdDir, `ludics-${name}.service`);
    const timerFile = join(systemdDir, `ludics-${name}.timer`);
    const pathFile = join(systemdDir, `ludics-${name}.path`);
    let hasAny = false;

    if (existsSync(timerFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `ludics-${name}.timer`]);
      hasAny = true;
    }
    if (existsSync(pathFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `ludics-${name}.path`]);
      hasAny = true;
    }
    if (existsSync(serviceFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `ludics-${name}.service`]);
      hasAny = true;
    }

    if (hasAny) {
      foundAny = true;
      console.log(`Paused systemd trigger: ${name}`);
    }
  }

  if (existsSync(systemdDir)) {
    for (const f of readdirSync(systemdDir)) {
      if (!f.startsWith("ludics-watch-") || !f.endsWith(".service")) continue;
      const unitName = f.replace(".service", "");
      const pathFile = join(systemdDir, `${unitName}.path`);
      if (existsSync(pathFile)) {
        safeSyncOutput(["systemctl", "--user", "disable", "--now", `${unitName}.path`]);
      }
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `${unitName}.service`]);
      foundAny = true;
      console.log(`Paused systemd trigger: ${unitName.replace("ludics-", "")}`);
    }
  }

  if (!foundAny) {
    console.log("No ludics systemd triggers installed");
    return;
  }

  console.log("Ludics systemd triggers paused");
}

// --- Uninstall ---

function triggersUninstallMacos(): void {
  const agentsDir = join(process.env.HOME!, "Library/LaunchAgents");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const labels = KNOWN_LUDICS_TRIGGER_NAMES.map((name) => `com.ludics.${name}`);

  for (const label of labels) {
    const plist = join(agentsDir, `${label}.plist`);
    if (existsSync(plist)) {
      safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
      unlinkSync(plist);
      console.log(`Uninstalled launchd trigger: ${label.replace("com.ludics.", "")}`);
    }
  }

  // Watch plists
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.startsWith("com.ludics.watch-") && f.endsWith(".plist")) {
        const label = f.replace(".plist", "");
        const plist = join(agentsDir, f);
        safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
        unlinkSync(plist);
        console.log(`Uninstalled launchd trigger: ${f.replace("com.ludics.", "").replace(".plist", "")}`);
      }
    }
  }

  // Legacy pai-lite triggers
  const legacyLabels = [
    "com.pai-lite.startup", "com.pai-lite.sync", "com.pai-lite.morning",
    "com.pai-lite.health", "com.pai-lite.mayor",
    "com.pai-lite.dashboard",
  ];
  // Also clean up old ludics-era trigger (renamed to "cluster")
  legacyLabels.push("com.ludics." + "feder" + "ation");
  for (const label of legacyLabels) {
    const plist = join(agentsDir, `${label}.plist`);
    if (existsSync(plist)) {
      safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
      unlinkSync(plist);
      console.log(`Uninstalled legacy launchd trigger: ${label}`);
    }
  }
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.startsWith("com.pai-lite.watch-") && f.endsWith(".plist")) {
        const label = f.replace(".plist", "");
        const plist = join(agentsDir, f);
        safeSyncOutput(["launchctl", "bootout", `gui/${uid}/${label}`]);
        unlinkSync(plist);
        console.log(`Uninstalled legacy launchd trigger: ${f.replace(".plist", "")}`);
      }
    }
  }

  console.log("All ludics launchd triggers uninstalled");
}

function triggersUninstallLinux(): void {
  const systemdDir = join(process.env.HOME!, ".config/systemd/user");
  // Include old pre-rename name (now "cluster") for cleanup
  const names = [...KNOWN_LUDICS_TRIGGER_NAMES, "feder" + "ation"];

  for (const name of names) {
    const serviceFile = join(systemdDir, `ludics-${name}.service`);
    const timerFile = join(systemdDir, `ludics-${name}.timer`);
    const pathFile = join(systemdDir, `ludics-${name}.path`);

    if (existsSync(timerFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `ludics-${name}.timer`]);
      unlinkSync(timerFile);
    }
    if (existsSync(pathFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `ludics-${name}.path`]);
      unlinkSync(pathFile);
    }
    if (existsSync(serviceFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `ludics-${name}.service`]);
      unlinkSync(serviceFile);
      console.log(`Uninstalled systemd trigger: ${name}`);
    }
  }

  // Watch units
  if (existsSync(systemdDir)) {
    for (const f of readdirSync(systemdDir)) {
      if (f.startsWith("ludics-watch-") && f.endsWith(".service")) {
        const unitName = f.replace(".service", "");
        const pathFile = join(systemdDir, `${unitName}.path`);
        if (existsSync(pathFile)) {
          safeSyncOutput(["systemctl", "--user", "disable", "--now", `${unitName}.path`]);
          unlinkSync(pathFile);
        }
        safeSyncOutput(["systemctl", "--user", "disable", "--now", `${unitName}.service`]);
        unlinkSync(join(systemdDir, f));
        console.log(`Uninstalled systemd trigger: ${unitName.replace("ludics-", "")}`);
      }
    }
  }

  // Legacy pai-lite units
  const legacyNames = ["startup", "sync", "morning", "health", "mayor", "dashboard"];
  for (const name of legacyNames) {
    const serviceFile = join(systemdDir, `pai-lite-${name}.service`);
    const timerFile = join(systemdDir, `pai-lite-${name}.timer`);
    const pathFile = join(systemdDir, `pai-lite-${name}.path`);

    if (existsSync(timerFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `pai-lite-${name}.timer`]);
      unlinkSync(timerFile);
    }
    if (existsSync(pathFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `pai-lite-${name}.path`]);
      unlinkSync(pathFile);
    }
    if (existsSync(serviceFile)) {
      safeSyncOutput(["systemctl", "--user", "disable", "--now", `pai-lite-${name}.service`]);
      unlinkSync(serviceFile);
      console.log(`Uninstalled legacy systemd trigger: pai-lite-${name}`);
    }
  }
  if (existsSync(systemdDir)) {
    for (const f of readdirSync(systemdDir)) {
      if (f.startsWith("pai-lite-watch-") && f.endsWith(".service")) {
        const unitName = f.replace(".service", "");
        const pathFile = join(systemdDir, `${unitName}.path`);
        if (existsSync(pathFile)) {
          safeSyncOutput(["systemctl", "--user", "disable", "--now", `${unitName}.path`]);
          unlinkSync(pathFile);
        }
        safeSyncOutput(["systemctl", "--user", "disable", "--now", `${unitName}.service`]);
        unlinkSync(join(systemdDir, f));
        console.log(`Uninstalled legacy systemd trigger: ${unitName}`);
      }
    }
  }

  safeSyncOutput(["systemctl", "--user", "daemon-reload"]);
  console.log("All ludics systemd triggers uninstalled");
}

// --- Status ---

function triggersStatusMacos(): void {
  const agentsDir = join(process.env.HOME!, "Library/LaunchAgents");
  const labels = KNOWN_LUDICS_TRIGGER_NAMES.map((name) => `com.ludics.${name}`);

  console.log("ludics launchd triggers:");
  console.log("");

  let foundAny = false;

  for (const label of labels) {
    const plist = join(agentsDir, `${label}.plist`);
    if (!existsSync(plist)) continue;
    foundAny = true;

    const name = label.replace("com.ludics.", "");
    const check = safeSyncOutput(["launchctl", "list", label]);
    const status = check.ok ? "loaded" : "not loaded";
    console.log(`  ${name.padEnd(20)} ${status}`);
  }

  // Watch plists
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.startsWith("com.ludics.watch-") && f.endsWith(".plist")) {
        foundAny = true;
        const label = f.replace(".plist", "");
        const name = label.replace("com.ludics.", "");
        const check = safeSyncOutput(["launchctl", "list", label]);
        const status = check.ok ? "loaded" : "not loaded";
        console.log(`  ${name.padEnd(20)} ${status}`);
      }
    }
  }

  if (!foundAny) {
    console.log("  No ludics triggers installed");
  }

  console.log("");
  console.log(`Log files: ${process.env.HOME}/Library/Logs/ludics-*.log`);
}

function triggersStatusLinux(): void {
  const systemdDir = join(process.env.HOME!, ".config/systemd/user");
  const names = KNOWN_LUDICS_TRIGGER_NAMES;

  console.log("ludics systemd triggers:");
  console.log("");

  let foundAny = false;

  for (const name of names) {
    const serviceFile = join(systemdDir, `ludics-${name}.service`);
    if (!existsSync(serviceFile)) continue;
    foundAny = true;

    const timerFile = join(systemdDir, `ludics-${name}.timer`);
    const pathFile = join(systemdDir, `ludics-${name}.path`);

    let unitToCheck = `ludics-${name}.service`;
    if (existsSync(timerFile)) unitToCheck = `ludics-${name}.timer`;
    else if (existsSync(pathFile)) unitToCheck = `ludics-${name}.path`;

    const check = safeSyncOutput(["systemctl", "--user", "is-active", unitToCheck]);
    const status = check.stdout || "inactive";
    console.log(`  ${name.padEnd(20)} ${status}`);
  }

  // Watch units
  if (existsSync(systemdDir)) {
    for (const f of readdirSync(systemdDir)) {
      if (f.startsWith("ludics-watch-") && f.endsWith(".service")) {
        foundAny = true;
        const unitName = f.replace(".service", "");
        const name = unitName.replace("ludics-", "");
        const pathFile = join(systemdDir, `${unitName}.path`);
        const unitToCheck = existsSync(pathFile) ? `${unitName}.path` : `${unitName}.service`;
        const check = safeSyncOutput(["systemctl", "--user", "is-active", unitToCheck]);
        const status = check.stdout || "inactive";
        console.log(`  ${name.padEnd(20)} ${status}`);
      }
    }
  }

  if (!foundAny) {
    console.log("  No ludics triggers installed");
  }

  console.log("");
  console.log("View logs: journalctl --user -u 'ludics-*'");
}

// --- Public API ---

function currentPlatform(): string {
  const result = safeSyncOutput(["uname", "-s"]);
  return result.stdout;
}

export function triggersInstall(): void {
  // AC 7: on a worker, actively remove any controller-only units left by a prior
  // standalone/controller install before (re)installing. The install paths below
  // only *skip* controller units (they don't stop ones already running), so
  // without this an upgraded worker keeps a stale dashboard/briefing/health/etc.
  // unit alive — split-brain that the role gate is meant to prevent.
  if (clusterRole() === "worker") {
    for (const name of CONTROLLER_ONLY_TRIGGER_NAMES) removeControllerTriggerUnits(name);
  }

  const platform = currentPlatform();
  switch (platform) {
    case "Darwin":
      triggersInstallMacos();
      break;
    case "Linux":
      triggersInstallLinux();
      break;
    default:
      throw new Error(`unsupported OS for triggers: ${platform}`);
  }
}

export function triggersUninstall(): void {
  const platform = currentPlatform();
  switch (platform) {
    case "Darwin":
      triggersUninstallMacos();
      break;
    case "Linux":
      triggersUninstallLinux();
      break;
    default:
      throw new Error(`unsupported OS for triggers: ${platform}`);
  }
}

export function triggersPause(): void {
  const platform = currentPlatform();
  switch (platform) {
    case "Darwin":
      triggersPauseMacos();
      break;
    case "Linux":
      triggersPauseLinux();
      break;
    default:
      throw new Error(`unsupported OS for triggers: ${platform}`);
  }
}

export function triggersStatus(): void {
  const platform = currentPlatform();
  switch (platform) {
    case "Darwin":
      triggersStatusMacos();
      break;
    case "Linux":
      triggersStatusLinux();
      break;
    default:
      throw new Error(`unsupported OS for triggers: ${platform}`);
  }
}

export async function runTriggers(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "install":
      triggersInstall();
      break;
    case "pause":
    case "disable":
      triggersPause();
      break;
    case "uninstall":
      triggersUninstall();
      break;
    case "status":
    case "":
      triggersStatus();
      break;
    default:
      throw new Error(`unknown triggers command: ${sub} (use: install, pause, uninstall, status)`);
  }
}
