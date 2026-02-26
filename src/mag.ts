// Mag session management — start/stop/status/attach/logs/doctor/briefing/queue

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { harnessDir, loadConfigSync, startSessionsAutonomy, slotsFilePath, slotsCount } from "./config.ts";
import { listStashes } from "./slots/preempt.ts";
import { parseSlotBlocks, getTask, getProcess } from "./slots/markdown.ts";
import { queueRequest, queuePop, queuePending, queueHasPendingFeedbackDigest } from "./queue.ts";
import { getUrl } from "./network.ts";
import { federationShouldRunMag } from "./federation.ts";
import { journalAppend } from "./journal.ts";
import { emitEvent } from "./events.ts";
import { notifyOutgoing } from "./notify.ts";
import { slotAssign, slotClear, taskCompleteDirectly } from "./slots/index.ts";
import YAML from "yaml";
import {
  tmuxAvailable,
  tmuxHasSession,
  tmuxNewSession,
  tmuxKillSession,
  tmuxSendKeys,
  tmuxSendCommand,
  tmuxCapture,
  tmuxRunShell,
} from "./adapters/tmux.ts";

const MAG_SESSION_NAME = process.env.LUDICS_MAG_SESSION ?? "ludics-mag";
const MAG_DEFAULT_PORT = process.env.LUDICS_MAG_PORT ?? "7679";
const FEEDBACK_DIGEST_COOLDOWN_SECONDS = 120;

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

function triggerSkill(session: string, cmd: string): void {
  tmuxSendKeys(session, cmd, true);
  // Small delay before Enter
  Bun.spawnSync(["sleep", "0.5"], { stdout: "pipe", stderr: "pipe" });
  tmuxSendKeys(session, "Enter");
}

const NUDGE_THROTTLE_SECONDS = 900; // 15 minutes between "Continue." nudges

function nudgeTimestampFile(): string {
  return join(magStateDir(), "last-nudge.epoch");
}

function nudgeThrottled(): boolean {
  const file = nudgeTimestampFile();
  if (!existsSync(file)) return false;
  try {
    const lastEpoch = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return (Math.floor(Date.now() / 1000) - lastEpoch) < NUDGE_THROTTLE_SECONDS;
  } catch {
    return false;
  }
}

function writeNudgeTimestamp(): void {
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(nudgeTimestampFile(), String(Math.floor(Date.now() / 1000)));
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

function queuePopSkill(): string | null {
  const queueFile = join(harnessDir(), "mag", "queue.jsonl");
  if (!existsSync(queueFile)) return null;

  const content = readFileSync(queueFile, "utf-8").trim();
  if (!content) return null;

  const lines = content.split("\n");
  const first = lines[0]!;

  let action: string;
  let requestId: string;
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(first) as Record<string, unknown>;
    action = String(request.action ?? "");
    requestId = String(request.id ?? "");
  } catch {
    console.error("ludics: mag queue-pop: invalid request in queue");
    return null;
  }

  if (!action) return null;

  // Remove from queue atomically
  writeFileSync(queueFile, lines.slice(1).join("\n") + (lines.length > 1 ? "\n" : ""));

  // Write request ID to file so skills can read it (env vars can't be set mid-session)
  if (requestId) {
    const requestIdFile = join(harnessDir(), "mag", "current-request-id");
    writeFileSync(requestIdFile, requestId);
  }

  // Map action to skill command
  switch (action) {
    case "briefing":
      briefingPrecomputeContext();
      return "/ludics-briefing";
    case "suggest":
      return "/ludics-suggest";
    case "analyze-issue": {
      const issue = String(request.issue ?? "");
      return `/ludics-analyze-issue ${issue}`;
    }
    case "elaborate": {
      const task = String(request.task ?? "");
      return `/ludics-elaborate ${task}`;
    }
    case "health-check":
      return "/ludics-health-check";
    case "learn":
      return "/ludics-learn";
    case "sync-learnings":
      return "/ludics-sync-learnings";
    case "techdebt":
      return "/ludics-techdebt";
    case "message": {
      const content = String(request.content ?? "");
      if (!content) return "/ludics-read-inbox"; // fallback for legacy queue entries

      // Intercept button-tap launch messages from ntfy notifications
      // e.g. "Launch agent-duo for task-042 in project ocannl"
      const launchMatch = content.match(/^Launch (agent-[\w-]+) for ([\w.-]+) in project .+$/);
      if (launchMatch) {
        const adapter = launchMatch[1]!;
        const taskId = launchMatch[2]!;
        return `/ludics-launch-session ${taskId} ${adapter}`;
      }

      return content; // send directly as user turn
    }
    case "feedback-digest": {
      const repo = String(request.repo ?? "");
      return `/ludics-feedback-digest ${repo}`;
    }
    case "draft-proposal": {
      const task = String(request.task ?? "");
      return `/ludics-draft-proposal ${task}`;
    }
    case "split-task": {
      const task = String(request.task ?? "");
      return `/ludics-split-task ${task}`;
    }
    case "preempt": {
      const task = String(request.task ?? "");
      const autonomy = String(request.autonomy ?? "suggest");
      return `/ludics-preempt ${task} ${autonomy}`;
    }
    default:
      console.error(`ludics: mag queue-pop: unknown action: ${action}`);
      return null;
  }
}

