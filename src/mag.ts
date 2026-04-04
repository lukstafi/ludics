// Mag session management — start/stop/status/attach/logs/doctor/briefing/queue

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { harnessDir, loadConfigSync, startSessionsAutonomy, slotsFilePath, slotsCount, stateRepoDir, effectivePriorityValue, milestonesEnabledProjects, milestoneKey, resolveProjectPath } from "./config.ts";
import { listStashes } from "./slots/preempt.ts";
import { parseSlotBlocks, getTask, getProcess, getMode, getPath, getSession, getAdapterArgs, getSessionStarted, getLiveness, getMachine } from "./slots/markdown.ts";
import { queueRequest, queuePending, queueHasPendingAction, queueHasPendingFeedbackDigest } from "./queue.ts";
import { getUrl } from "./network.ts";
import { federationShouldRunMag, federationIsController, selectMachineForSlot, federationCurrentMachineName } from "./federation.ts";
import { stateCheckpoint } from "./state.ts";
import { journalAppend } from "./journal.ts";
import { emitEvent } from "./events.ts";
import { readOrchestrationState } from "./orchestration/state.ts";
import { isElaborated } from "./tasks/elaboration.ts";
import { buildAffinityLookup, type AffinityInput } from "./tasks/affinity.ts";
import {
  notifyOutgoing,
  expirePendingRevises,
  expirePendingFollowupRevises,
} from "./notify.ts";
import { slotAssign, slotClear, slotResume, slotStart, taskCompleteDirectly, markSlotSetupFailed } from "./slots/index.ts";
import { expandDuoSlots } from "./slots/duo-expand.ts";
import { readSlotState } from "./t3code/server.ts";
import { readTmuxSlotState } from "./adapters/tmux-adapter.ts";
import { resolveSkillCommand, hasRegisteredAction } from "./skill-queue-registry.ts";
import { selectOrchestrationFlags } from "./adapters/t3code.ts";
import YAML from "yaml";
import {
  tmuxAvailable,
  tmuxHasSession,
  tmuxNewSession,
  tmuxKillSession,
  tmuxSendKeys,
  tmuxSendCommand,
  tmuxCapture,
  tmuxPanePid,
  tmuxPaneInMode,
  tmuxCancelMode,
  tmuxSwitchClient,
  tmuxRunShell,
} from "./adapters/tmux.ts";

const MAG_SESSION_NAME = process.env.LUDICS_MAG_SESSION ?? "ludics-mag";
const MAG_DEFAULT_PORT = process.env.LUDICS_MAG_PORT ?? "7679";
const FEEDBACK_DIGEST_COOLDOWN_SECONDS = 120;
const SCRIPT_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;

function ludicsSelfCommand(args: string[]): string[] {
  // Compiled binary: invoke directly via process.execPath.
  // Script mode (bun/node): invoke the current entry script.
  const entry = process.argv[1];
  if (entry && SCRIPT_EXT_RE.test(entry) && existsSync(entry)) {
    if (process.execPath.toLowerCase().endsWith("bun")) {
      return [process.execPath, "run", entry, ...args];
    }
    return [process.execPath, entry, ...args];
  }
  return [process.execPath, ...args];
}

function magStateDir(): string {
  return join(harnessDir(), "mag");
}

function magStateFile(): string {
  return join(magStateDir(), "session.state");
}

function magStatusFile(): string {
  return join(magStateDir(), "session.status");
}

function magIsRunning(): boolean {
  return tmuxHasSession(MAG_SESSION_NAME);
}

function claudeLaunchCommand(): string {
  // Default to continue mode (-c) for persistent Mag sessions.
  // Set LUDICS_MAG_CLAUDE_CONTINUE=0/false/no to force plain mode.
  const continueEnv = (process.env.LUDICS_MAG_CLAUDE_CONTINUE ?? "")
    .trim()
    .toLowerCase();
  if (continueEnv === "0" || continueEnv === "false" || continueEnv === "no") {
    return "claude --dangerously-skip-permissions";
  }
  return "claude -c --dangerously-skip-permissions || claude --dangerously-skip-permissions";
}

function triggerSkill(session: string, cmd: string): boolean {
  if (tmuxPaneInMode(session)) {
    tmuxCancelMode(session);
  }
  const sent = tmuxSendKeys(session, cmd, true);
  if (!sent) return false;
  // Small delay before Enter
  Bun.spawnSync(["sleep", "0.5"], { stdout: "pipe", stderr: "pipe" });
  return tmuxSendKeys(session, "Enter");
}

const DEFAULT_NUDGE_THROTTLE_SECONDS = 60;
const DEFAULT_NUDGE_BACKOFF_SECONDS = 600;
const DEFAULT_STARTUP_WATCHDOG_SECONDS = 60;
const DEFAULT_STARTUP_HELPER_STUCK_SECONDS = 45;
const STARTUP_ALERT_TITLE = "Mag alert";

function nudgeThrottleSeconds(): number {
  const envVal = process.env.LUDICS_NUDGE_THROTTLE_SECONDS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;

  const configuredThrottle = Number(mag?.nudge_throttle_seconds);
  if (Number.isFinite(configuredThrottle) && configuredThrottle > 0) {
    return Math.floor(configuredThrottle);
  }

  return DEFAULT_NUDGE_THROTTLE_SECONDS;
}

function nudgeBackoffSeconds(): number {
  const envVal = process.env.LUDICS_NUDGE_BACKOFF_SECONDS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;

  const configuredBackoff = Number(mag?.nudge_backoff_seconds);
  if (Number.isFinite(configuredBackoff) && configuredBackoff > 0) {
    return Math.floor(configuredBackoff);
  }

  return DEFAULT_NUDGE_BACKOFF_SECONDS;
}

function nudgeTimestampFile(): string {
  return join(magStateDir(), "last-nudge.epoch");
}

function stopHookTimestampFile(): string {
  return join(magStateDir(), "last-stop-hook.epoch");
}

function startupWatchdogEpochFile(): string {
  return join(magStateDir(), "startup-watchdog.epoch");
}

function readEpochFile(file: string): number | null {
  if (!existsSync(file)) return null;
  try {
    const epoch = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
  } catch {
    return null;
  }
}

function nudgeThrottled(): boolean {
  const lastNudgeEpoch = readEpochFile(nudgeTimestampFile());
  if (lastNudgeEpoch === null) return false;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const elapsed = nowEpoch - lastNudgeEpoch;
  if (elapsed < nudgeThrottleSeconds()) return true;

  // Back off repeated Continue nudges until a stop hook has fired after the last nudge.
  if (elapsed >= nudgeBackoffSeconds()) return false;
  const lastStopHookEpoch = readEpochFile(stopHookTimestampFile());
  return lastStopHookEpoch === null || lastStopHookEpoch <= lastNudgeEpoch;
}

function writeNudgeTimestamp(): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(nudgeTimestampFile(), String(Math.floor(Date.now() / 1000)));
}

function writeStopHookTimestamp(): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(stopHookTimestampFile(), String(Math.floor(Date.now() / 1000)));
}

function startupWatchdogSeconds(): number {
  const envVal = process.env.LUDICS_STARTUP_WATCHDOG_SECONDS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.startup_watchdog_seconds);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_STARTUP_WATCHDOG_SECONDS;
}

function startupHelperStuckSeconds(): number {
  const envVal = process.env.LUDICS_STARTUP_HELPER_STUCK_SECONDS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.startup_helper_stuck_seconds);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_STARTUP_HELPER_STUCK_SECONDS;
}

function writeStartupWatchdogEpoch(): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(startupWatchdogEpochFile(), String(Math.floor(Date.now() / 1000)));
}

function clearStartupWatchdogEpoch(): void {
  const file = startupWatchdogEpochFile();
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // Best-effort
  }
}

function startupAlertStateFile(): string {
  return join(magStateDir(), "startup-alerts.json");
}

function loadStartupAlertState(): Record<string, number> {
  const file = startupAlertStateFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

function saveStartupAlertState(state: Record<string, number>): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(startupAlertStateFile(), JSON.stringify(state, null, 2) + "\n");
}

function clearStartupAlertsForEpoch(startupEpoch: number): void {
  const state = loadStartupAlertState();
  let changed = false;
  const suffix = `|${startupEpoch}`;
  for (const key of Object.keys(state)) {
    if (!key.endsWith(suffix)) continue;
    delete state[key];
    changed = true;
  }
  if (changed) saveStartupAlertState(state);
}

function notifyStartupAlertOnce(kind: string, startupEpoch: number, message: string): void {
  const key = `${kind}|${startupEpoch}`;
  const state = loadStartupAlertState();
  if (state[key]) return;

  state[key] = Math.floor(Date.now() / 1000);
  saveStartupAlertState(state);

  notifyOutgoing(message, 5, STARTUP_ALERT_TITLE);
  emitEvent({
    event_type: "mag_startup_alert",
    source: "keepalive",
    scope: "mag",
    status: "warning",
    message,
  });
}

function latestResultEpoch(): number | null {
  const dir = join(harnessDir(), "mag", "results");
  if (!existsSync(dir)) return null;
  let newest = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const mtime = Math.floor(statSync(join(dir, f)).mtimeMs / 1000);
      if (mtime > newest) newest = mtime;
    } catch {
      continue;
    }
  }
  return newest > 0 ? newest : null;
}

function readPsCommand(pid: number): string {
  const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) return "";
  return out.stdout.toString().trim();
}

