// Trigger installation — launchd (macOS) and systemd (Linux)

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { loadConfigSync, ludicsRoot } from "./config.ts";

const KNOWN_LUDICS_TRIGGER_NAMES = [
  "startup",
  "sync",
  "morning",
  "health",
  "sessions",
  "sessions-sweep",
  "federation",
  "mag",
  "dashboard",
  "ntfy-subscribe",
];

function binPath(): string {
  // The binary is the compiled entry point
  return join(ludicsRoot(), "bin", "ludics");
}

function sanitizeAction(action: string): string {
  return action.replace(/ /g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
}

function commandFromAction(action: string): string {
  return action || "mag briefing";
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
  Bun.spawnSync(["launchctl", "enable", `gui/${uid}/${label}`], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["launchctl", "load", plist], { stdout: "pipe", stderr: "pipe" });
}

// --- macOS launchd ---

function triggersInstallMacos(): void {
  const bin = binPath();

  // Startup trigger
  if (triggerGet("startup", "enabled") === "true") {
    const action = commandFromAction(triggerGet("startup", "action"));
    const label = "com.ludics.startup";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>RunAtLoad</key>\n  <true/>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("startup"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log("Installed launchd trigger: startup");
  }

  // Sync trigger
  if (triggerGet("sync", "enabled") === "true") {
    const action = commandFromAction(triggerGet("sync", "action"));
    const interval = triggerGet("sync", "interval") || "3600";
    const label = "com.ludics.sync";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("sync"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log("Installed launchd trigger: sync");
  }

  // Morning briefing trigger
  if (triggerGet("morning", "enabled") === "true") {
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

  // Health check trigger
  if (triggerGet("health", "enabled") === "true") {
    const action = commandFromAction(triggerGet("health", "action"));
    const interval = triggerGet("health", "interval") || "14400";
    const label = "com.ludics.health";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("health"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: health (every ${Math.floor(parseInt(interval) / 3600)}h)`);
  }

  // Sessions adoption trigger
  if (triggerGet("sessions", "enabled") === "true") {
    const action = commandFromAction(triggerGet("sessions", "action"));
    const interval = triggerGet("sessions", "interval") || "300";
    const label = "com.ludics.sessions";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("sessions"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: sessions (every ${Math.floor(parseInt(interval) / 60)}m)`);
  }

  // Sessions cleanup sweeper trigger
  if (triggerGet("sessions-sweep", "enabled") === "true") {
    const action = commandFromAction(triggerGet("sessions-sweep", "action"));
    const interval = triggerGet("sessions-sweep", "interval") || "86400";
    const label = "com.ludics.sessions-sweep";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("sessions-sweep"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: sessions-sweep (every ${Math.floor(parseInt(interval) / 3600)}h)`);
  }

  // Watch triggers
  for (const rule of triggerGetWatchRules()) {
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

  // Federation trigger
  if (triggerGet("federation", "enabled") === "true") {
    const action = commandFromAction(triggerGet("federation", "action"));
    const interval = triggerGet("federation", "interval") || "300";
    const label = "com.ludics.federation";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>StartInterval</key>\n  <integer>${interval}</integer>`,
      plistEnv(),
      plistArgs(bin, ...action.split(" ")),
      plistLogs("federation"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: federation (every ${Math.floor(parseInt(interval) / 60)}m)`);
  }

  // Mag keepalive
  const config = loadConfigSync();
  const magEnabled = (config.mag as Record<string, unknown> | undefined)?.enabled;
  if (magEnabled === true || magEnabled === "true") {
    const mag = config.mag as Record<string, unknown> | undefined;
    const keepaliveInterval = String(mag?.keepalive_interval ?? "60");
    const label = "com.ludics.mag";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>RunAtLoad</key>\n  <true/>`,
      `  <key>StartInterval</key>\n  <integer>${keepaliveInterval}</integer>`,
      plistEnv(),
      plistArgs(bin, "mag", "start"),
      plistLogs("mag"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    const secs = parseInt(keepaliveInterval);
    const intervalLabel = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60 ? secs % 60 + "s" : ""}` : `${secs}s`;
    console.log(`Installed launchd trigger: mag (keepalive every ${intervalLabel})`);
  }

  // Dashboard trigger
  if (triggerGet("dashboard", "enabled") === "true") {
    let port = triggerGet("dashboard", "port");
    if (!port) port = String(config.dashboard?.port ?? 7678);
    const label = "com.ludics.dashboard";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>KeepAlive</key>\n  <true/>`,
      `  <key>RunAtLoad</key>\n  <true/>`,
      plistEnv(),
      plistArgs(bin, "dashboard", "serve", port),
      plistLogs("dashboard"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log(`Installed launchd trigger: dashboard (port ${port}, KeepAlive)`);
  }

  // ntfy-subscribe (incoming messages)
  const incomingTopic = config.notifications?.topics?.incoming;
  if (incomingTopic) {
    const label = "com.ludics.ntfy-subscribe";
    const content = [
      PLIST_HEADER,
      `  <key>Label</key>\n  <string>${label}</string>`,
      `  <key>KeepAlive</key>\n  <true/>`,
      `  <key>RunAtLoad</key>\n  <true/>`,
      plistEnv(),
      plistArgs(bin, "notify", "subscribe"),
      plistLogs("ntfy-subscribe"),
      PLIST_FOOTER,
    ].join("\n");
    installPlist(label, content);
    console.log("Installed launchd trigger: ntfy-subscribe (KeepAlive)");
  }
}

// --- Linux systemd ---

function writeSystemdUnit(name: string, content: string): void {
  const dir = join(process.env.HOME!, ".config/systemd/user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

function enableSystemdUnit(unitName: string): void {
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["systemctl", "--user", "enable", "--now", unitName], { stdout: "pipe", stderr: "pipe" });
}

function triggersInstallLinux(): void {
  const bin = binPath();

  // Startup
  if (triggerGet("startup", "enabled") === "true") {
    const action = commandFromAction(triggerGet("startup", "action"));
    writeSystemdUnit("ludics-startup.service", `[Unit]\nDescription=ludics startup trigger\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n\n[Install]\nWantedBy=default.target\n`);
    enableSystemdUnit("ludics-startup.service");
    console.log("Installed systemd trigger: startup");
  }

  // Sync
  if (triggerGet("sync", "enabled") === "true") {
    const action = commandFromAction(triggerGet("sync", "action"));
    const interval = triggerGet("sync", "interval") || "3600";
    writeSystemdUnit("ludics-sync.service", `[Unit]\nDescription=ludics sync trigger\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-sync.timer", `[Unit]\nDescription=ludics sync timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-sync.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-sync.timer");
    console.log("Installed systemd trigger: sync");
  }

  // Morning
  if (triggerGet("morning", "enabled") === "true") {
    const action = commandFromAction(triggerGet("morning", "action"));
    const hour = triggerGet("morning", "hour") || "8";
    const minute = (triggerGet("morning", "minute") || "0").padStart(2, "0");
    writeSystemdUnit("ludics-morning.service", `[Unit]\nDescription=ludics morning briefing\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-morning.timer", `[Unit]\nDescription=ludics morning briefing timer\n\n[Timer]\nOnCalendar=*-*-* ${hour}:${minute}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-morning.timer");
    console.log(`Installed systemd trigger: morning (daily at ${hour}:${minute})`);
  }

  // Health
  if (triggerGet("health", "enabled") === "true") {
    const action = commandFromAction(triggerGet("health", "action"));
    const interval = triggerGet("health", "interval") || "14400";
    writeSystemdUnit("ludics-health.service", `[Unit]\nDescription=ludics health check\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-health.timer", `[Unit]\nDescription=ludics health check timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-health.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-health.timer");
    console.log(`Installed systemd trigger: health (every ${Math.floor(parseInt(interval) / 3600)}h)`);
  }

  // Sessions adoption
  if (triggerGet("sessions", "enabled") === "true") {
    const action = commandFromAction(triggerGet("sessions", "action"));
    const interval = triggerGet("sessions", "interval") || "300";
    writeSystemdUnit("ludics-sessions.service", `[Unit]\nDescription=ludics session adoption\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-sessions.timer", `[Unit]\nDescription=ludics session adoption timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-sessions.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-sessions.timer");
    console.log(`Installed systemd trigger: sessions (every ${Math.floor(parseInt(interval) / 60)}m)`);
  }

  // Sessions cleanup sweeper
  if (triggerGet("sessions-sweep", "enabled") === "true") {
    const action = commandFromAction(triggerGet("sessions-sweep", "action"));
    const interval = triggerGet("sessions-sweep", "interval") || "86400";
    writeSystemdUnit("ludics-sessions-sweep.service", `[Unit]\nDescription=ludics detached session sweeper\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-sessions-sweep.timer", `[Unit]\nDescription=ludics detached session sweeper timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-sessions-sweep.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-sessions-sweep.timer");
    console.log(`Installed systemd trigger: sessions-sweep (every ${Math.floor(parseInt(interval) / 3600)}h)`);
  }

  // Watch
  for (const rule of triggerGetWatchRules()) {
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

  // Federation
  if (triggerGet("federation", "enabled") === "true") {
    const action = commandFromAction(triggerGet("federation", "action"));
    const interval = triggerGet("federation", "interval") || "300";
    writeSystemdUnit("ludics-federation.service", `[Unit]\nDescription=ludics federation heartbeat\n\n[Service]\nType=oneshot\nExecStart=${bin} ${action}\n`);
    writeSystemdUnit("ludics-federation.timer", `[Unit]\nDescription=ludics federation timer\n\n[Timer]\nOnUnitActiveSec=${interval}s\nUnit=ludics-federation.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-federation.timer");
    console.log(`Installed systemd trigger: federation (every ${Math.floor(parseInt(interval) / 60)}m)`);
  }

  // Mag keepalive
  const config = loadConfigSync();
  const magEnabled = (config.mag as Record<string, unknown> | undefined)?.enabled;
  if (magEnabled === true || magEnabled === "true") {
    const mag = config.mag as Record<string, unknown> | undefined;
    const keepaliveInterval = String(mag?.keepalive_interval ?? "60");
    writeSystemdUnit("ludics-mag.service", `[Unit]\nDescription=ludics Mag keepalive\n\n[Service]\nType=oneshot\nExecStart=${bin} mag start\n`);
    writeSystemdUnit("ludics-mag.timer", `[Unit]\nDescription=ludics Mag keepalive timer\n\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=${keepaliveInterval}s\nUnit=ludics-mag.service\n\n[Install]\nWantedBy=timers.target\n`);
    enableSystemdUnit("ludics-mag.timer");
    const secs = parseInt(keepaliveInterval);
    const intervalLabel = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60 ? secs % 60 + "s" : ""}` : `${secs}s`;
    console.log(`Installed systemd trigger: mag (keepalive every ${intervalLabel})`);
  }

  // Dashboard
  if (triggerGet("dashboard", "enabled") === "true") {
    let port = triggerGet("dashboard", "port");
    if (!port) port = String(config.dashboard?.port ?? 7678);
    writeSystemdUnit("ludics-dashboard.service", `[Unit]\nDescription=ludics dashboard server\n\n[Service]\nType=simple\nExecStart=${bin} dashboard serve ${port}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
    enableSystemdUnit("ludics-dashboard.service");
    console.log(`Installed systemd trigger: dashboard (port ${port})`);
  }

  // ntfy-subscribe (incoming messages)
  const incomingTopic = config.notifications?.topics?.incoming;
  if (incomingTopic) {
    writeSystemdUnit("ludics-ntfy-subscribe.service", `[Unit]\nDescription=ludics ntfy incoming message subscriber\n\n[Service]\nType=simple\nExecStart=${bin} notify subscribe\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
    enableSystemdUnit("ludics-ntfy-subscribe.service");
    console.log("Installed systemd trigger: ntfy-subscribe");
  }
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
    Bun.spawnSync(["launchctl", "disable", `gui/${uid}/${label}`], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
    console.log(`Paused launchd trigger: ${name}`);
  }

  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (!f.startsWith("com.ludics.watch-") || !f.endsWith(".plist")) continue;
      foundAny = true;
      const label = f.replace(".plist", "");
      const name = label.replace("com.ludics.", "");
      const plist = join(agentsDir, f);
      Bun.spawnSync(["launchctl", "disable", `gui/${uid}/${label}`], { stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
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
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `ludics-${name}.timer`], { stdout: "pipe", stderr: "pipe" });
      hasAny = true;
    }
    if (existsSync(pathFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `ludics-${name}.path`], { stdout: "pipe", stderr: "pipe" });
      hasAny = true;
    }
    if (existsSync(serviceFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `ludics-${name}.service`], { stdout: "pipe", stderr: "pipe" });
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
        Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unitName}.path`], { stdout: "pipe", stderr: "pipe" });
      }
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unitName}.service`], { stdout: "pipe", stderr: "pipe" });
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
  const labels = KNOWN_LUDICS_TRIGGER_NAMES.map((name) => `com.ludics.${name}`);

  for (const label of labels) {
    const plist = join(agentsDir, `${label}.plist`);
    if (existsSync(plist)) {
      Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
      unlinkSync(plist);
      console.log(`Uninstalled launchd trigger: ${label.replace("com.ludics.", "")}`);
    }
  }

  // Watch plists
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.startsWith("com.ludics.watch-") && f.endsWith(".plist")) {
        const plist = join(agentsDir, f);
        Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
        unlinkSync(plist);
        console.log(`Uninstalled launchd trigger: ${f.replace("com.ludics.", "").replace(".plist", "")}`);
      }
    }
  }

  // Legacy pai-lite triggers
  const legacyLabels = [
    "com.pai-lite.startup", "com.pai-lite.sync", "com.pai-lite.morning",
    "com.pai-lite.health", "com.pai-lite.federation", "com.pai-lite.mayor",
    "com.pai-lite.dashboard",
  ];
  for (const label of legacyLabels) {
    const plist = join(agentsDir, `${label}.plist`);
    if (existsSync(plist)) {
      Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
      unlinkSync(plist);
      console.log(`Uninstalled legacy launchd trigger: ${label}`);
    }
  }
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.startsWith("com.pai-lite.watch-") && f.endsWith(".plist")) {
        const plist = join(agentsDir, f);
        Bun.spawnSync(["launchctl", "unload", plist], { stdout: "pipe", stderr: "pipe" });
        unlinkSync(plist);
        console.log(`Uninstalled legacy launchd trigger: ${f.replace(".plist", "")}`);
      }
    }
  }

  console.log("All ludics launchd triggers uninstalled");
}

function triggersUninstallLinux(): void {
  const systemdDir = join(process.env.HOME!, ".config/systemd/user");
  const names = KNOWN_LUDICS_TRIGGER_NAMES;

  for (const name of names) {
    const serviceFile = join(systemdDir, `ludics-${name}.service`);
    const timerFile = join(systemdDir, `ludics-${name}.timer`);
    const pathFile = join(systemdDir, `ludics-${name}.path`);

    if (existsSync(timerFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `ludics-${name}.timer`], { stdout: "pipe", stderr: "pipe" });
      unlinkSync(timerFile);
    }
    if (existsSync(pathFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `ludics-${name}.path`], { stdout: "pipe", stderr: "pipe" });
      unlinkSync(pathFile);
    }
    if (existsSync(serviceFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `ludics-${name}.service`], { stdout: "pipe", stderr: "pipe" });
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
          Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unitName}.path`], { stdout: "pipe", stderr: "pipe" });
          unlinkSync(pathFile);
        }
        Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unitName}.service`], { stdout: "pipe", stderr: "pipe" });
        unlinkSync(join(systemdDir, f));
        console.log(`Uninstalled systemd trigger: ${unitName.replace("ludics-", "")}`);
      }
    }
  }

  // Legacy pai-lite units
  const legacyNames = ["startup", "sync", "morning", "health", "federation", "mayor", "dashboard"];
  for (const name of legacyNames) {
    const serviceFile = join(systemdDir, `pai-lite-${name}.service`);
    const timerFile = join(systemdDir, `pai-lite-${name}.timer`);
    const pathFile = join(systemdDir, `pai-lite-${name}.path`);

    if (existsSync(timerFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `pai-lite-${name}.timer`], { stdout: "pipe", stderr: "pipe" });
      unlinkSync(timerFile);
    }
    if (existsSync(pathFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `pai-lite-${name}.path`], { stdout: "pipe", stderr: "pipe" });
      unlinkSync(pathFile);
    }
    if (existsSync(serviceFile)) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `pai-lite-${name}.service`], { stdout: "pipe", stderr: "pipe" });
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
          Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unitName}.path`], { stdout: "pipe", stderr: "pipe" });
          unlinkSync(pathFile);
        }
        Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unitName}.service`], { stdout: "pipe", stderr: "pipe" });
        unlinkSync(join(systemdDir, f));
        console.log(`Uninstalled legacy systemd trigger: ${unitName}`);
      }
    }
  }

  Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
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
    const check = Bun.spawnSync(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
    const status = check.exitCode === 0 ? "loaded" : "not loaded";
    console.log(`  ${name.padEnd(20)} ${status}`);
  }

  // Watch plists
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.startsWith("com.ludics.watch-") && f.endsWith(".plist")) {
        foundAny = true;
        const label = f.replace(".plist", "");
        const name = label.replace("com.ludics.", "");
        const check = Bun.spawnSync(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
        const status = check.exitCode === 0 ? "loaded" : "not loaded";
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

    const check = Bun.spawnSync(["systemctl", "--user", "is-active", unitToCheck], { stdout: "pipe", stderr: "pipe" });
    const status = check.stdout.toString().trim() || "inactive";
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
        const check = Bun.spawnSync(["systemctl", "--user", "is-active", unitToCheck], { stdout: "pipe", stderr: "pipe" });
        const status = check.stdout.toString().trim() || "inactive";
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
  const result = Bun.spawnSync(["uname", "-s"], { stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString().trim();
}

export function triggersInstall(): void {
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