// --- Briefing context pre-computation ---

function briefingPrecomputeContext(): void {
  const harness = harnessDir();
  const contextFile = join(harness, "mag", "briefing-context.md");
  mkdirSync(join(harness, "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Capture slots
  let slotsOutput = "(unavailable)";
  try {
    const r = Bun.spawnSync([process.execPath, "slots"], { stdout: "pipe", stderr: "pipe" });
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
    const r = Bun.spawnSync([process.execPath, "flow", "ready"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) flowReadyOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Flow critical
  let flowCriticalOutput = "(unavailable)";
  try {
    const r = Bun.spawnSync([process.execPath, "flow", "critical"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) flowCriticalOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Tasks needing elaboration
  let needsElabOutput = "None";
  try {
    const r = Bun.spawnSync([process.execPath, "tasks", "needs-elaboration"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0 && r.stdout.toString().trim()) needsElabOutput = r.stdout.toString().trim();
  } catch { /* ignore */ }

  // Recent journal
  let journalOutput = "(no journal entries)";
  try {
    const r = Bun.spawnSync([process.execPath, "journal", "recent", "20"], { stdout: "pipe", stderr: "pipe" });
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

// --- Auto-queue proposals ---

const PROPOSAL_THROTTLE_SECONDS = 1800; // 30 minutes between proposal queuing

function proposalThrottleFile(): string {
  return join(magStateDir(), "last-proposal-queue.epoch");
}

function proposalThrottled(): boolean {
  const file = proposalThrottleFile();
  if (!existsSync(file)) return false;
  try {
    const lastEpoch = parseInt(readFileSync(file, "utf-8").trim(), 10);
    return (Math.floor(Date.now() / 1000) - lastEpoch) < PROPOSAL_THROTTLE_SECONDS;
  } catch {
    return false;
  }
}

function maybeQueueProposals(): void {
  if (startSessionsAutonomy() === "manual") return;
  if (proposalThrottled()) return;

  // Check if draft-proposal is already in queue
  const qFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(qFile)) {
    const qContent = readFileSync(qFile, "utf-8");
    if (qContent.includes('"draft-proposal"')) return;
  }

  // Read slots to find tasks that are active but missing proposals
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  const candidates: string[] = [];

  for (const [, block] of blocks) {
    if (candidates.length >= 2) break;
    const process = getProcess(block).trim();
    if (!process || process === "(empty)") continue;

    const taskId = getTask(block).trim();
    if (!taskId || taskId === "null") continue;

    // Read task file — queue draft if it has no proposal yet
    const taskFile = join(tasksDir, `${taskId}.md`);
    if (!existsSync(taskFile)) continue;
    const content = readFileSync(taskFile, "utf-8");
    if (content.includes("\nproposal:")) continue;

    candidates.push(taskId);
  }

  if (candidates.length === 0) return;

  // Write throttle timestamp
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(proposalThrottleFile(), String(Math.floor(Date.now() / 1000)));

  for (const taskId of candidates) {
    queueRequest("draft-proposal", `"task":"${taskId}"`);
    console.error(`ludics: auto-queued draft-proposal for ${taskId}`);
  }
}

// --- Auto-fill empty slots ---

function maybeFillEmptySlots(): void {
  if (startSessionsAutonomy() === "manual") return;
  if (proposalThrottled()) return;

  // Check if draft-proposal is already in queue
  const qFile = join(harnessDir(), "mag", "queue.jsonl");
  if (existsSync(qFile)) {
    const qContent = readFileSync(qFile, "utf-8");
    if (qContent.includes('"draft-proposal"')) return;
  }

  // Find empty slots
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return;

  const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
  const count = slotsCount();
  const emptySlots: number[] = [];
  const tasksInSlots = new Set<string>();

  for (let i = 1; i <= count; i++) {
    const block = blocks.get(i);
    const process = block ? getProcess(block).trim() : "(empty)";
    if (!process || process === "(empty)") {
      emptySlots.push(i);
    } else {
      const taskId = block ? getTask(block).trim() : "";
      if (taskId && taskId !== "null") tasksInSlots.add(taskId);
    }
  }

  if (emptySlots.length === 0) return;

  // Find ready, elaborated tasks not already in a slot
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return;

  const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));

  interface Candidate { id: string; priority: string; project: string; hasDeadline: boolean; deadline: string }
  const candidates: Candidate[] = [];

  for (const f of files) {
    const content = readFileSync(join(tasksDir, f), "utf-8");
    const idMatch = content.match(/^id:\s*(.+)$/m);
    if (!idMatch) continue;
    const id = idMatch[1]!.trim();

    if (tasksInSlots.has(id)) continue;

    const statusMatch = content.match(/^status:\s*(.+)$/m);
    if (!statusMatch || statusMatch[1]!.trim() !== "ready") continue;

    // Must be elaborated (has elaborated: field and no TBD placeholders)
    if (!content.includes("\nelaborated:")) continue;
    if (content.includes("- [ ] TBD\n")) continue;

    // Must not have blocked_by dependencies
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      try {
        const fm = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
        const deps = fm.dependencies as Record<string, unknown> | undefined;
        const blockedBy = deps?.blocked_by;
        if (Array.isArray(blockedBy) && blockedBy.length > 0) continue;
      } catch { /* skip parse errors */ }
    }

    const priorityMatch = content.match(/^priority:\s*(.+)$/m);
    const priority = priorityMatch ? priorityMatch[1]!.trim() : "B";

    const projectMatch = content.match(/^project:\s*(.+)$/m);
    const project = projectMatch ? projectMatch[1]!.trim() : "";

    const deadlineMatch = content.match(/^deadline:\s*(.+)$/m);
    const deadline = deadlineMatch ? deadlineMatch[1]!.trim() : "";

    candidates.push({ id, priority, project, hasDeadline: !!deadline && deadline !== "null", deadline });
  }

  if (candidates.length === 0) return;

  // Sort by priority (A > B > C), then deadline presence, then deadline date
  candidates.sort((a, b) => {
    const pv = (p: string) => p === "A" ? 1 : p === "B" ? 2 : p === "C" ? 3 : 9;
    const pd = pv(a.priority) - pv(b.priority);
    if (pd !== 0) return pd;
    if (a.hasDeadline !== b.hasDeadline) return a.hasDeadline ? -1 : 1;
    return (a.deadline || "9999").localeCompare(b.deadline || "9999");
  });

  // Fill at most 1 empty slot per keepalive cycle (conservative)
  const task = candidates[0]!;
  const slot = emptySlots[0]!;

  // Assign task to the empty slot with manual adapter (draft-proposal notification
  // lets the user pick the actual adapter via action buttons)
  slotAssign(slot, task.id, "manual");
  emitEvent({ event_type: "slot_auto_fill", source: "keepalive", scope: "slot", slot, task: task.id, adapter: "manual", message: `auto-assigned ${task.id} to empty slot ${slot}` });
  console.error(`ludics: auto-assigned ${task.id} to empty slot ${slot}`);

  // Write throttle timestamp (shared with maybeQueueProposals)
  mkdirSync(magStateDir(), { recursive: true });
  writeFileSync(proposalThrottleFile(), String(Math.floor(Date.now() / 1000)));

  // Queue draft-proposal so Mag writes a proposal and notifies the user
  queueRequest("draft-proposal", `"task":"${task.id}"`);
  emitEvent({ event_type: "mag_auto_proposal", source: "keepalive", scope: "mag", task: task.id, message: `auto-queued draft-proposal for ${task.id}` });
  console.error(`ludics: auto-queued draft-proposal for ${task.id}`);
}

// --- Mag CLI commands ---

export function magStart(args: string[]): void {
  let useTtyd = true;
  let skipFederation = false;

  for (const arg of args) {
    if (arg === "--no-ttyd") useTtyd = false;
    if (arg === "--skip-federation") skipFederation = true;
  }

  if (!tmuxAvailable()) throw new Error("mag start: tmux is required but not installed");

  // Check federation
  if (!skipFederation) {
    if (!federationShouldRunMag()) {
      console.error("ludics: Mag blocked: not the federation leader");
      console.log("To override, use: ludics mag start --skip-federation");
      return;
    }
  }

  // Session already exists - keepalive path
  if (magIsRunning()) {
    if (useTtyd) ensureTtyd();

    // Publish terminal state to ntfy (dedup'd)
    publishTerminalState();

    // Auto-queue proposals for elaborated leaf tasks already in slots
    maybeQueueProposals();

    // Auto-fill empty slots with ready elaborated tasks
    maybeFillEmptySlots();

    // Nudge if queue has items, but throttle to avoid spamming
    if (queuePending() && !nudgeThrottled()) {
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      triggerSkill(MAG_SESSION_NAME, `Continue. (ludics automatic message, current time: ${now})`);
      writeNudgeTimestamp();
      emitEvent({ event_type: "mag_nudge", source: "keepalive", scope: "mag", message: "nudged Mag with Continue" });
    }
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

  magSignal("running", "session started");
  emitEvent({ event_type: "mag_start", source: "cli", scope: "mag", message: `Mag session ${MAG_SESSION_NAME} started` });

  // Export environment variables for skills
  const statePath = harnessDir();
  const resultsPath = join(statePath, "mag", "results");
  mkdirSync(resultsPath, { recursive: true });
  tmuxSendCommand(MAG_SESSION_NAME, `export LUDICS_STATE_PATH="${statePath}" LUDICS_RESULTS_DIR="${resultsPath}"`);
  Bun.spawnSync(["sleep", "0.5"], { stdout: "pipe", stderr: "pipe" });

  // Start Claude Code
  const hasClaude = Bun.spawnSync(["which", "claude"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (hasClaude) {
    tmuxSendCommand(MAG_SESSION_NAME, "claude -c --dangerously-skip-permissions || claude --dangerously-skip-permissions");
    console.error("ludics: Started Claude Code in Mag session");
  } else {
    console.error("ludics: claude CLI not found; session started without Claude Code");
  }

  console.log(`Mag session started. Attach with: tmux attach -t ${MAG_SESSION_NAME}`);

  if (useTtyd) ensureTtyd();

  // Drain queue
  const skillCmd = queuePopSkill();
  if (skillCmd) {
    Bun.spawnSync(["sleep", "5"], { stdout: "pipe", stderr: "pipe" });
    console.error(`ludics: Mag fresh start, sending queued request: ${skillCmd}`);
    triggerSkill(MAG_SESSION_NAME, skillCmd);
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
  const requestId = queueRequest("briefing");
  console.log(`Queued briefing request: ${requestId}`);

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

function magContext(): void {
  briefingPrecomputeContext();
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
      magStart(args.slice(1));
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
    case "analyze": {
      const issue = args[1];
      if (!issue) throw new Error("issue required (e.g., owner/repo#123)");
      queueRequest("analyze-issue", `"issue":"${issue}"`);
      console.log(`Queued analyze request for ${issue}`);
      break;
    }
    case "elaborate": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("elaborate", `"task":"${taskId}"`);
      console.log(`Queued elaborate request for ${taskId}`);
      break;
    }
    case "health-check":
      queueRequest("health-check");
      console.log("Queued health-check request");
      break;
    case "message": {
      const text = args.slice(1).join(" ");
      if (!text) throw new Error("message text required");
      magMessage(text);
      break;
    }
    case "inbox":
      magInbox(args.includes("--consume"));
      break;
    case "queue":
      // Reuse the existing queueShow
      const { queueShow } = await import("./queue.ts");
      queueShow();
      break;
    case "context":
      magContext();
      break;
    case "draft-proposal": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("draft-proposal", `"task":"${taskId}"`);
      console.log(`Queued draft-proposal request for ${taskId}`);
      break;
    }
    case "split-task": {
      const taskId = args[1];
      if (!taskId) throw new Error("task id required");
      queueRequest("split-task", `"task":"${taskId}"`);
      console.log(`Queued split-task request for ${taskId}`);
      break;
    }
    case "feedback-digest": {
      const repo = args[1];
      if (!repo) throw new Error("repo required (e.g., owner/repo)");

      if (queueHasPendingFeedbackDigest(repo)) {
        console.log(`Skipped feedback-digest request for ${repo}: already pending in queue`);
        break;
      }

      const remainingCooldown = feedbackDigestCooldownRemaining(repo);
      if (remainingCooldown > 0) {
        console.log(
          `Skipped feedback-digest request for ${repo}: cooldown active (${remainingCooldown}s remaining)`
        );
        break;
      }

      queueRequest("feedback-digest", `"repo":"${repo}"`);
      markFeedbackDigestQueued(repo);
      console.log(`Queued feedback-digest request for ${repo}`);
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
      if (cwd) {
        const harness = harnessDir();
        if (!cwd.startsWith(harness)) {
          // Not Mag session — silently exit
          break;
        }
      }
      const skillCommand = queuePopSkill();
      if (skillCommand) {
        console.log(JSON.stringify({ decision: "block", reason: skillCommand }));
      }
      break;
    }
    default:
      throw new Error(`unknown mag command: ${sub} (use: start, stop, status, attach, logs, doctor, briefing, suggest, analyze, elaborate, draft-proposal, split-task, health-check, completed, message, inbox, queue, queue-pop, context, feedback-digest)`);
  }
}