function readPsElapsedSeconds(pid: number): number | null {
  const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etimes="], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) return null;
  const parsed = parseInt(out.stdout.toString().trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function childPids(parentPid: number): number[] {
  const out = Bun.spawnSync(["pgrep", "-P", String(parentPid)], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) return [];
  return out.stdout
    .toString()
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function findClaudePidForPane(session: string): number | null {
  const panePid = tmuxPanePid(session);
  if (!panePid) return null;
  const children = childPids(panePid);
  for (const pid of children) {
    const cmd = readPsCommand(pid);
    if (!cmd) continue;
    if (cmd.startsWith("claude ") || cmd.includes("/claude ")) return pid;
  }
  return null;
}

function claudeStartupHelperMaxAgeSeconds(claudePid: number): number {
  let maxAge = 0;
  for (const pid of childPids(claudePid)) {
    const cmd = readPsCommand(pid);
    if (!cmd.includes("--ripgrep --files --hidden")) continue;
    const age = readPsElapsedSeconds(pid);
    if (age !== null && age > maxAge) maxAge = age;
  }
  return maxAge;
}

function restartClaudeInMag(reason: string): boolean {
  const claudePid = findClaudePidForPane(MAG_SESSION_NAME);
  if (claudePid) {
    const descendants = childPids(claudePid);
    if (descendants.length > 0) {
      Bun.spawnSync(["kill", "-9", ...descendants.map((pid) => String(pid))], { stdout: "pipe", stderr: "pipe" });
    }
    Bun.spawnSync(["kill", "-9", String(claudePid)], { stdout: "pipe", stderr: "pipe" });
  }

  const launched = tmuxSendCommand(MAG_SESSION_NAME, claudeLaunchCommand());
  if (!launched) {
    console.error(`ludics: startup watchdog: failed to relaunch Claude (${reason})`);
    emitEvent({
      event_type: "mag_startup_recover",
      source: "keepalive",
      scope: "mag",
      status: "failed",
      message: `failed relaunch (${reason})`,
    });
    return false;
  }

  writeStartupWatchdogEpoch();
  emitEvent({
    event_type: "mag_startup_recover",
    source: "keepalive",
    scope: "mag",
    status: "ok",
    message: `restarted Claude (${reason})`,
  });
  return true;
}

function maybeRecoverStuckStartup(): void {
  const startupEpoch = readEpochFile(startupWatchdogEpochFile());
  if (!startupEpoch) return;

  const lastStopHook = readEpochFile(stopHookTimestampFile());
  if (lastStopHook && lastStopHook >= startupEpoch) {
    clearStartupAlertsForEpoch(startupEpoch);
    clearStartupWatchdogEpoch();
    return;
  }

  const lastResult = latestResultEpoch();
  if (lastResult && lastResult >= startupEpoch) {
    clearStartupAlertsForEpoch(startupEpoch);
    clearStartupWatchdogEpoch();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if ((now - startupEpoch) < startupWatchdogSeconds()) return;

  const claudePid = findClaudePidForPane(MAG_SESSION_NAME);
  if (!claudePid) {
    console.error("ludics: startup watchdog: Claude process missing; attempting relaunch");
    restartClaudeInMag("process missing");
    return;
  }

  const helperAge = claudeStartupHelperMaxAgeSeconds(claudePid);
  if (helperAge >= startupHelperStuckSeconds()) {
    const message = `Mag startup degraded: Claude appears stuck in upstream helper (--ripgrep --files --hidden) for ${helperAge}s. Manual intervention likely required.`;
    console.error(`ludics: ${message}`);
    notifyStartupAlertOnce("claude-helper-stuck", startupEpoch, message);
  }
}

function feedbackDigestStateFile(): string {
  return join(magStateDir(), "feedback-digest-last-queued.json");
}

function readFeedbackDigestQueueState(): Record<string, number> {
  const file = feedbackDigestStateFile();
  if (!existsSync(file)) return {};

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const state: Record<string, number> = {};
    for (const [repo, epoch] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof epoch === "number" && Number.isFinite(epoch)) {
        state[repo] = epoch;
      }
    }
    return state;
  } catch {
    return {};
  }
}

function feedbackDigestCooldownRemaining(repo: string): number {
  const lastQueued = readFeedbackDigestQueueState()[repo];
  if (typeof lastQueued !== "number") return 0;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - lastQueued;
  if (elapsed >= FEEDBACK_DIGEST_COOLDOWN_SECONDS) return 0;
  return FEEDBACK_DIGEST_COOLDOWN_SECONDS - Math.max(0, elapsed);
}

function markFeedbackDigestQueued(repo: string): void {
  const state = readFeedbackDigestQueueState();
  state[repo] = Math.floor(Date.now() / 1000);
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(feedbackDigestStateFile(), JSON.stringify(state));
}

function lastCaptureHashFile(): string {
  return join(magStateDir(), "last-capture.hash");
}

function adoptSessionsFingerprintFile(): string {
  return join(magStateDir(), "adopt-sessions-unclassified.hash");
}

interface AdoptFingerprintSession {
  cwd: string;
  cwdNormalized: string;
  agents: string[];
  ids: string[];
  orchestration: { type: string; taskId: string; phase: string; round: string } | null;
  meta: {
    tmux_session?: string;
    git_branch?: string;
    port?: string;
  };
}

function adoptSessionsFingerprintData(
  sessionsJsonPath: string,
): { hash: string; unclassifiedCount: number } | null {
  if (!existsSync(sessionsJsonPath)) return null;

  try {
    const data = JSON.parse(readFileSync(sessionsJsonPath, "utf-8")) as { unclassified?: Array<Record<string, unknown>> };
    const raw = Array.isArray(data.unclassified) ? data.unclassified : [];
    const normalized: AdoptFingerprintSession[] = raw.map((session) => {
      const metaObj = session.meta && typeof session.meta === "object"
        ? (session.meta as Record<string, unknown>)
        : {};
      const orchObj = session.orchestration && typeof session.orchestration === "object"
        ? (session.orchestration as Record<string, unknown>)
        : null;
      const orchestration = orchObj
        ? {
          type: String(orchObj.type ?? ""),
          taskId: String(orchObj.feature ?? orchObj.taskId ?? ""),
          phase: String(orchObj.phase ?? ""),
          round: String(orchObj.round ?? ""),
        }
        : null;

      return {
        cwd: String(session.cwd ?? "unknown"),
        cwdNormalized: String(session.cwdNormalized ?? "unknown"),
        agents: Array.isArray(session.agents) ? session.agents.map((v) => String(v)).sort() : [],
        ids: Array.isArray(session.ids) ? session.ids.map((v) => String(v)).sort() : [],
        orchestration,
        meta: {
          tmux_session: typeof metaObj.tmux_session === "string" ? metaObj.tmux_session : undefined,
          git_branch: typeof metaObj.git_branch === "string" ? metaObj.git_branch : undefined,
          port: typeof metaObj.port === "string" ? metaObj.port : undefined,
        },
      };
    });

    normalized.sort((a, b) => {
      const pathCmp = a.cwdNormalized.localeCompare(b.cwdNormalized);
      if (pathCmp !== 0) return pathCmp;
      return a.ids.join(",").localeCompare(b.ids.join(","));
    });

    const payload = {
      version: 1,
      unclassified: normalized,
    };
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify(payload));
    return {
      hash: hasher.digest("hex"),
      unclassifiedCount: normalized.length,
    };
  } catch {
    return null;
  }
}

function publishTerminalState(): void {
  const raw = tmuxCapture(MAG_SESSION_NAME, 50);
  if (!raw) return;

  const lines = raw.split("\n");

  // Find last ⏺ line (Claude Code output marker)
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes("⏺")) {
      startIdx = i;
      break;
    }
  }

  // Find last prompt line and cut there (drop status tagline below it)
  let endIdx = lines.length;
  for (let i = lines.length - 1; i >= startIdx; i--) {
    if (lines[i]!.includes("❯")) {
      endIdx = i; // exclude the prompt line itself
      break;
    }
  }

  const cleaned = lines.slice(startIdx, endIdx)
    .filter((l) => !l.match(/^[─]{4,}/));  // drop line separators

  const snippet = cleaned.join("\n").trim();
  if (!snippet) return;

  // Dedup: hash and compare to previous
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(snippet);
  const hash = hasher.digest("hex");

  const hashFile = lastCaptureHashFile();
  if (existsSync(hashFile)) {
    const prev = readFileSync(hashFile, "utf-8").trim();
    if (prev === hash) return; // unchanged
  }

  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(hashFile, hash);

  notifyOutgoing(snippet, 2, "Mag terminal");
}

function magSignal(status: string, message: string = ""): void {
  const dir = magStateDir();
  mkdirSync(dir, { recursive: true });
  const epoch = Math.floor(Date.now() / 1000);
  writeFileSync(magStatusFile(), `${status}|${epoch}|${message}\n`);
}

function getTtydPort(): string {
  const config = loadConfigSync();
  const mag =config.mag as Record<string, unknown> | undefined;
  return String(mag?.ttyd_port ?? MAG_DEFAULT_PORT);
}

function ensureTtyd(): void {
  const hasTtyd = Bun.spawnSync(["which", "ttyd"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (!hasTtyd) {
    console.error("ludics: ttyd not installed; skipping web access");
    return;
  }

  // Check if already running
  const pgrep = Bun.spawnSync(["pgrep", "-f", `ttyd.*${MAG_SESSION_NAME}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (pgrep.exitCode === 0) return;

  const port = getTtydPort();
  const ttydBin = Bun.spawnSync(["which", "ttyd"], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString().trim();

  console.error(`ludics: Starting ttyd on port ${port}...`);

  const logDir = existsSync(join(process.env.HOME!, "Library/Logs"))
    ? join(process.env.HOME!, "Library/Logs")
    : "/tmp";
  const logFile = join(logDir, "ludics-ttyd.log");

  tmuxRunShell(MAG_SESSION_NAME, `${ttydBin} -W -p ${port} tmux attach -t ${MAG_SESSION_NAME} >>${logFile} 2>&1`);

  console.log(`Web access available at: ${getUrl(port)}`);
}

// --- Queue pop for skills ---

function findSlotForTask(taskId: string): number | null {
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return null;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  for (const [slotNum, block] of blocks) {
    const currentTask = getTask(block).trim();
    if (currentTask === taskId) return slotNum;
  }
  return null;
}

function abandonTaskFromNotification(taskId: string): void {
  const slotNum = findSlotForTask(taskId);
  if (slotNum === null) {
    console.error(`ludics: abandon request ignored: task ${taskId} is not assigned to any slot`);
    emitEvent({
      event_type: "notify_abandon_ignored",
      source: "notify",
      scope: "mag",
      task: taskId,
      message: "task not assigned to any slot",
    });
    return;
  }

  try {
    slotClear(slotNum, "abandoned");
    emitEvent({
      event_type: "notify_abandon",
      source: "notify",
      scope: "mag",
      slot: slotNum,
      task: taskId,
      status: "abandoned",
      message: "abandoned via notification button",
    });
    console.error(`ludics: abandoned ${taskId} from slot ${slotNum} via notification button`);
  } catch (err) {
    console.error(`ludics: failed to abandon ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    emitEvent({
      event_type: "notify_abandon_error",
      source: "notify",
      scope: "mag",
      slot: slotNum,
      task: taskId,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function completeTaskFromNotification(taskId: string): void {
  const slotNum = findSlotForTask(taskId);
  try {
    if (slotNum !== null) {
      slotClear(slotNum, "done");
      emitEvent({
        event_type: "notify_done",
        source: "notify",
        scope: "mag",
        slot: slotNum,
        task: taskId,
        status: "done",
        message: "completed via notification button",
      });
      console.error(`ludics: completed ${taskId} from slot ${slotNum} via notification button`);
      return;
    }

    const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
    if (!existsSync(taskFile)) {
      console.error(`ludics: done request ignored: task ${taskId} not found`);
      emitEvent({
        event_type: "notify_done_ignored",
        source: "notify",
        scope: "mag",
        task: taskId,
        message: "task not found",
      });
      return;
    }

    taskCompleteDirectly(taskId);
    emitEvent({
      event_type: "notify_done",
      source: "notify",
      scope: "mag",
      task: taskId,
      status: "done",
      message: "completed via notification button (direct)",
    });
    console.error(`ludics: completed ${taskId} via notification button (direct)`);
  } catch (err) {
    console.error(`ludics: failed to complete ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
    emitEvent({
      event_type: "notify_done_error",
      source: "notify",
      scope: "mag",
      slot: slotNum ?? undefined,
      task: taskId,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Map any adapter name from notification bodies to t3code.
 *  Legacy notifications may carry "agent-claude", "agent-codex", etc.
 *  With the t3code-only workflow, all launches use t3code.
 *
 *  @deprecated Internal callers no longer pass rawAdapter to launchSessionFromNotification.
 *  This function is kept for backward-compat with legacy notification regex matchers
 *  until those notification formats are fully retired. */
export function normalizeLaunchAdapter(rawAdapter: string): string {
  const adapter = rawAdapter.trim();
  if (adapter === "t3code") return adapter;
  if (adapter) {
    console.error(`ludics: legacy launch adapter "${adapter}" → t3code`);
  }
  return "t3code";
}

function quoteShellToken(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildFollowupAdapterArgs(followupMsg: string): string {
  const sanitizedMsg = followupMsg
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (sanitizedMsg) {
    return `--followup --followup-msg ${quoteShellToken(sanitizedMsg)}`;
  }
  return "--followup";
}

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readTaskProject(taskId: string): string {
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return "";
  const content = readFileSync(taskFile, "utf-8");
  const projectMatch = content.match(/^project:\s*(.+)$/m);
  if (!projectMatch) return "";
  return normalizeYamlScalar(projectMatch[1]!);
}

function resolveTaskProjectPath(taskId: string): string {
  const project = readTaskProject(taskId);
  if (!project) return "";

  const home = process.env.HOME ?? "";
  if (!home) return "";

  const config = loadConfigSync();
  const candidates: string[] = [];
  const addProjectCandidates = (name: string): void => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    for (const candidate of [join(home, trimmed), join(home, "repos", trimmed)]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  };

  const configured = (config.projects ?? []).find((p) => {
    const repoTail = p.repo.split("/").pop() ?? "";
    return p.name === project || repoTail === project;
  });

  if (configured) {
    const repoTail = configured.repo.split("/").pop() ?? "";
    addProjectCandidates(repoTail);
    addProjectCandidates(configured.name);
  }

  addProjectCandidates(project);

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return "";
}

interface SlotSelection {
  taskSlot: number | null;
  existingPath: string;
  previousMode: string;
  previousSession: string;
  previousAdapterArgs: string;
  emptySlot: number | null;
}

function selectSlotForLaunch(taskId: string): SlotSelection {
  const sFile = slotsFilePath();
  const blocks = existsSync(sFile) ? parseSlotBlocks(readFileSync(sFile, "utf-8")) : new Map<number, string>();
  const count = slotsCount();

  let taskSlot: number | null = null;
  let existingPath = "";
  let previousMode = "";
  let previousSession = "";
  let previousAdapterArgs = "";
  let emptySlot: number | null = null;

  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    const process = block ? getProcess(block).trim() : "(empty)";

    if ((!process || process === "(empty)") && emptySlot === null) {
      emptySlot = i;
    }

    if (!block) continue;
    if (getTask(block).trim() !== taskId) continue;

    taskSlot = i;
    const slotMode = getMode(block).trim();
    previousMode = slotMode && slotMode !== "null" ? slotMode : "";
    const slotSession = getSession(block).trim();
    previousSession = slotSession && slotSession !== "null" ? slotSession : "";
    const slotAdapterArgs = getAdapterArgs(block).trim();
    previousAdapterArgs = slotAdapterArgs && slotAdapterArgs !== "null" ? slotAdapterArgs : "";
    const slotPath = getPath(block).trim();
    if (slotPath && slotPath !== "null") existingPath = slotPath;
  }

  return { taskSlot, existingPath, previousMode, previousSession, previousAdapterArgs, emptySlot };
}

// --- Auto-start decision support ---

export interface AutoStartDecision {
  decision: "auto-start" | "defer-to-user";
  reason: string;
}

/** Pure decision function — no filesystem or config side effects.
 *  Callers must supply autonomy and slotAssigned explicitly (read from config/slots). */
export function evaluateAutoStartDecisionPure(
  workerConfidence: "high" | "low" | undefined,
  rationale: string,
  autonomy: "auto" | "suggest" | "manual",
  slotAssigned: boolean,
): AutoStartDecision {
  if (autonomy === "manual") return { decision: "defer-to-user", reason: "autonomy=manual" };
  if (autonomy === "suggest") return { decision: "defer-to-user", reason: "autonomy=suggest" };
  // autonomy === "auto"
  if (workerConfidence === "low" || !workerConfidence) {
    return { decision: "defer-to-user", reason: `worker confidence: ${workerConfidence ?? "missing"}` };
  }
  // Safety net: scan rationale for ambiguity signals contradicting "high"
  const AMBIGUITY_SIGNALS = ["ambiguous", "unclear", "open question", "speculative", "uncertain scope"];
  const lowerRationale = rationale.toLowerCase();
  const ambiguityHit = AMBIGUITY_SIGNALS.find((s) => lowerRationale.includes(s));
  if (ambiguityHit) {
    return { decision: "defer-to-user", reason: `rationale contains "${ambiguityHit}" despite high confidence` };
  }
  if (!slotAssigned) return { decision: "defer-to-user", reason: "no slot assigned" };
  return { decision: "auto-start", reason: "high confidence, slot ready" };
}


async function launchSessionFromNotification(taskId: string, adapterArgs: string = ""): Promise<void> {
  const adapter = "t3code";
  const launchArgs = adapterArgs.trim();
  const selection = selectSlotForLaunch(taskId);

  // Guard: if the task's slot already has an active session, skip re-start
  if (selection.taskSlot !== null) {
    const sFile = slotsFilePath();
    if (existsSync(sFile)) {
      const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
      const block = blocks.get(selection.taskSlot);
      if (block) {
        const sessionStarted = getSessionStarted(block).trim();
        if (sessionStarted && sessionStarted !== "null") {
          const msg = `Session already active for ${taskId} in slot ${selection.taskSlot} — ignoring duplicate launch`;
          console.error(`ludics: ${msg}`);
          notifyOutgoing(msg, 2, "ludics");
          return;
        }
      }
    }
  }

  if (selection.taskSlot === null && selection.emptySlot === null) {
    const msg = `Cannot launch ${taskId}: all slots occupied. Run: ludics slot N preempt ${taskId} -a t3code`;
    notifyOutgoing(msg, 3, "ludics");
    emitEvent({
      event_type: "notify_launch_no_slot",
      source: "notify",
      scope: "mag",
      task: taskId,
      adapter: "t3code",
      message: "all slots occupied",
    });
    console.error(`ludics: launch request for ${taskId} failed: no empty slots`);
    return;
  }

  const slotNum = selection.taskSlot ?? selection.emptySlot!;
  const path = selection.existingPath || resolveTaskProjectPath(taskId);

  try {
    // Notification button actions are always treated as fresh starts.
    slotAssign(slotNum, taskId, adapter, "", path, launchArgs);
    await slotStart(slotNum);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    let rollbackStatus = "rollback skipped";
    try {
      if (selection.taskSlot === null) {
        // Mark slot as interrupted instead of clearing — prevents maybeFillEmptySlots
        // from overwriting with a different task before the user can investigate.
        markSlotSetupFailed(slotNum, detail);
        rollbackStatus = "slot marked interrupted";
      } else {
        slotAssign(
          slotNum,
          taskId,
          selection.previousMode || "manual",
          selection.previousSession,
          selection.existingPath,
          selection.previousAdapterArgs,
        );
        rollbackStatus = "restored prior slot assignment";
      }
    } catch (rollbackErr) {
      const rollbackDetail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      rollbackStatus = `rollback failed: ${rollbackDetail}`;
      console.error(`ludics: launch rollback failed for ${taskId} in slot ${slotNum}: ${rollbackDetail}`);
    }

    console.error(`ludics: failed to launch t3code for ${taskId} in slot ${slotNum}: ${detail}`);
    notifyOutgoing(
      `Failed to launch t3code for ${taskId} in slot ${slotNum}: ${detail} (${rollbackStatus})`,
      3,
      "ludics",
    );
    emitEvent({
      event_type: "notify_launch_error",
      source: "notify",
      scope: "mag",
      slot: slotNum,
      task: taskId,
      adapter: "t3code",
      status: "error",
      message: `${detail} (${rollbackStatus})`,
    });
    return;
  }

  const actionLabel = selection.taskSlot !== null ? "reassigned+started" : "assigned+started";
  emitEvent({
    event_type: "notify_launch",
    source: "notify",
    scope: "mag",
    slot: slotNum,
    task: taskId,
    adapter: "t3code",
    message: actionLabel,
  });
  console.error(`ludics: launched t3code for ${taskId} in slot ${slotNum} (${actionLabel})`);
}

type QueueDequeueResult =
  | { status: "empty" }
  | { status: "mismatch" }
  | { status: "popped"; line: string; request: Record<string, unknown> | null };

function queueFilePath(): string {
  return join(harnessDir(), "mag", "queue.jsonl");
}

function dequeueQueueHead(expectedLine?: string): QueueDequeueResult {
  const queueFile = queueFilePath();
  if (!existsSync(queueFile)) return { status: "empty" };

  const content = readFileSync(queueFile, "utf-8").trim();
  if (!content) return { status: "empty" };

  const lines = content.split("\n");
  const first = lines[0]!;

  if (expectedLine !== undefined && first !== expectedLine) {
    return { status: "mismatch" };
  }

  writeFileSync(queueFile, lines.slice(1).join("\n") + (lines.length > 1 ? "\n" : ""));

  try {
    return { status: "popped", line: first, request: JSON.parse(first) as Record<string, unknown> };
  } catch {
    return { status: "popped", line: first, request: null };
  }
}

async function queuePopSkill(): Promise<string | null> {
  const queueFile = join(harnessDir(), "mag", "queue.jsonl");
  if (!existsSync(queueFile)) return null;

  const popped = dequeueQueueHead();
  if (popped.status !== "popped") return null;

  if (!popped.request) {
    console.error("ludics: mag queue-pop: invalid request in queue");
    return null;
  }
  const request = popped.request;

  // Write request ID to file so skills can read it (env vars can't be set mid-session)
  const requestId = String(request.id ?? "");
  if (requestId) {
    const requestIdFile = join(harnessDir(), "mag", "current-request-id");
    writeFileSync(requestIdFile, requestId);
  }

  return await resolveQueueRequestCommand(request, true);
}

/** Resolve a queue request to a skill command or execute it programmatically.
 *  Exported for testing — call with `executeProgrammatic: false` for pure parsing.
 *
 *  Three-tier dispatch:
 *  1. Pre-hooks for briefing/adopt-sessions (imperative side-effects before skill command).
 *  2. Auto-discovered skill commands read from skills/*.md frontmatter via the registry.
 *  3. Programmatic-only actions (message, adapter-followup, complete-task) that never
 *     return a slash command, handled by the reduced switch below.
 */
export async function resolveQueueRequestCommand(request: Record<string, unknown>, executeProgrammatic: boolean): Promise<string | null> {
  const action = String(request.action ?? "");

  // Tier 1: Pre-hooks for skill actions that require context pre-computation.
  // Only precompute when actually dispatching, not during a peek.
  if (executeProgrammatic) {
    if (action === "briefing") {
      await briefingPrecomputeContext();
    } else if (action === "adopt-sessions") {
      adoptSessionsPrecomputeContext();
    }
  }

  // Tier 2: Auto-discovered skill commands from skills/*.md frontmatter.
  const skillCommand = resolveSkillCommand(action, request);
  if (skillCommand !== null) {
    return skillCommand;
  }

  // Tier 3: Programmatic-only actions that never yield a skill command.
  switch (action) {
    case "message": {
      const content = String(request.content ?? "");
      if (!content) return null;

      // Intercept button-tap launch messages from ntfy notifications
      // New format: "Launch task <id>"
      const launchNewMatch = content.match(/^Launch task ([\w.-]+)$/);
      if (launchNewMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(launchNewMatch[1]!);
        }
        return null;
      }

      // Backward compat: old ntfy buttons may still carry this format.
      // New notifications emit "Launch task <id>" only.
      // The captured adapter group is intentionally ignored — all launches use t3code.
      const launchLegacyMatch = content.match(/^Launch ([\w-]+) for ([\w.-]+) in project .+$/);
      if (launchLegacyMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(launchLegacyMatch[2]!);
        }
        return null;
      }

      const abandonMatch = content.match(/^Abandon task ([\w.-]+)$/);
      if (abandonMatch) {
        if (executeProgrammatic) {
          abandonTaskFromNotification(abandonMatch[1]!);
        }
        return null;
      }

      // New format: "Followup task <id>"
      const followupNewMatch = content.match(/^Followup task ([\w.-]+)$/);
      if (followupNewMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(followupNewMatch[1]!, buildFollowupAdapterArgs(""));
        }
        return null;
      }

      // Backward compat: old ntfy buttons may still carry this format.
      // New notifications emit "Followup task <id>" only.
      // The captured adapter group is intentionally ignored — all launches use t3code.
      const followupLegacyMatch = content.match(/^Followup ([\w-]+) for ([\w.-]+)$/);
      if (followupLegacyMatch) {
        if (executeProgrammatic) {
          await launchSessionFromNotification(followupLegacyMatch[2]!, buildFollowupAdapterArgs(""));
        }
        return null;
      }

      const doneMatch = content.match(/^Done task ([\w.-]+)$/);
      if (doneMatch) {
        if (executeProgrammatic) {
          completeTaskFromNotification(doneMatch[1]!);
        }
        return null;
      }

      return content; // send directly as user turn
    }
    case "adapter-followup": {
      const task = String(request.task ?? "");
      // `adapter` field is accepted for backward compat but ignored — all launches use t3code.
      const followupMsg = String(request.followup_msg ?? "");
      if (!task) {
        if (executeProgrammatic) {
          console.error("ludics: mag queue-pop: adapter-followup missing task");
        }
        return null;
      }
      if (executeProgrammatic) {
        await launchSessionFromNotification(task, buildFollowupAdapterArgs(followupMsg));
      }
      return null;
    }
    case "complete-task": {
      const task = String(request.task ?? "");
      if (!task) {
        if (executeProgrammatic) {
          console.error("ludics: mag queue-pop: complete-task missing task");
        }
        return null;
      }
      if (executeProgrammatic) {
        completeTaskFromNotification(task);
      }
      return null;
    }
    default:
      // Log only for truly unknown actions; registered skills that returned null
      // (e.g. missing a required arg) are not unknown.
      if (executeProgrammatic && !hasRegisteredAction(action)) {
        console.error(`ludics: mag queue-pop: unknown action: ${action}`);
      }
      return null;
  }
}

async function drainProgrammaticQueueHead(): Promise<boolean> {
  const queueFile = queueFilePath();

  while (true) {
    if (!existsSync(queueFile)) return false;

    const content = readFileSync(queueFile, "utf-8").trim();
    if (!content) return false;

    const first = content.split("\n")[0]!;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(first) as Record<string, unknown>;
    } catch {
      const dropped = dequeueQueueHead(first);
      if (dropped.status === "mismatch") continue;
      if (dropped.status === "popped") {
        console.error("ludics: mag queue-pop: invalid request in queue");
      }
      continue;
    }

    const command = await resolveQueueRequestCommand(request, false);
    if (command) return true;

    const popped = dequeueQueueHead(first);
    if (popped.status === "mismatch") continue;
    if (popped.status !== "popped" || !popped.request) continue;
    await resolveQueueRequestCommand(popped.request, true);
  }
}

// --- Briefing context pre-computation ---

/**
 * Delete t3code threads for tasks marked as done/abandoned that have stored
 * thread IDs in their `t3code_threads` frontmatter field.
 * This is idempotent: threads already absent from the server are skipped.
 */
async function cleanupDoneTaskThreads(): Promise<void> {
  const harness = harnessDir();
  const tasksDir = join(harness, "tasks");
  if (!existsSync(tasksDir)) return;

  // Collect thread IDs from completed tasks
  const threadIdsToDelete: string[] = [];
  try {
    const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
    for (const f of files) {
      const content = readFileSync(join(tasksDir, f), "utf-8");
      const statusMatch = content.match(/^status:\s*(.+)$/m);
      const status = statusMatch ? statusMatch[1]!.trim() : "";
      if (status !== "done" && status !== "abandoned") continue;
      const threadsMatch = content.match(/^t3code_threads:\s*\[(.+)\]$/m);
      if (!threadsMatch) continue;
      const ids = threadsMatch[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      threadIdsToDelete.push(...ids);
    }
  } catch {
    return;
  }

  // Fallback: collect retrospective for done tasks that don't have one yet
  {
    const retroDir = join(harness, "retrospectives");
    try {
      const taskFiles = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
      for (const f of taskFiles) {
        const content = readFileSync(join(tasksDir, f), "utf-8");
        const statusMatch = content.match(/^status:\s*(.+)$/m);
        const taskStatus = statusMatch ? statusMatch[1]!.trim() : "";
        if (taskStatus !== "done" && taskStatus !== "abandoned") continue;

        const taskId = f.replace(/\.md$/, "");
        const retroFile = join(retroDir, `${taskId}.json`);
        if (!existsSync(retroFile)) {
          try {
            const { collectRetrospectiveFallback } = await import("./retrospective.ts");
            await collectRetrospectiveFallback(taskId);
          } catch { /* best effort — ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  if (threadIdsToDelete.length === 0) return;

  // Delete threads from t3code server (idempotent — skip if not on server)
  try {
    const { serverStatus } = await import("./t3code/server.ts");
    const { T3CodeClient } = await import("./t3code/client.ts");
    const { makeId, isoNow } = await import("./orchestration/util.ts");
    const status = await serverStatus({ harnessDir: harness });
    if (!status.running || !status.record || !status.snapshot) return;

    const snapshot = status.snapshot;
    const record = status.record;
    const client = new T3CodeClient({ url: record.wsUrl, token: record.authToken });
    try {
      for (const threadId of threadIdsToDelete) {
        if (!snapshot.threads.find((t) => t.id === threadId)) continue; // already gone
        try {
          await client.dispatchCommand({
            type: "thread.session.stop",
            commandId: makeId("cmd"),
            threadId,
            createdAt: isoNow(),
          });
        } catch {
          // ignore
        }
        try {
          await client.dispatchCommand({
            type: "thread.delete",
            commandId: makeId("cmd"),
            threadId,
          });
        } catch {
          // ignore
        }
        console.error(`ludics: briefing cleanup: deleted t3code thread ${threadId}`);
      }
    } finally {
      client.close();
    }
  } catch {
    // t3code not available or other error — skip silently
  }
}

/**
 * Ensure the t3code server is running if `mag.ensure_t3code` is not false.
 * Encapsulates config check, dynamic import, try/catch, and logging so that
 * the three call-sites (keepalive, fresh start, briefing) share a single
 * implementation.  Pass a short `context` string (e.g. "keepalive") that
 * appears in log messages to aid debugging.
 */
async function ensureT3codeIfEnabled(context: string): Promise<void> {
  const magConfig = loadConfigSync().mag as Record<string, unknown> | undefined;
  if (magConfig?.ensure_t3code === false) return;
  console.error(`ludics: ensureServer (${context}): ensuring t3code server...`);
  try {
    const { ensureServer } = await import("./t3code/server.ts");
    await ensureServer({ harnessDir: harnessDir() });
    console.error(`ludics: ensureServer (${context}): t3code server ready`);
  } catch (err) {
    console.error(`ludics: ensureServer (${context}): failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function briefingPrecomputeContext(): Promise<void> {
  // Ensure t3code server is running before briefing (it dies on overnight shutdown)
  await ensureT3codeIfEnabled("briefing");

  // Clean up t3code threads for completed tasks before building the context
  await cleanupDoneTaskThreads();

  const harness = harnessDir();
  const contextFile = join(harness, "mag", "briefing-context.md");
  mkdirSync(join(harness, "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Capture slots
  let slotsOutput = "(unavailable)";
  try {
    const r = Bun.spawnSync(ludicsSelfCommand(["slots"]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) slotsOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Capture sessions
  let sessionsContent = "(no sessions report available)";
  const sessionsFile = join(harness, "sessions.md");
  if (existsSync(sessionsFile)) {
    sessionsContent = readFileSync(sessionsFile, "utf-8");
  }

  // Flow ready
  let flowReadyOutput = "(unavailable)";
  try {
    const r = Bun.spawnSync(ludicsSelfCommand(["flow", "ready"]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) flowReadyOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Flow critical
  let flowCriticalOutput = "(unavailable)";
  try {
    const r = Bun.spawnSync(ludicsSelfCommand(["flow", "critical"]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) flowCriticalOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Tasks needing elaboration
  let needsElabOutput = "None";
  try {
    const r = Bun.spawnSync(ludicsSelfCommand(["tasks", "needs-elaboration"]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0 && r.stdout.toString().trim()) needsElabOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Recent journal
  let journalOutput = "(no journal entries)";
  try {
    const r = Bun.spawnSync(ludicsSelfCommand(["journal", "recent", "20"]), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) journalOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Same-day check
  let samedayStatus = "new";
  let existingDate = "none";
  const briefingFile = join(harness, "briefing.md");
  if (existsSync(briefingFile)) {
    const first = readFileSync(briefingFile, "utf-8").split("\n").slice(0, 5).join("\n");
    const dateMatch = first.match(/^# Briefing - (\d{4}-\d{2}-\d{2})/m);
    if (dateMatch) {
      existingDate = dateMatch[1]!;
      const today = new Date().toISOString().slice(0, 10);
      if (existingDate === today) samedayStatus = "amend";
    }
  }

  // Preempted slots
  let preemptedOutput = "(none)";
  const stashes = listStashes();
  if (stashes.length > 0) {
    preemptedOutput = stashes.map((s) =>
      `Slot ${s.slotNum}: preempted "${s.previousProcess}" (task=${s.previousTask}) at ${s.preemptedAt} for ${s.preemptingTask}`
    ).join("\n");
  }

  const contextContent = `# Briefing Context

Generated: ${timestamp}

## Same-Day Status

Status: ${samedayStatus}
Existing briefing date: ${existingDate}

## Slots State

${slotsOutput}

## Preempted Slots

${preemptedOutput}

## Sessions Report

${sessionsContent}

${computeSessionProjectMatches()}

## Flow: Ready Queue

${flowReadyOutput}

## Flow: Critical Items

${flowCriticalOutput}

## Tasks Needing Elaboration

${needsElabOutput}

## Recent Journal

${journalOutput}
`;

  writeFileSync(contextFile + ".tmp", contextContent);
  renameSync(contextFile + ".tmp", contextFile);
  console.error(`ludics: briefing context written to ${contextFile}`);
}

// --- Session-project matching for adopt-sessions ---

interface ProjectMatch {
  projectName: string;
  repo: string;
}

function matchCwdToProject(
  cwdNormalized: string,
  repoTailMap: Map<string, ProjectMatch>,
): ProjectMatch | null {
  const components = cwdNormalized.split("/").filter(Boolean);

  // Exact match: walk from rightmost component leftward
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i]!;
    if (repoTailMap.has(component)) {
      return repoTailMap.get(component)!;
    }
  }

  // Prefix match for worktree dirs (e.g., "ocannl-fix-xyz" matches "ocannl")
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i]!;
    for (const [tail, project] of repoTailMap) {
      if (component.startsWith(tail + "-") || component.startsWith(tail + ".")) {
        return project;
      }
    }
  }

  return null;
}

function taskIsConcluded(taskId: string, harness: string): boolean {
  const taskFile = join(harness, "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return false;

  try {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;

    const data = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
    const status = String(data.status ?? "").trim().toLowerCase();
    if (status === "done" || status === "abandoned") return true;

    const completed = String(data.completed ?? "").trim().toLowerCase();
    return !!completed && completed !== "null";
  } catch {
    return false;
  }
}

interface BriefingClassifiedSession {
  slot: number | null;
  stale: boolean;
  lastActivity: string;
  orchestration: { type: string; phase: string; round: string } | null;
}

function readBriefingClassifiedSessions(sessionsFile: string): BriefingClassifiedSession[] | null {
  if (!existsSync(sessionsFile)) return null;

  // Keep behavior consistent with other pre-computations that require fresh session data.
  try {
    const mtime = statSync(sessionsFile).mtimeMs;
    if (Date.now() - mtime > 900_000) return null;
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(sessionsFile, "utf-8")) as { classified?: Array<Record<string, unknown>> };
    const raw = Array.isArray(parsed.classified) ? parsed.classified : [];

    return raw.map((entry) => {
      const slotValue = entry.slot;
      const slot = typeof slotValue === "number"
        ? slotValue
        : (typeof slotValue === "string" && /^\d+$/.test(slotValue) ? parseInt(slotValue, 10) : null);
      const orchestrationRaw = entry.orchestration;
      const orchestration = orchestrationRaw && typeof orchestrationRaw === "object"
        ? {
          type: String((orchestrationRaw as Record<string, unknown>).type ?? ""),
          phase: String((orchestrationRaw as Record<string, unknown>).phase ?? ""),
          round: String((orchestrationRaw as Record<string, unknown>).round ?? ""),
        }
        : null;
      return {
        slot,
        stale: Boolean(entry.stale),
        lastActivity: String(entry.lastActivity ?? ""),
        orchestration,
      };
    });
  } catch {
    return null;
  }
}

function computeSessionProjectMatches(): string {
  const harness = harnessDir();
  const sessionsFile = join(harness, "sessions.json");

  if (!existsSync(sessionsFile)) return "(no sessions data — run `ludics sessions report` first)";

  // Check freshness: skip if older than 15 minutes
  try {
    const mtime = statSync(sessionsFile).mtimeMs;
    if (Date.now() - mtime > 900_000) return "(stale session data — sessions.json older than 15 minutes)";
  } catch { return "(cannot read sessions.json)"; }

  // Parse sessions.json
  interface StrippedSession {
    cwd: string;
    cwdNormalized: string;
    agents: string[];
    ids: string[];
    lastActivityEpoch: number;
    lastActivity: string;
    stale: boolean;
    slot: number | null;
    slotPath: string | null;
    orchestration: { type: string; taskId: string; phase: string; round: string } | null;
    meta?: { tmux_session?: string; git_branch?: string; summary?: string; message_count?: number; port?: string };
  }

  let unclassified: StrippedSession[];
  try {
    const data = JSON.parse(readFileSync(sessionsFile, "utf-8")) as { unclassified?: StrippedSession[] };
    unclassified = data.unclassified ?? [];
  } catch { return "(invalid sessions.json)"; }

  if (unclassified.length === 0) return "(no unclassified sessions)";

  // Build repo-tail lookup from config
  const config = loadConfigSync();
  const projects = config.projects ?? [];
  const repoTailMap = new Map<string, ProjectMatch>();
  for (const p of projects) {
    const tail = (p.repo ?? "").split("/").pop() ?? "";
    if (!tail) continue;
    if (repoTailMap.has(tail)) {
      console.error(`ludics: adopt-sessions: duplicate repo tail "${tail}", keeping first`);
      continue;
    }
    repoTailMap.set(tail, { projectName: p.name, repo: p.repo });
  }

  if (repoTailMap.size === 0) return "(no projects configured)";

  // Read current slots: track which projects already have a slot and which slots are empty
  const sFile = slotsFilePath();
  const blocks = existsSync(sFile) ? parseSlotBlocks(readFileSync(sFile, "utf-8")) : new Map<number, string>();
  const count = slotsCount();
  const emptySlots: number[] = [];
  const projectsInSlots = new Map<string, number>(); // project name → slot number

  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    const process = block ? getProcess(block).trim() : "(empty)";
    if (!process || process === "(empty)") {
      emptySlots.push(i);
    } else if (block) {
      // Infer project from task or path
      const taskId = getTask(block).trim();
      if (taskId && taskId !== "null") {
        const taskFile = join(harness, "tasks", `${taskId}.md`);
        if (existsSync(taskFile)) {
          const content = readFileSync(taskFile, "utf-8");
          const pm = content.match(/^project:\s*(.+)$/m);
          if (pm) projectsInSlots.set(pm[1]!.trim(), i);
        }
      }
      // Also check path for project match
      const slotPath = getPath(block).trim();
      if (slotPath && slotPath !== "null") {
        const pathMatch = matchCwdToProject(slotPath, repoTailMap);
        if (pathMatch && !projectsInSlots.has(pathMatch.projectName)) {
          projectsInSlots.set(pathMatch.projectName, i);
        }
      }
    }
  }

  // Read ready tasks grouped by project
  const tasksDir = join(harness, "tasks");
  const tasksByProject = new Map<string, { id: string; title: string; priority: string; elaborated: boolean }[]>();

  if (existsSync(tasksDir)) {
    const taskFiles = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
    // Collect task IDs already in slots
    const tasksInSlots = new Set<string>();
    for (const [, block] of blocks) {
      const tid = getTask(block).trim();
      if (tid && tid !== "null") tasksInSlots.add(tid);
    }

    for (const f of taskFiles) {
      const content = readFileSync(join(tasksDir, f), "utf-8");
      const idMatch = content.match(/^id:\s*(.+)$/m);
      if (!idMatch) continue;
      const id = idMatch[1]!.trim();
      if (tasksInSlots.has(id)) continue;

      const statusMatch = content.match(/^status:\s*(.+)$/m);
      if (!statusMatch || statusMatch[1]!.trim() !== "ready") continue;

      // Check blocked_by
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        try {
          const fm = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
          const deps = fm.dependencies as Record<string, unknown> | undefined;
          const blockedBy = deps?.blocked_by;
          if (Array.isArray(blockedBy) && blockedBy.length > 0) continue;
        } catch { /* skip parse errors */ }
      }

      const projectMatch = content.match(/^project:\s*(.+)$/m);
      const project = projectMatch ? projectMatch[1]!.trim() : "";
      if (!project) continue;

      const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      const title = titleMatch ? titleMatch[1]! : id;

      const priorityMatch = content.match(/^priority:\s*(.+)$/m);
      const priority = priorityMatch ? priorityMatch[1]!.trim() : "B";

      const elaborated = isElaborated(content);

      const arr = tasksByProject.get(project) ?? [];
      arr.push({ id, title, priority, elaborated });
      tasksByProject.set(project, arr);
    }
  }

  // Sort tasks within each project: elaborated first, then by priority
  for (const [, tasks] of tasksByProject) {
    tasks.sort((a, b) => {
      if (a.elaborated !== b.elaborated) return a.elaborated ? -1 : 1;
      const pv = (p: string) => p === "A" ? 1 : p === "B" ? 2 : p === "C" ? 3 : 9;
      return pv(a.priority) - pv(b.priority);
    });
  }

  // Match sessions to projects and format output
  const lines: string[] = [];
  const matchedSessions: string[] = [];
  const unmatchedSessions: string[] = [];

  for (const session of unclassified) {
    const match = matchCwdToProject(session.cwdNormalized, repoTailMap);
    if (match) {
      const agents = session.agents.join(", ");
      const staleTag = session.stale ? "yes" : "no";
      const inSlot = projectsInSlots.has(match.projectName);

      matchedSessions.push(`### ${session.agents[0] ?? "unknown"} — ${session.cwd}`);
      matchedSessions.push(`- **Agents:** ${agents}`);
      matchedSessions.push(`- **Session IDs:** ${session.ids.join(", ")}`);
      matchedSessions.push(`- **Project:** ${match.projectName}`);
      matchedSessions.push(`- **Stale:** ${staleTag}`);
      if (inSlot) {
        matchedSessions.push(`- **Project already in slot:** ${projectsInSlots.get(match.projectName)}`);
      }
      // Session metadata
      const meta = session.meta;
      if (meta) {
        if (meta.tmux_session) matchedSessions.push(`- **tmux session:** ${meta.tmux_session}`);
        if (meta.git_branch) matchedSessions.push(`- **Git branch:** ${meta.git_branch}`);
        if (meta.summary) matchedSessions.push(`- **Summary:** ${meta.summary}`);
      }
      if (session.orchestration) {
        const o = session.orchestration;
        matchedSessions.push(`- **Orchestration:** ${o.type} (task: ${o.taskId || "?"}, phase: ${o.phase || "?"})`);
      }
      // Determine recommended adapter based on what infrastructure exists
      const hasAgentSessions = existsSync(join(session.cwdNormalized, ".agent-sessions"));
      if (session.orchestration) {
        matchedSessions.push(`- **Recommended adapter:** t3code (orchestration detected: ${session.orchestration.type})`);
      } else if (hasAgentSessions) {
        matchedSessions.push(`- **Recommended adapter:** t3code (.agent-sessions/ found)`);
      } else {
        matchedSessions.push(`- **Recommended adapter:** manual (no orchestration metadata)`);
      }

      const tasks = tasksByProject.get(match.projectName);
      if (tasks && tasks.length > 0) {
        matchedSessions.push(`- **Ready tasks for project:**`);
        for (const t of tasks.slice(0, 5)) {
          const elab = t.elaborated ? "elaborated" : "not elaborated";
          matchedSessions.push(`  - ${t.id} (${t.priority}, ${elab}): ${t.title}`);
        }
        if (tasks.length > 5) matchedSessions.push(`  - ... and ${tasks.length - 5} more`);
      } else {
        matchedSessions.push(`- **Ready tasks for project:** (none)`);
      }
      matchedSessions.push("");
    } else {
      const unmatchedMeta: string[] = [];
      if (session.meta?.tmux_session) unmatchedMeta.push(`tmux: ${session.meta.tmux_session}`);
      if (session.meta?.git_branch) unmatchedMeta.push(`branch: ${session.meta.git_branch}`);
      if (session.meta?.summary) unmatchedMeta.push(`summary: ${session.meta.summary}`);
      const metaSuffix = unmatchedMeta.length > 0 ? ` [${unmatchedMeta.join(", ")}]` : "";
      unmatchedSessions.push(`- ${session.agents[0] ?? "unknown"} — ${session.cwd} (no matching project)${metaSuffix}`);
    }
  }

  lines.push("## Session-Project Matches");
  lines.push("");

  if (matchedSessions.length > 0) {
    lines.push(...matchedSessions);
  } else {
    lines.push("(no sessions matched to projects)");
    lines.push("");
  }

  if (unmatchedSessions.length > 0) {
    lines.push("### Unmatched Sessions");
    lines.push("");
    lines.push(...unmatchedSessions);
    lines.push("");
  }

  lines.push("## Slot Availability");
  lines.push("");
  if (emptySlots.length > 0) {
    lines.push(`- **Empty slots:** ${emptySlots.join(", ")}`);
  } else {
    lines.push("- **Empty slots:** (none)");
  }
  if (projectsInSlots.size > 0) {
    const entries = Array.from(projectsInSlots.entries()).map(([p, s]) => `${p} (slot ${s})`);
    lines.push(`- **Projects already in slots:** ${entries.join(", ")}`);
  }

  return lines.join("\n");
}

function adoptSessionsPrecomputeContext(): void {
  const harness = harnessDir();
  const contextFile = join(harness, "mag", "adopt-sessions-context.md");
  mkdirSync(join(harness, "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const matches = computeSessionProjectMatches();

  const content = `# Adopt Sessions Context

Generated: ${timestamp}

${matches}
`;

  writeFileSync(contextFile + ".tmp", content);
  renameSync(contextFile + ".tmp", contextFile);
  console.error(`ludics: adopt-sessions context written to ${contextFile}`);
}

// --- Auto-queue proposals ---

const AUTO_PROPOSAL_DEBOUNCE_SECONDS = 1800;

function autoProposalDebounceFile(taskId: string): string {
  return join(magStateDir(), "auto-proposal-debounce", `${encodeURIComponent(taskId)}.epoch`);
}

function autoProposalDebounced(taskId: string): boolean {
  const file = autoProposalDebounceFile(taskId);
  if (!existsSync(file)) return false;
  try {
    const lastEpoch = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return (Math.floor(Date.now() / 1000) - lastEpoch) < AUTO_PROPOSAL_DEBOUNCE_SECONDS;
  } catch {
    return false;
  }
}

function markAutoProposalQueued(taskId: string): void {
  const file = autoProposalDebounceFile(taskId);
  mkdirSync(join(magStateDir(), "auto-proposal-debounce"), { recursive: true });
  writeFileSync(file, String(Math.floor(Date.now() / 1000)));
}

/** Auto-start slots that have proposals but no active session. */
function maybeAutoStartSlots(): void {
  if (startSessionsAutonomy() === "manual") return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, block] of blocks) {
    const process = getProcess(block).trim();
    if (!process || process === "(empty)") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    // Skip slots already marked as interrupted (setup failure) — needs manual resume
    const slotLiveness = getLiveness(block).trim();
    if (slotLiveness === "interrupted") continue;

    // Skip if the slot has an active session
    const orchState = readOrchestrationState(slotNum);
    if (orchState && orchState.phase !== "setup") continue;
    const sessionStarted = getSessionStarted(block).trim();
    if (sessionStarted && sessionStarted !== "null") continue;

    // Read task file — check for proposal
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");
    if (!content.includes("\nproposal:")) continue;

    // Task has a proposal but no session — auto-start
    try {
      slotStart(slotNum);
      emitEvent({ event_type: "slot_auto_start", source: "keepalive", scope: "slot", slot: slotNum, task: taskId, message: `auto-started slot ${slotNum} for ${taskId} (proposal exists, no session)` });
      console.error(`ludics: auto-started slot ${slotNum} for ${taskId} (proposal exists, no session)`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`ludics: failed to auto-start slot ${slotNum}: ${detail}`);
      markSlotSetupFailed(slotNum, detail);
    }
  }
}

/** Detect slots assigned but stuck: no proposal and no active session.
 *  Re-queues draft-proposal if the task is elaborated and has no unanswered questions.
 *  Logs slot_unstick events for visibility. */
function maybeUnstickAssignedSlots(): void {
  if (startSessionsAutonomy() === "manual") return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, block] of blocks) {
    const process = getProcess(block).trim();
    if (!process || process === "(empty)") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    // Skip slots marked as interrupted — needs manual resume
    const slotLiveness = getLiveness(block).trim();
    if (slotLiveness === "interrupted") continue;

    // Skip if session is active
    const sessionStarted = getSessionStarted(block).trim();
    if (sessionStarted && sessionStarted !== "null") continue;

    // Skip if there's an active orchestration
    const orchState = readOrchestrationState(slotNum);
    if (orchState && orchState.phase !== "done") continue;

    // Read task file
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");

    // Already has proposal — maybeAutoStartSlots handles this
    if (content.includes("\nproposal:")) continue;

    // Has unanswered questions — by design, wait for user
    if (content.includes("\nhas_questions:")) continue;

    // Not elaborated — needs elaboration first
    if (!isElaborated(content)) {
      if (!autoProposalDebounced(taskId)) {
        queueRequest("elaborate", `"task":"${taskId}"`);
        markAutoProposalQueued(taskId);
        emitEvent({ event_type: "slot_unstick", source: "keepalive", scope: "slot", slot: slotNum, task: taskId, message: `queued elaboration for stuck slot ${slotNum}` });
        console.error(`ludics: slot ${slotNum} stuck — queued elaboration for ${taskId}`);
      }
      continue;
    }

    // Elaborated, no questions, no proposal — re-queue draft-proposal
    if (!autoProposalDebounced(taskId)) {
      queueRequest("draft-proposal", `"task":"${taskId}"`);
      markAutoProposalQueued(taskId);
      emitEvent({ event_type: "slot_unstick", source: "keepalive", scope: "slot", slot: slotNum, task: taskId, message: `re-queued draft-proposal for stuck slot ${slotNum}` });
      console.error(`ludics: slot ${slotNum} stuck — re-queued draft-proposal for ${taskId}`);
    }
  }
}

/** Queue draft-proposals for the top ready queue tasks that are
 *  elaborated, have no unanswered questions, and have no proposal yet.
 *  Uses the same sorted candidate list as maybeFillEmptySlots. */
function maybeQueueProposals(): void {
  if (startSessionsAutonomy() === "manual") return;
  if (isQueueHeld()) return; // hold suppresses proposals too

  // Check if draft-proposal is already in queue
  const qFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(qFile)) {
    const qContent = readFileSync(qFile, "utf-8");
    if (qContent.includes('"draft-proposal"')) return;
  }

  // Reuse the sorted ready queue from maybeFillEmptySlots logic
  const sorted = getSortedReadyCandidates();
  if (sorted.length === 0) return;

  const tasksDir = join(harnessDir(), "tasks");

  // Find the first candidate that needs a proposal
  for (const task of sorted.slice(0, slotsCount())) {
    if (!task.elaborated) continue;

    // Read task content for additional checks
    const taskFile = join(tasksDir, `${task.id}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");

    if (content.includes("\nhas_questions:")) continue;
    if (content.includes("\nproposal:")) continue;
    if (autoProposalDebounced(task.id)) continue;

    queueRequest("draft-proposal", `"task":"${task.id}"`);
    markAutoProposalQueued(task.id);
    console.error(`ludics: auto-queued draft-proposal for ${task.id} (ready queue position)`);
    return; // one per cycle
  }
}

/** Nag user about tasks with unanswered questions (has_questions: true). */
function maybeNagQuestions(): void {
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  // Debounce: nag at most once per hour per task
  const NAG_INTERVAL_SECONDS = 3600;
  const nagDir = join(magStateDir(), "question-nag-debounce");

  const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));

  for (const f of files) {
    const content = readFileSync(join(tasksDir, f), "utf-8");
    if (!content.includes("\nhas_questions:")) continue;

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    let fm: Record<string, unknown>;
    try { fm = YAML.parse(fmMatch[1]!) as Record<string, unknown>; } catch { continue; }

    if (!fm.has_questions) continue;

    const id = String(fm.id ?? "").trim();
    const title = String(fm.title ?? "").trim();
    const status = String(fm.status ?? "").trim();
    if (status !== "ready" && status !== "in-progress") continue;

    // Check if task is assigned to a slot (increases urgency)
    const slotNum = fm.slot ? Number(fm.slot) : null;
    const isSlotted = slotNum !== null && slotNum > 0;
    // Shorter interval when a slot is blocked
    const interval = isSlotted ? Math.floor(NAG_INTERVAL_SECONDS / 2) : NAG_INTERVAL_SECONDS;

    // Debounce check
    const nagFile = join(nagDir, `${encodeURIComponent(id)}.epoch`);
    if (existsSync(nagFile)) {
      try {
        const lastEpoch = parseInt(readFileSync(nagFile, "utf-8").trim(), 10);
        if ((Math.floor(Date.now() / 1000) - lastEpoch) < interval) continue;
      } catch { /* proceed */ }
    }

    // Extract questions section from task body
    const questionsMatch = content.match(/## Questions\n\n([\s\S]*?)(?=\n##|\n---|\s*$)/);
    const questions = questionsMatch?.[1]?.trim();
    if (!questions || questions.toLowerCase() === "none.") continue;
    const slotNote = isSlotted ? ` (slot ${slotNum} blocked)` : "";

    // Send nag notification
    try {
      const result = Bun.spawnSync(
        ["ludics", "notify", "outgoing", `Unanswered questions${slotNote} — ${id}: ${title}\n\n${questions}`],
        { stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> },
      );
      if (result.exitCode === 0) {
        mkdirSync(nagDir, { recursive: true });
        writeFileSync(nagFile, String(Math.floor(Date.now() / 1000)));
        console.error(`ludics: nagged about unanswered questions for ${id}`);
      }
    } catch { /* non-critical */ }
  }
}

// --- Queue hold state ---

/** Returns the path to the queue-hold sentinel file. */
function queueHoldFilePath(): string {
  return join(harnessDir(), "mag", "queue-hold");
}

/** Returns true when the queue is held (auto-assignment suppressed). */
function isQueueHeld(): boolean {
  return existsSync(queueHoldFilePath());
}

// --- Sorted ready queue (shared) ---

interface ReadyCandidate { id: string; priority: string; project: string; milestone?: string; hasDeadline: boolean; deadline: string; effort: string; elaborated: boolean }

/** Compute the sorted ready queue — single source of truth for task ordering.
 *  Used by maybeFillEmptySlots, maybeQueueProposals, and dashboard generation. */
function getSortedReadyCandidates(): ReadyCandidate[] {
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return [];

  // Determine which tasks are already in slots
  const sFile = slotsFilePath();
  const tasksInSlots = new Set<string>();
  if (existsSync(sFile)) {
    const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
    const count = slotsCount();
    for (let i = 1; i <= count; i++) {
      const block = blocks.get(i);
      const taskId = block ? getTask(block).trim() : "";
      if (taskId && taskId !== "null") tasksInSlots.add(taskId);
    }
  }

  const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
  const candidates: ReadyCandidate[] = [];
  const allTasksForAffinity: AffinityInput[] = [];

  for (const f of files) {
    const content = readFileSync(join(tasksDir, f), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    let fm: Record<string, unknown>;
    try { fm = YAML.parse(fmMatch[1]!) as Record<string, unknown>; } catch { continue; }

    const id = String(fm.id ?? "").trim();
    if (!id) continue;

    const status = String(fm.status ?? "ready").trim();
    const deps = (fm.dependencies as Record<string, unknown>) ?? {};

    allTasksForAffinity.push({
      id, status,
      completed: fm.completed ? String(fm.completed) : null,
      dependencies: {
        blocks: Array.isArray(deps.blocks) ? deps.blocks as string[] : [],
        blocked_by: Array.isArray(deps.blocked_by) ? deps.blocked_by as string[] : [],
        relates_to: Array.isArray(deps.relates_to) ? deps.relates_to as string[] : [],
      },
    });

    if (tasksInSlots.has(id)) continue;
    if (status !== "ready") continue;
    const blockedBy = deps.blocked_by;
    if (Array.isArray(blockedBy) && blockedBy.length > 0) continue;

    const priority = String(fm.priority ?? "B").trim();
    const project = String(fm.project ?? "").trim();
    const milestone = fm.milestone ? String(fm.milestone).trim() : undefined;
    const deadlineRaw = fm.deadline ? String(fm.deadline).trim() : "";
    const deadline = deadlineRaw && deadlineRaw !== "null" ? deadlineRaw : "";
    const effort = String(fm.effort ?? "small").trim();
    const elaborated = isElaborated(content);

    candidates.push({ id, priority, project, milestone, hasDeadline: !!deadline, deadline, effort, elaborated });
  }

  if (candidates.length === 0) return [];

  // Sort by: relative milestone position > effective priority > affinity tier > deadline
  const milestonesProjects = milestonesEnabledProjects();
  const affinity = buildAffinityLookup(allTasksForAffinity, tasksInSlots);

  const milestonePosition = new Map<string, number>();
  if (milestonesProjects.size > 0) {
    const projectMilestones = new Map<string, Set<string>>();
    for (const c of candidates) {
      if (!milestonesProjects.has(c.project) || !c.milestone) continue;
      let ms = projectMilestones.get(c.project);
      if (!ms) { ms = new Set(); projectMilestones.set(c.project, ms); }
      ms.add(c.milestone);
    }
    for (const [project, ms] of projectMilestones) {
      const sorted = [...ms].sort();
      for (let i = 0; i < sorted.length; i++) {
        milestonePosition.set(`${project}\0${sorted[i]}`, i);
      }
    }
  }

  function relMilestonePos(c: ReadyCandidate): number {
    if (!c.milestone || !milestonesProjects.has(c.project)) return 0;
    return milestonePosition.get(`${c.project}\0${c.milestone}`) ?? 0;
  }

  candidates.sort((a, b) => {
    const mp = relMilestonePos(a) - relMilestonePos(b);
    if (mp !== 0) return mp;
    const pd = effectivePriorityValue(a.priority, a.project) - effectivePriorityValue(b.priority, b.project);
    if (pd !== 0) return pd;
    const td = affinity.getTier(a.id) - affinity.getTier(b.id);
    if (td !== 0) return td;
    if (a.hasDeadline !== b.hasDeadline) return a.hasDeadline ? -1 : 1;
    return (a.deadline || "9999").localeCompare(b.deadline || "9999");
  });

  return candidates;
}

// --- Auto-fill empty slots ---

function maybeFillEmptySlots(): void {
  if (startSessionsAutonomy() === "manual") return;
  if (isQueueHeld()) return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const count = slotsCount();
  const emptySlots: number[] = [];

  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    const process = block ? getProcess(block).trim() : "(empty)";
    if (!process || process === "(empty)") {
      emptySlots.push(i);
    }
  }

  if (emptySlots.length === 0) return;

  const candidates = getSortedReadyCandidates();
  if (candidates.length > 0) {
    const top5 = candidates.slice(0, 5).map((c) => `${c.id}(p=${c.priority},ep=${effectivePriorityValue(c.priority, c.project)},elab=${c.elaborated})`);
    console.error(`ludics: auto-fill candidates (top 5): ${top5.join(", ")}`);
  }

  // Fill at most 1 empty slot per keepalive cycle (conservative)
  // If the top candidate isn't elaborated, queue elaboration instead of assigning
  const topCandidate = candidates[0]!;
  if (!topCandidate.elaborated) {
    if (!autoProposalDebounced(topCandidate.id)) {
      queueRequest("elaborate", `"task":"${topCandidate.id}"`);
      markAutoProposalQueued(topCandidate.id); // reuse debounce to avoid re-queuing
      emitEvent({ event_type: "task_elaborate_queued", source: "keepalive", scope: "task", task: topCandidate.id, message: `top candidate needs elaboration` });
      console.error(`ludics: top candidate ${topCandidate.id} needs elaboration — queued`);
    }
    // Skip to the first elaborated candidate for slot assignment
    const elaboratedIdx = candidates.findIndex((c) => c.elaborated);
    if (elaboratedIdx < 0) return; // no elaborated candidates at all
    candidates.splice(0, elaboratedIdx); // remove unelabroated ones from front
  }

  const task = candidates[0]!;

  // Auto-select orchestration flags based on task effort
  const { adapter: autoAdapter, args: autoArgs, isDuo } = selectOrchestrationFlags(task.effort);

  // Hierarchical duo: need 2 empty slots; assign both with swapped coder/reviewer
  if (isDuo) {
    if (emptySlots.length < 2) {
      console.error(`ludics: duo task ${task.id} needs 2 empty slots but only ${emptySlots.length} available — skipping`);
      // Try next non-duo candidate (if any)
      return;
    }
    // Guard: check task isn't already assigned to any active slot
    for (const [, block] of blocks) {
      if (block && getTask(block).trim() === task.id) {
        console.error(`ludics: duo task ${task.id} already assigned — skipping`);
        return;
      }
    }
    const slotA = emptySlots[0]!;
    const slotB = emptySlots[1]!;
    const expansion = expandDuoSlots(slotA, slotB, autoArgs);
    const projectPath = resolveProjectPath(task.project);
    const machine = selectMachineForSlot({ project: task.project, effort: task.effort });

    slotAssign(slotA, task.id, autoAdapter, "", projectPath, expansion.slotA.args, machine);
    slotAssign(slotB, task.id, autoAdapter, "", projectPath, expansion.slotB.args, machine);
    emitEvent({
      event_type: "slot_auto_fill_duo",
      source: "keepalive",
      scope: "slot",
      slot: slotA,
      task: task.id,
      adapter: autoAdapter,
      effort: task.effort,
      flags: expansion.slotA.args,
      machine: machine || undefined,
      message: `auto-assigned duo ${task.id} to slots ${slotA}+${slotB} with effort=${task.effort}${machine ? ` on ${machine}` : ""}`,
    });
    console.error(`ludics: auto-assigned duo ${task.id} to slots ${slotA}+${slotB} with effort=${task.effort} (${autoAdapter})${machine ? ` on ${machine}` : ""}`);
  } else {
    const slot = emptySlots[0]!;

    // Resolve project path from config
    const projectPath = resolveProjectPath(task.project);

    // Select machine for slot assignment (federation-aware)
    const machine = selectMachineForSlot({ project: task.project, effort: task.effort });

    // Assign task to the empty slot using the auto-selected adapter, path, and flags
    slotAssign(slot, task.id, autoAdapter, "", projectPath, autoArgs, machine);
    emitEvent({
      event_type: "slot_auto_fill",
      source: "keepalive",
      scope: "slot",
      slot,
      task: task.id,
      adapter: autoAdapter,
      effort: task.effort,
      flags: autoArgs,
      machine: machine || undefined,
      message: `auto-assigned ${task.id} to slot ${slot} with effort=${task.effort}: ${autoArgs}${machine ? ` on ${machine}` : ""}`,
    });
    console.error(`ludics: auto-assigned ${task.id} to slot ${slot} with effort=${task.effort} (${autoAdapter} ${autoArgs})${machine ? ` on ${machine}` : ""}`);
  }

  // Queue draft-proposal only if the task doesn't already have a proposal
  const taskFile = join(harnessDir(), "tasks", `${task.id}.md`);
  const taskContent = existsSync(taskFile) ? readFileSync(taskFile, "utf-8") : "";
  if (!taskContent.includes("\nproposal:")) {
    queueRequest("draft-proposal", `"task":"${task.id}"`);
    markAutoProposalQueued(task.id);
    emitEvent({ event_type: "mag_auto_proposal", source: "keepalive", scope: "mag", task: task.id, message: `auto-queued draft-proposal for ${task.id}` });
    console.error(`ludics: auto-queued draft-proposal for ${task.id}`);
  }
}

// --- Auto-resume dead orchestrator processes ---

/**
 * Detect dead orchestrator processes and auto-resume via slotResume().
 * Follows the maybeClearDoneSlots() pattern.
 * Rate-limited: at most 1 resume per keepalive invocation.
 */
export function orchPidForSlotMode(
  slotNum: number,
  mode: string,
): number | undefined {
  if (mode === "t3code") {
    return readSlotState(slotNum)?.orchestration?.pid;
  }
  if (mode === "tmux") {
    return readTmuxSlotState(slotNum, harnessDir())?.orchestration?.pid;
  }
  return undefined;
}

async function maybeResumeDeadOrchestrators(): Promise<void> {
  if (startSessionsAutonomy() === "manual") return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  let resumed = 0;

  for (const [slotNum, block] of blocks) {
    if (resumed >= 1) break; // rate-limit: at most 1 per invocation

    // IMPORTANT: use `slotProcess` not `process` to avoid shadowing the global
    const slotProcess = getProcess(block).trim();
    if (!slotProcess || slotProcess === "(empty)") continue;

    const mode = getMode(block).trim();
    if (mode !== "t3code" && mode !== "tmux") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    const orchState = readOrchestrationState(slotNum);
    if (!orchState) continue;
    if (orchState.phase === "done") continue;

    // Guard: orchestration state must match slot's current task
    if (orchState.taskId && orchState.taskId !== taskId) continue;

    const orchPid = orchPidForSlotMode(slotNum, mode);
    if (!orchPid || orchPid <= 0) continue;
    const pid = orchPid;
    let alive = true;
    try {
      process.kill(pid, 0); // global process — PID liveness check
    } catch {
      alive = false;
    }
    if (alive) continue;

    console.error(
      `ludics: detected dead orchestrator for slot ${slotNum} ` +
      `(pid ${pid}, task ${taskId}, phase ${orchState.phase}) — auto-resuming`,
    );
    try {
      await slotResume(slotNum);
      resumed += 1;
      emitEvent({
        event_type: "orchestration_auto_resume",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        deadPid: pid,
        message: `auto-resumed dead orchestrator (pid ${pid}, phase=${orchState.phase})`,
      });
    } catch (err) {
      console.error(
        `ludics: failed to auto-resume slot ${slotNum}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      emitEvent({
        event_type: "orchestration_auto_resume_failed",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        status: "failed",
        message: `auto-resume failed for slot ${slotNum}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

// --- Auto-clear slots whose task reached done status ---

function maybeClearDoneSlots(): void {
  if (startSessionsAutonomy() === "manual") return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  for (const [slotNum, block] of blocks) {
    const process = getProcess(block).trim();
    if (!process || process === "(empty)") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;

    const content = readFileSync(taskFile, "utf-8");
    const statusMatch = content.match(/^status:\s*(.+)$/m);
    const taskStatus = statusMatch ? statusMatch[1]!.trim() : "";

    if (taskStatus === "done") {
      console.error(`ludics: auto-clearing slot ${slotNum} (task ${taskId} is ${taskStatus})`);
      emitEvent({
        event_type: "slot_auto_clear",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        status: taskStatus,
        message: `auto-cleared slot ${slotNum}: task ${taskId} reached status=${taskStatus}`,
      });
      slotClear(slotNum, taskStatus);
    }
  }
}

// --- Worker keepalive (machine-local automations, no controller duties) ---

async function workerKeepalive(): Promise<void> {
  console.error("ludics: worker keepalive");

  // Pull fresh state so automations see latest slot assignments
  try { const { statePull } = await import("./state.ts"); statePull(); } catch { /* ignore */ }

  // Publish terminal state for this machine's sessions
  publishTerminalState();

  // Resume dead orchestrator processes on this machine's slots
  await maybeResumeDeadOrchestrators();

  // Start slots assigned to this machine that were dispatched but never started
  await maybeStartDispatchedSlots();

  // Checkpoint and push if anything changed.
  // Heartbeat is NOT published here — federation trigger handles it.
  try { stateCheckpoint("keepalive"); } catch { /* ignore */ }
}

/**
 * Detect slots assigned to this machine that have Session Started set
 * (controller dispatched them) but no orchestration state and no running
 * sessions — the start was lost (e.g. due to sync failure). Start them fresh.
 */
async function maybeStartDispatchedSlots(): Promise<void> {
  if (startSessionsAutonomy() === "manual") return;

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const currentMachine = federationCurrentMachineName();
  if (!currentMachine) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const tasksDir = join(harnessDir(), "tasks");

  for (const [slotNum, block] of blocks) {
    const slotProcess = getProcess(block).trim();
    if (!slotProcess || slotProcess === "(empty)") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    const mode = getMode(block).trim();
    if (mode !== "t3code" && mode !== "tmux") continue;

    // Only act on slots assigned to this machine
    const machine = getMachine(block).trim();
    if (machine !== currentMachine) continue;

    // Must have Session Started (controller dispatched it)
    const sessionStarted = getSessionStarted(block).trim();
    if (!sessionStarted || sessionStarted === "null") continue;

    // Skip if orchestration state exists — maybeResumeDeadOrchestrators handles that
    const orchState = readOrchestrationState(slotNum);
    if (orchState) continue;

    // Skip if marked interrupted — needs manual intervention
    const liveness = getLiveness(block).trim();
    if (liveness === "interrupted") continue;

    // Check that the task has a proposal (required for start)
    if (existsSync(tasksDir)) {
      const taskFile = join(tasksDir, `${taskId}.md`);
      if (!existsSync(taskFile)) continue;
      const content = readFileSync(taskFile, "utf-8");
      if (!content.includes("\nproposal:")) continue;
    }

    // Dispatched but never started — start fresh
    console.error(`ludics: slot ${slotNum} was dispatched to this machine but never started — starting now`);
    try {
      await slotStart(slotNum);
      emitEvent({
        event_type: "slot_auto_start",
        source: "keepalive",
        scope: "slot",
        slot: slotNum,
        task: taskId,
        message: `auto-started slot ${slotNum} for ${taskId} (dispatched but never started)`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`ludics: failed to start dispatched slot ${slotNum}: ${detail}`);
      markSlotSetupFailed(slotNum, detail);
    }
    break; // rate-limit: at most 1 per invocation
  }
}

// --- Mag CLI commands ---

export async function magStart(args: string[]): Promise<void> {
  let useTtyd = true;
  let skipFederation = false;

  for (const arg of args) {
    if (arg === "--no-ttyd") useTtyd = false;
    if (arg === "--skip-federation") skipFederation = true;
  }

  if (!tmuxAvailable()) throw new Error("mag start: tmux is required but not installed");

  // Check federation — on worker nodes, run machine-local automations only
  if (!skipFederation && !federationShouldRunMag()) {
    await workerKeepalive();
    return;
  }

  // Session already exists - keepalive path
  if (magIsRunning()) {
    // Re-check federation on keepalive — controller may have changed since session started
    if (!skipFederation && !federationShouldRunMag()) {
      await workerKeepalive();
      return;
    }
    if (useTtyd) ensureTtyd();

    // Ensure t3code server is running (idempotent)
    await ensureT3codeIfEnabled("keepalive");

    // Publish terminal state to ntfy (dedup'd)
    publishTerminalState();

    // Expire pending-revise flags that timed out (15 min)
    expirePendingRevises();
    expirePendingFollowupRevises();

    // When paused, skip all automation — nothing queues, drains, or nudges
    if (existsSync(join(harnessDir(), "mag", "paused"))) return;

    // Auto-start slots that have proposals but no active session
    maybeAutoStartSlots();

    // Detect stuck slots (assigned but no proposal/session) and re-queue
    maybeUnstickAssignedSlots();

    // Auto-queue proposals for top ready queue tasks (not slot-dependent)
    maybeQueueProposals();

    // Nag user about tasks with unanswered questions
    maybeNagQuestions();

    // Auto-clear slots whose task reached done status
    maybeClearDoneSlots();

    // Auto-resume dead orchestrator processes
    await maybeResumeDeadOrchestrators();

    // Auto-fill empty slots with ready elaborated tasks
    maybeFillEmptySlots();

    // If startup got stuck (e.g. Claude helper hung), recover automatically.
    maybeRecoverStuckStartup();

    // Execute programmatic head requests immediately; only nudge when the next
    // queued request requires a Mag turn (skill/direct message).
    const queueNeedsMagTurn = queuePending() ? await drainProgrammaticQueueHead() : false;
    if (queueNeedsMagTurn && !nudgeThrottled()) {
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const nudged = triggerSkill(MAG_SESSION_NAME, `Continue previous work if any. Queue requests arrive as skill commands on stop hook. (ludics, ${now})`);
      if (nudged) {
        writeNudgeTimestamp();
        emitEvent({ event_type: "mag_nudge", source: "keepalive", scope: "mag", message: "nudged Mag with Continue" });
      } else {
        console.error("ludics: failed to nudge Mag via tmux send-keys");
        emitEvent({ event_type: "mag_nudge_failed", source: "keepalive", scope: "mag", status: "failed", message: "tmux send-keys failed" });
      }
    }

    // Checkpoint accumulated state changes and sync with remote.
    // Heartbeat is NOT published here — federation trigger handles it on a
    // slower cadence, avoiding needless commits when nothing changed.
    try { stateCheckpoint("keepalive"); } catch { /* ignore */ }
    return;
  }

  // Create state directory
  const stateDir = magStateDir();
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "memory"), { recursive: true });
  mkdirSync(join(stateDir, "memory", "projects"), { recursive: true });

  const workingDir = harnessDir();

  // Write state file
  const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(magStateFile(), `session=${MAG_SESSION_NAME}\nstarted=${started}\nworking_dir=${workingDir}\nstatus=starting\n`);

  // Create tmux session
  console.error(`ludics: Creating Mag tmux session '${MAG_SESSION_NAME}' in ${workingDir}`);
  tmuxNewSession(MAG_SESSION_NAME, workingDir);
  // Prevent accidental wheel-scroll copy-mode lockups in web terminals.
  Bun.spawnSync(["tmux", "set-option", "-t", MAG_SESSION_NAME, "mouse", "off"], { stdout: "pipe", stderr: "pipe" });

  magSignal("running", "session started");
  emitEvent({ event_type: "mag_start", source: "cli", scope: "mag", message: `Mag session ${MAG_SESSION_NAME} started` });

  // Export environment variables for skills
  const statePath = harnessDir();
  const resultsPath = join(statePath, "mag", "results");
  mkdirSync(resultsPath, { recursive: true });
  const envExported = tmuxSendCommand(MAG_SESSION_NAME, `export LUDICS_STATE_PATH="${statePath}" LUDICS_RESULTS_DIR="${resultsPath}"`);
  if (!envExported) {
    console.error("ludics: failed to export environment variables in Mag tmux session");
  }
  Bun.spawnSync(["sleep", "0.5"], { stdout: "pipe", stderr: "pipe" });

  // Start Claude Code
  const hasClaude = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (hasClaude) {
    writeStartupWatchdogEpoch();
    const claudeStarted = tmuxSendCommand(MAG_SESSION_NAME, claudeLaunchCommand());
    if (claudeStarted) {
      console.error("ludics: Started Claude Code in Mag session");
    } else {
      console.error("ludics: failed to send Claude start command to Mag tmux session");
      emitEvent({ event_type: "mag_startup_recover", source: "cli", scope: "mag", status: "failed", message: "tmux send-command failed at startup" });
    }
  } else {
    console.error("ludics: claude CLI not found; session started without Claude Code");
    clearStartupWatchdogEpoch();
  }

  console.log(`Mag session started. Attach with: tmux attach -t ${MAG_SESSION_NAME}`);

  if (useTtyd) ensureTtyd();

  // Ensure t3code server on fresh start
  await ensureT3codeIfEnabled("fresh start");

  // Drain programmatic requests first, then deliver one skill/direct request.
  await drainProgrammaticQueueHead();
  const skillCmd = await queuePopSkill();
  if (skillCmd) {
    Bun.spawnSync(["sleep", "5"], { stdout: "pipe", stderr: "pipe" });
    console.error(`ludics: Mag fresh start, sending queued request: ${skillCmd}`);
    const sent = triggerSkill(MAG_SESSION_NAME, skillCmd);
    if (!sent) {
      console.error("ludics: failed to send queued request to Mag session");
      emitEvent({ event_type: "mag_nudge_failed", source: "cli", scope: "mag", status: "failed", message: "failed sending startup queued request" });
    }
  }
}

export function magStop(): void {
  if (!tmuxAvailable()) throw new Error("mag stop: tmux is not available");

  if (!magIsRunning()) {
    console.error(`ludics: Mag session '${MAG_SESSION_NAME}' is not running`);
    return;
  }

  magSignal("stopped", "session stopped by user");

  // Kill ttyd
  const pgrep = Bun.spawnSync(["pgrep", "-f", `ttyd.*${MAG_SESSION_NAME}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (pgrep.exitCode === 0) {
    const pids = pgrep.stdout.toString().trim();
    if (pids) {
      console.error("ludics: Stopping ttyd process(es)...");
      Bun.spawnSync(["kill", ...pids.split("\n")], { stdout: "pipe", stderr: "pipe" });
    }
  }

  console.error(`ludics: Stopping Mag tmux session '${MAG_SESSION_NAME}'...`);
  tmuxKillSession(MAG_SESSION_NAME);
  emitEvent({ event_type: "mag_stop", source: "cli", scope: "mag", message: `Mag session ${MAG_SESSION_NAME} stopped` });

  // Append stopped timestamp
  const stateFile = magStateFile();
  if (existsSync(stateFile)) {
    const stopped = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const content = readFileSync(stateFile, "utf-8");
    writeFileSync(stateFile, content + `stopped=${stopped}\n`);
  }

  try { stateCheckpoint("mag stopped"); } catch { /* ignore */ }
  console.log("Mag session stopped.");
}

export function magStatusCmd(): void {
  const stateFile = magStateFile();
  const statusFile = magStatusFile();

  console.log("=== Mag Status ===");
  console.log("");

  if (magIsRunning()) {
    console.log(`Session: ${MAG_SESSION_NAME} (running)`);
  } else {
    console.log(`Session: ${MAG_SESSION_NAME} (not running)`);
    if (existsSync(stateFile)) {
      const content = readFileSync(stateFile, "utf-8");
      const stoppedMatch = content.match(/^stopped=(.+)$/m);
      if (stoppedMatch) console.log(`Last stopped: ${stoppedMatch[1]}`);
    }
    console.log("");
    console.log("Start with: ludics mag start");
    return;
  }

  console.log("");

  if (existsSync(stateFile)) {
    const content = readFileSync(stateFile, "utf-8");
    const startedMatch = content.match(/^started=(.+)$/m);
    if (startedMatch) console.log(`Started: ${startedMatch[1]}`);
    const wdMatch = content.match(/^working_dir=(.+)$/m);
    if (wdMatch) console.log(`Working directory: ${wdMatch[1]}`);
  }

  if (existsSync(statusFile)) {
    const line = readFileSync(statusFile, "utf-8").trim();
    const parts = line.split("|");
    const statusText = parts[0] ?? "";
    const statusEpoch = parseInt(parts[1] ?? "0", 10);
    const statusMsg = parts.slice(2).join("|");

    console.log("");
    console.log(`Status: ${statusText}`);
    if (statusMsg) console.log(`Message: ${statusMsg}`);
    if (statusEpoch) {
      const diff = Math.floor(Date.now() / 1000) - statusEpoch;
      const mins = Math.floor(diff / 60);
      if (mins < 60) {
        console.log(`Last activity: ${mins}m ago`);
      } else {
        console.log(`Last activity: ${Math.floor(mins / 60)}h ago`);
      }
    }
  }

  // Queue status
  console.log("");
  const queueFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(queueFile)) {
    const content = readFileSync(queueFile, "utf-8").trim();
    const pending = content ? content.split("\n").length : 0;
    console.log(`Pending requests: ${pending}`);
  } else {
    console.log("Pending requests: 0");
  }

  // Memory status
  console.log("");
  const memDir = join(magStateDir(), "memory");
  if (existsSync(memDir)) {
    console.log("Memory:");
    if (existsSync(join(memDir, "corrections.md"))) {
      const content = readFileSync(join(memDir, "corrections.md"), "utf-8");
      const count = (content.match(/^-/gm) ?? []).length;
      console.log(`  - Corrections: ${count} entries`);
    }
    if (existsSync(join(memDir, "tools.md"))) console.log("  - Tools: present");
    if (existsSync(join(memDir, "workflows.md"))) console.log("  - Workflows: present");

    const projDir = join(memDir, "projects");
    if (existsSync(projDir)) {
      const projCount = readdirSync(projDir).filter((f: string) => f.endsWith(".md")).length;
      if (projCount > 0) console.log(`  - Projects: ${projCount}`);
    }
  }

  // Context file
  if (existsSync(join(magStateDir(), "context.md"))) {
    console.log("");
    console.log("Context file: present");
  }
}

export function magAttach(): void {
  if (!magIsRunning()) {
    throw new Error(`Mag session '${MAG_SESSION_NAME}' is not running. Start with: ludics mag start`);
  }
  if (process.env.TMUX) {
    if (tmuxSwitchClient(MAG_SESSION_NAME)) return;
  }
  // exec replaces the process — Bun.spawnSync with inherit so user gets the terminal
  Bun.spawnSync(["tmux", "attach", "-t", MAG_SESSION_NAME], { stdio: ["inherit", "inherit", "inherit"] });
}

export function magLogs(lines: number = 100): void {
  if (!tmuxAvailable()) throw new Error("mag logs: tmux is not available");

  if (!magIsRunning()) {
    console.error(`ludics: Mag session '${MAG_SESSION_NAME}' is not running`);
    const resultsDir = join(harnessDir(), "mag", "results");
    if (existsSync(resultsDir)) {
      console.log("Recent results:");
      const files = readdirSync(resultsDir)
        .filter((f: string) => f.endsWith(".json"))
        .map((f: string) => join(resultsDir, f))
        .sort()
        .reverse()
        .slice(0, 5);
      for (const f of files) {
        console.log("---");
        console.log(readFileSync(f, "utf-8").trim());
      }
    }
    return;
  }

  console.log(`=== Mag Session Logs (last ${lines} lines) ===`);
  console.log("");
  const captured = tmuxCapture(MAG_SESSION_NAME, lines);
  if (captured !== null) {
    console.log(captured);
  }
}

export function magDoctor(): void {
  let allOk = true;

  console.log("=== Mag Health Check ===");
  console.log("");

  // tmux
  const hasTmux = tmuxAvailable();
  if (hasTmux) {
    const ver = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    console.log(`tmux: ${ver.stdout.toString().trim()}`);
  } else {
    console.log("tmux: NOT FOUND (required)");
    allOk = false;
  }

  // claude
  const hasClaude = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (hasClaude) {
    const path = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
    console.log(`claude: found at ${path.stdout.toString().trim()}`);
  } else {
    console.log("claude: NOT FOUND");
    console.log("  Install: npm install -g @anthropic-ai/claude-code");
    allOk = false;
  }

  // jq
  const hasJq = Bun.spawnSync(["which", "jq"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (hasJq) {
    console.log("jq: found");
  } else {
    console.log("jq: NOT FOUND (required for queue processing)");
    allOk = false;
  }

  // ttyd
  const hasTtyd = Bun.spawnSync(["which", "ttyd"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (hasTtyd) {
    const path = Bun.spawnSync(["which", "ttyd"], { stdout: "pipe", stderr: "pipe" });
    console.log(`ttyd: found at ${path.stdout.toString().trim()}`);
  } else {
    console.log("ttyd: NOT FOUND (optional, for web access)");
    console.log("  Install: brew install ttyd (macOS) or apt install ttyd (Linux)");
  }

  console.log("");

  if (magIsRunning()) {
    console.log("Mag session: running");
  } else {
    console.log("Mag session: not running");
  }

  const stateDir = magStateDir();
  if (existsSync(stateDir)) {
    console.log(`State directory: ${stateDir}`);
  } else {
    console.log(`State directory: ${stateDir} (not created yet)`);
  }

  const queueFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(queueFile)) {
    const content = readFileSync(queueFile, "utf-8").trim();
    const pending = content ? content.split("\n").length : 0;
    console.log(`Queue: ${queueFile} (${pending} pending)`);
  } else {
    console.log("Queue: not initialized");
  }

  console.log("");
  console.log("Stop hook locations to check:");
  console.log("  - ~/.claude/hooks/ludics-on-stop.sh");
  console.log("  - ~/.config/claude-code/hooks/ludics-on-stop.sh");

  const hookLocations = [
    join(process.env.HOME!, ".claude/hooks/ludics-on-stop.sh"),
    join(process.env.HOME!, ".config/claude-code/hooks/ludics-on-stop.sh"),
  ];
  let hookFound = false;
  for (const loc of hookLocations) {
    if (existsSync(loc)) {
      console.log(`  Found: ${loc}`);
      hookFound = true;
      break;
    }
  }
  if (!hookFound) {
    console.log("  Not found - install with: ludics init --hooks");
    allOk = false;
  }

  console.log("");
  if (allOk) {
    console.log("All checks passed");
  } else {
    console.log("Some checks failed");
    process.exit(1);
  }
}

export function magBriefing(wait: boolean = true, timeout: number = 300): void {
  if (!federationIsController()) {
    console.error("ludics: mag briefing skipped — not the federation controller");
    return;
  }
  const requestId = queueRequest("briefing");
  console.log(`Queued briefing request: ${requestId}`);

  // Auto-queue feedback-digest once daily alongside the briefing trigger.
  // Existing cooldown/dedup guards prevent redundant runs.
  if (!queueHasPendingFeedbackDigest("ludics") && feedbackDigestCooldownRemaining("ludics") === 0) {
    queueRequest("feedback-digest", `"repo":"ludics"`);
    markFeedbackDigestQueued("ludics");
    console.error("ludics: briefing queued feedback-digest for ludics");
  }

  if (!wait) {
    console.log("Mag will process when ready");
    return;
  }

  if (!magIsRunning()) {
    console.error("ludics: Mag session is not running. Start with: ludics mag start");
    console.error("ludics: Or process manually: the request is queued");
    return;
  }

  console.log(`Waiting for Mag to process (timeout: ${timeout}s)...`);

  // Wait for result
  const resultsDir = join(harnessDir(), "mag", "results");
  const resultFile = join(resultsDir, `${requestId}.json`);
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      const content = readFileSync(resultFile, "utf-8");
      console.log("");
      console.log("=== Briefing Result ===");
      try {
        const result = JSON.parse(content) as Record<string, unknown>;
        console.log(String(result.output ?? "No output"));
      } catch {
        console.log(content);
      }
      return;
    }
    Bun.sleepSync(2000);
  }

  console.error("ludics: Timeout waiting for briefing result");
}

function magMessage(text: string): void {
  queueRequest("message", `"content":${JSON.stringify(text)}`);
  console.log("Message queued for Mag");
}

async function magContext(): Promise<void> {
  await briefingPrecomputeContext();
}

function magCompleted(proposalName: string): void {
  const harness = harnessDir();
  const tasksPath = join(harness, "tasks");
  if (!existsSync(tasksPath)) {
    throw new Error("tasks directory not found");
  }

  const files = readdirSync(tasksPath).filter((f: string) => f.endsWith(".md"));

  let matchedTaskId: string | null = null;
  let matchedSlot: number | null = null;

  for (const f of files) {
    const content = readFileSync(join(tasksPath, f), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    let data: Record<string, unknown>;
    try {
      data = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
    } catch { continue; }

    const status = String(data.status ?? "");
    if (status !== "in-progress") continue;

    const proposal = String(data.proposal ?? "").trim();
    if (!proposal || proposal.toLowerCase() === "null") continue;

    // Match proposal field: docs/<name>.md, <name>.md, or path ending in /<name>.md
    const matches =
      proposal === `docs/${proposalName}.md` ||
      proposal === `${proposalName}.md` ||
      proposal.endsWith(`/${proposalName}.md`);
    if (!matches) continue;

    matchedTaskId = String(data.id ?? "");
    const slotVal = data.slot;
    if (slotVal && String(slotVal) !== "null") {
      const parsed = parseInt(String(slotVal), 10);
      if (Number.isFinite(parsed)) matchedSlot = parsed;
    }
    break;
  }

  if (!matchedTaskId) {
    console.error(`ludics: no in-progress task found matching proposal "${proposalName}"`);
    process.exit(1);
  }

  if (matchedSlot !== null) {
    slotClear(matchedSlot, "done");
    console.log(`Completed task ${matchedTaskId} (slot ${matchedSlot} cleared)`);
  } else {
    taskCompleteDirectly(matchedTaskId);
    console.log(`Completed task ${matchedTaskId} (no slot, direct update)`);
  }

  journalAppend("mag", `Completed task ${matchedTaskId} via proposal signal: ${proposalName}`);
  emitEvent({ event_type: "mag_completed", source: "mag", scope: "mag", task: matchedTaskId, slot: matchedSlot ?? undefined, message: `completed via proposal signal: ${proposalName}` });
}

export async function runMag(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "start":
      await magStart(args.slice(1));
      break;
    case "stop":
      magStop();
      break;
    case "status":
      magStatusCmd();
      break;
    case "attach":
      magAttach();
      break;
    case "logs": {
      const lines = args[1] ? parseInt(args[1], 10) : 100;
      magLogs(lines);
      break;
    }
    case "doctor":
      magDoctor();
      break;
    case "briefing":
      magBriefing();
      break;
    case "suggest":
      queueRequest("suggest");
      console.log("Queued suggest request");
      break;
    case "elaborate": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("elaborate", `"task":"${taskId}"`);
      console.log(`Queued elaborate request for ${taskId}`);
      break;
    }
    case "health-check":
      if (!federationIsController()) {
        console.error("ludics: mag health-check skipped — not the federation controller");
        break;
      }
      queueRequest("health-check");
      console.log("Queued health-check request");
      break;
    case "message": {
      const text = args.slice(1).join(" ");
      if (!text) throw new Error("message text required");
      magMessage(text);
      break;
    }
    case "queue": {
      // Reuse the existing queueShow
      const { queueShow } = await import("./queue.ts");
      queueShow();
      break;
    }
    case "context":
      await magContext();
      break;
    case "auto-start-evaluate": {
      const taskId = args[1];
      const confidence = args[2];
      const rationale = args[3] ?? "";
      if (!taskId) throw new Error("task id required");
      const result = evaluateAutoStartDecisionPure(
        confidence === "high" || confidence === "low" ? confidence : undefined,
        rationale,
        startSessionsAutonomy(),
        findSlotForTask(taskId) !== null,
      );
      console.log(JSON.stringify(result));
      break;
    }
    case "draft-proposal": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("draft-proposal", `"task":"${taskId}"`);
      console.log(`Queued draft-proposal request for ${taskId}`);
      break;
    }
    case "revise-proposal": {
      const taskArg = args[1];
      if (!taskArg) throw new Error("task id required (comma-separated for multiple)");
      const taskIds = taskArg.split(",");
      const feedback = args.slice(2).join(" ");
      for (const taskId of taskIds) {
        if (feedback) {
          const escaped = JSON.stringify(feedback);
          queueRequest("revise-proposal", `"task":"${taskId}","feedback":${escaped}`);
        } else {
          queueRequest("revise-proposal", `"task":"${taskId}"`);
        }
      }
      console.log(`Queued revise-proposal request for ${taskIds.join(", ")}`);
      break;
    }
    case "split-task": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("split-task", `"task":"${taskId}"`);
      console.log(`Queued split-task request for ${taskId}`);
      break;
    }
    case "verify-completion": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("verify-completion", `"task":"${taskId}"`);
      console.log(`Queued verify-completion request for ${taskId}`);
      break;
    }
    case "feedback-digest": {
      if (queueHasPendingFeedbackDigest("ludics")) {
        console.log("Skipped feedback-digest: already pending in queue");
        break;
      }

      const remainingCooldown = feedbackDigestCooldownRemaining("ludics");
      if (remainingCooldown > 0) {
        console.log(`Skipped feedback-digest: cooldown active (${remainingCooldown}s remaining)`);
        break;
      }

      queueRequest("feedback-digest", `"repo":"ludics"`);
      markFeedbackDigestQueued("ludics");
      console.log("Queued feedback-digest request");
      break;
    }
    case "adopt-sessions": {
      if (!federationIsController()) {
        console.error("ludics: mag adopt-sessions skipped — not the federation controller");
        break;
      }
      const force = args.includes("--force");
      const refresh = Bun.spawnSync(ludicsSelfCommand(["sessions", "report"]), { stdout: "pipe", stderr: "pipe" });
      if (refresh.exitCode !== 0) {
        const stderr = refresh.stderr.toString().trim();
        throw new Error(stderr ? `adopt-sessions: failed to refresh sessions: ${stderr}` : "adopt-sessions: failed to refresh sessions");
      }

      const sessionsFile = join(harnessDir(), "sessions.json");
      const fingerprint = adoptSessionsFingerprintData(sessionsFile);
      if (!fingerprint) {
        throw new Error("adopt-sessions: failed to read sessions.json after refresh");
      }

      mkdirSync(magStateDir(), { recursive: true });
      const fingerprintFile = adoptSessionsFingerprintFile();
      const previous = existsSync(fingerprintFile) ? readFileSync(fingerprintFile, "utf-8").trim() : "";
      const changed = previous !== fingerprint.hash;
      writeFileSync(fingerprintFile, fingerprint.hash + "\n");

      if (!force && !changed) {
        console.log("Skipped adopt-sessions: no unclassified session changes");
        break;
      }

      if (!force && fingerprint.unclassifiedCount === 0) {
        console.log("Skipped adopt-sessions: no unclassified sessions");
        break;
      }

      if (queueHasPendingAction("adopt-sessions")) {
        console.log("Skipped adopt-sessions request: already pending in queue");
        break;
      }

      queueRequest("adopt-sessions");
      console.log(`Queued adopt-sessions request (${fingerprint.unclassifiedCount} unclassified session(s))`);
      break;
    }
    case "process-suggestions": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("process-suggestions", `"task":"${taskId}"`);
      console.log(`Queued process-suggestions request for ${taskId}`);
      break;
    }
    case "completed": {
      const proposalName = args[1];
      if (!proposalName) throw new Error("proposal name required (without .md extension)");
      magCompleted(proposalName);
      break;
    }
    case "queue-pop": {
      // Called by the stop hook to check if there's a queued skill to run
      const cwd = args[1] ?? "";
      const hookEventName = args[2] ?? "";
      if (hookEventName && hookEventName !== "Stop") {
        // Defensive: ignore SubagentStop (and any non-Stop event) if passed by hook script.
        break;
      }
      if (cwd) {
        const harness = harnessDir();
        if (!cwd.startsWith(harness)) {
          // Not Mag session — silently exit
          break;
        }
      }
      writeStopHookTimestamp();
      clearStartupWatchdogEpoch();
      // When paused, don't pop — items accumulate and are processed on unpause
      if (existsSync(join(harnessDir(), "mag", "paused"))) break;
      // Only the federation controller pops the queue — workers must not run Mag skills
      if (!federationIsController()) break;
      const skillCommand = await queuePopSkill();
      if (skillCommand) {
        console.log(JSON.stringify({ decision: "block", reason: skillCommand }));
      }
      break;
    }
    default:
      throw new Error(`unknown mag command: ${sub} (use: start, stop, status, attach, logs, doctor, briefing, suggest, analyze, elaborate, draft-proposal, split-task, verify-completion, health-check, adopt-sessions, process-suggestions, completed, message, queue, queue-pop, context, feedback-digest)`);
  }
}
