// Notification system — ntfy.sh integration (outgoing + incoming + agents)

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from "fs";
import { basename, join, resolve } from "path";
import { loadConfigSync, harnessDir, slotsFilePath } from "./config.ts";
import { safeSyncOutput } from "./spawn.ts";
import { queueRequest } from "./queue.ts";
import { emitEvent } from "./events.ts";
import { parseSlotBlocks, getTask, getPath } from "./slots/markdown.ts";
import { getUrl } from "./network.ts";

function notificationLogFile(): string {
  return join(harnessDir(), "journal", "notifications.jsonl");
}

function notifyLog(tier: string, message: string, priority: number, title: string): void {
  const logFile = notificationLogFile();
  mkdirSync(join(harnessDir(), "journal"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedMsg = message.replace(/"/g, '\\"');
  const line = `{"timestamp":"${timestamp}","tier":"${tier}","priority":${priority},"title":"${escapedTitle}","message":"${escapedMsg}"}`;
  appendFileSync(logFile, line + "\n");
}

function getToken(): string {
  const config = loadConfigSync();
  return config.notifications?.token ?? "";
}

function notifySend(topic: string, message: string, priority: number, title: string, tags: string): void {
  if (!topic) throw new Error("notify: topic required");
  if (!message) throw new Error("notify: message required");

  const curlArgs = [
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "--max-time", "5",
    "-d", message,
  ];
  if (title) curlArgs.push("-H", `Title: ${title}`);
  curlArgs.push("-H", `Priority: ${priority}`);
  if (tags) curlArgs.push("-H", `Tags: ${tags}`);
  const token = getToken();
  if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`);
  curlArgs.push(`https://ntfy.sh/${topic}`);

  const result = safeSyncOutput(curlArgs);
  const httpCode = result.stdout;
  if (httpCode !== "200") {
    console.error(`ludics: ntfy.sh notification failed (HTTP ${httpCode}), logged locally`);
  }
}

function getTopic(tier: string): string {
  const config = loadConfigSync();
  const topics = config.notifications?.topics;
  if (!topics) return "";
  // Support "outgoing" with fallback to legacy "pai" key
  if (tier === "outgoing") {
    return topics["outgoing"] ?? topics["pai"] ?? "";
  }
  return topics[tier] ?? "";
}

const NTFY_MAX_ACTIONS = 3;
const PROPOSAL_INLINE_CHAR_CUTOFF = 800;
interface SessionConclusionNotificationInput {
  taskId: string;
  adapter: string;
  slotNum: number | null;
  sessionToken: string;
  phaseToken: string;
  prLinks: string[];
  kind: "in-progress" | "concluded";
  refactorSummary?: string;
}

interface PendingFollowupRevise {
  taskId: string;
  adapter: string;
}

interface IncomingMessageEvent {
  id: string;
  message: string;
  title?: string;
}

type NtfyAction = Record<string, unknown>;

export function chunkNotificationActions<T>(actions: T[], maxActions: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < actions.length; i += maxActions) {
    chunks.push(actions.slice(i, i + maxActions));
  }
  return chunks;
}

export function buildProposalNotificationActions(
  taskId: string,
  project: string,
  inTopic: string,
  headers: Record<string, string>,
): NtfyAction[] {
  const action = (label: string, body: string): NtfyAction => ({
    action: "http",
    label,
    url: `https://ntfy.sh/${inTopic}`,
    method: "POST",
    headers,
    body,
  });

  return [
    action("approve", `Approve task ${taskId}`),
    action("revise", `Revise proposal for ${taskId}`),
    action("abandon", `Abandon task ${taskId}`),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseIncomingMessageEvent(raw: string): IncomingMessageEvent | null {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return null;
  const event = getString(parsed.event);
  const message = getString(parsed.message);
  if (event !== "message" || !message) return null;
  return {
    id: getString(parsed.id) ?? "",
    message,
    title: getString(parsed.title),
  };
}

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function taskProject(taskId: string): string {
  try {
    const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
    if (!existsSync(taskFile)) return "";
    const content = readFileSync(taskFile, "utf-8");
    const match = content.match(/^project:\s*(.+)$/m);
    return match ? match[1]!.trim() : "";
  } catch {
    return "";
  }
}

function candidateProjectDirs(project: string): string[] {
  const dirs = new Set<string>();
  const projectName = project.trim();
  if (projectName) {
    dirs.add(projectName);
    dirs.add(projectName.toLowerCase());
  }

  try {
    const config = loadConfigSync();
    for (const p of (config.projects ?? [])) {
      const name = String(p.name ?? "");
      const repoTail = String(p.repo ?? "").split("/").pop() ?? "";
      if (!repoTail) continue;
      if (
        projectName &&
        projectName.toLowerCase() !== name.toLowerCase() &&
        projectName.toLowerCase() !== repoTail.toLowerCase()
      ) {
        continue;
      }
      dirs.add(repoTail);
    }
  } catch {
    // ignore config lookup failures; we still try direct fallbacks
  }

  return Array.from(dirs);
}

function taskSlotPath(taskId: string): string {
  try {
    const sFile = slotsFilePath();
    if (!existsSync(sFile)) return "";
    const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
    for (const [, block] of blocks) {
      if (getTask(block).trim() !== taskId) continue;
      const path = getPath(block).trim();
      if (path && path !== "null") return path;
    }
  } catch {
    // ignore slot lookup failures
  }
  return "";
}

function taskSlotNumber(taskId: string): number | null {
  try {
    const sFile = slotsFilePath();
    if (!existsSync(sFile)) return null;
    const blocks = parseSlotBlocks(readFileSync(sFile, "utf-8"));
    for (const [slotNum, block] of blocks) {
      if (getTask(block).trim() === taskId) return slotNum;
    }
  } catch {
    // ignore slot lookup failures
  }
  return null;
}

function proposalSearchRoots(taskId: string): string[] {
  const roots = new Set<string>();
  const slotPath = taskSlotPath(taskId);
  if (slotPath) roots.add(slotPath);
  roots.add(process.cwd());

  const project = taskProject(taskId);
  for (const dir of candidateProjectDirs(project)) {
    roots.add(resolve(process.env.HOME ?? "~", dir));
  }
  roots.add(process.env.HOME ?? "~");

  return Array.from(roots);
}

function resolveProposalFilePath(taskId: string, filePath: string): string | null {
  const rawPath = filePath.trim();
  if (!rawPath) return null;

  const expanded = rawPath.startsWith("~/") ? resolve(process.env.HOME ?? "~", rawPath.slice(2)) : rawPath;
  if (isRegularFile(expanded)) return expanded;

  const candidates = new Set<string>();
  if (rawPath.startsWith("~/")) {
    candidates.add(resolve(process.env.HOME ?? "~", rawPath.slice(2)));
  } else if (rawPath.startsWith("/")) {
    candidates.add(resolve(rawPath));
  } else {
    for (const root of proposalSearchRoots(taskId)) {
      candidates.add(resolve(root, rawPath));
      candidates.add(resolve(root, expanded));
    }
  }

  for (const candidate of candidates) {
    if (isRegularFile(candidate)) return candidate;
  }

  return null;
}

function proposalInlineMessage(summary: string, proposalText: string, attachmentName: string): string {
  const trimmedSummary = summary.trim();
  const trimmedProposal = proposalText.trim();

  if (trimmedProposal && trimmedProposal.length <= PROPOSAL_INLINE_CHAR_CUTOFF) {
    if (trimmedSummary && trimmedProposal !== trimmedSummary) {
      return `Summary: ${trimmedSummary}\n\n${trimmedProposal}`;
    }
    return trimmedProposal;
  }
  if (trimmedSummary) return `Summary: ${trimmedSummary}\n\nFull proposal attached as ${attachmentName}.`;
  return `Full proposal attached as ${attachmentName}.`;
}

function notifyPublishMessage(
  topic: string,
  message: string,
  token: string,
  title: string,
  priority: number,
  tags: string,
  actions: Array<Record<string, unknown>>,
) : { httpCode: string; stderr: string; body: string } {
  const curlArgs = [
    "curl", "-sS", "-w", "\n%{http_code}",
    "-X", "POST",
    "-d", message,
  ];
  if (title) curlArgs.push("-H", `Title: ${title}`);
  curlArgs.push("-H", `Priority: ${priority}`);
  if (tags) curlArgs.push("-H", `Tags: ${tags}`);
  if (actions.length > 0) curlArgs.push("-H", `Actions: ${JSON.stringify(actions)}`);
  if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`);
  curlArgs.push(`https://ntfy.sh/${topic}`);

  const result = safeSyncOutput(curlArgs, { trim: false });
  const stdout = result.stdout;
  const splitAt = stdout.lastIndexOf("\n");
  const body = splitAt >= 0 ? stdout.slice(0, splitAt).trim() : "";
  const httpCode = splitAt >= 0 ? stdout.slice(splitAt + 1).trim() : stdout.trim();
  return {
    httpCode,
    stderr: result.stderr.trim(),
    body,
  };
}

function notifyPublishFile(
  topic: string,
  filePath: string,
  filename: string,
  token: string,
  title: string,
  message: string,
  priority: number,
  tags: string,
  actions: Array<Record<string, unknown>>,
) : { httpCode: string; stderr: string; body: string } {
  const curlArgs = [
    "curl", "-sS", "-w", "\n%{http_code}",
    "-X", "PUT",
    "-T", filePath,
  ];
  if (title) curlArgs.push("-H", `Title: ${title}`);
  if (message) curlArgs.push("-H", `Message: ${message}`);
  curlArgs.push("-H", `Priority: ${priority}`);
  if (tags) curlArgs.push("-H", `Tags: ${tags}`);
  if (filename) curlArgs.push("-H", `Filename: ${filename}`);
  if (actions.length > 0) curlArgs.push("-H", `Actions: ${JSON.stringify(actions)}`);
  if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`);
  curlArgs.push(`https://ntfy.sh/${topic}`);

  const result = safeSyncOutput(curlArgs, { trim: false });
  const stdout = result.stdout;
  const splitAt = stdout.lastIndexOf("\n");
  const body = splitAt >= 0 ? stdout.slice(0, splitAt).trim() : "";
  const httpCode = splitAt >= 0 ? stdout.slice(splitAt + 1).trim() : stdout.trim();
  return {
    httpCode,
    stderr: result.stderr.trim(),
    body,
  };
}

function sessionConclusionStateFile(): string {
  // Keep legacy file name for backward compatibility.
  return join(harnessDir(), "mag", "followup-notified.json");
}

function loadSessionConclusionState(): Record<string, string> {
  const file = sessionConclusionStateFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSessionConclusionState(state: Record<string, string>): void {
  const file = sessionConclusionStateFile();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

function sessionConclusionKey(input: SessionConclusionNotificationInput): string {
  // Preserve old keys to avoid duplicate notifications after terminology renames.
  const kindKey = input.kind === "in-progress"
    ? "ready"
    : "completed";
  return `${input.taskId}|${input.adapter}|${kindKey}|${input.sessionToken}|${input.phaseToken}`;
}

export function notifySessionConclusion(input: SessionConclusionNotificationInput): void {
  const outTopic = getTopic("outgoing");
  const inTopic = getTopic("incoming");
  if (!outTopic) {
    console.error("ludics: outgoing topic not configured, logging locally only");
    return;
  }
  const key = sessionConclusionKey(input);
  const state = loadSessionConclusionState();
  if (state[key]) return;

  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const titleBase = input.kind === "concluded"
    ? "Session concluded"
    : "Session in progress";
  const title = input.slotNum !== null
    ? `${titleBase} [slot ${input.slotNum}]: ${input.taskId}`
    : `${titleBase}: ${input.taskId}`;

  const lines: string[] = [
    input.kind === "concluded"
      ? `Session concluded for ${input.taskId}.`
      : `Session in progress for ${input.taskId}.`,
  ];
  if (input.prLinks.length === 1) {
    lines.push(`PR: ${input.prLinks[0]!}`);
  } else if (input.prLinks.length > 1) {
    lines.push("PRs:");
    for (const link of input.prLinks) lines.push(`- ${link}`);
  }
  if (input.refactorSummary) {
    lines.push("");
    lines.push(`Refactor note: ${input.refactorSummary}`);
  }
  const message = lines.join("\n");

  const actions: Array<Record<string, unknown>> = inTopic ? [
    {
      action: "http",
      label: "followup",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Followup task ${input.taskId}`,
    },
    {
      action: "http",
      label: "done",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Done task ${input.taskId}`,
    },
  ] : [];

  const result = notifyPublishMessage(
    outTopic,
    message,
    token,
    title,
    3,
    `memo,${input.taskId}`,
    actions,
  );

  if (result.httpCode !== "200") {
    const detail = result.body || result.stderr;
    console.error(`ludics: ntfy.sh session conclusion notification failed (HTTP ${result.httpCode})${detail ? `: ${detail}` : ""}, logged locally`);
    return;
  }

  state[key] = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  saveSessionConclusionState(state);
  notifyLog("outgoing", message.replace(/\n/g, " "), 3, "session conclusion");
}

export function notifyOutgoing(message: string, priority: number = 3, title: string = "ludics"): void {
  const topic = getTopic("outgoing");
  notifyLog("outgoing", message, priority, title);

  if (!topic) {
    console.error("ludics: outgoing topic not configured, logging locally only");
    return;
  }
  notifySend(topic, message, priority, title, "robot_face");
}

export function notifyAgents(message: string, priority: number = 3, title: string = "agent update"): void {
  const topic = getTopic("agents");
  notifyLog("agents", message, priority, title);

  if (!topic) {
    console.error("ludics: agents topic not configured, logging locally only");
    return;
  }
  notifySend(topic, message, priority, title, "gear");
}

export function notifyProposal(
  taskId: string,
  title: string,
  summary: string,
  filePath: string,
): void {
  const outTopic = getTopic("outgoing");
  const inTopic = getTopic("incoming");
  const slotNum = taskSlotNumber(taskId);
  const slotSuffix = slotNum !== null ? ` (slot ${slotNum})` : "";
  const proposalTitle = slotNum !== null ? `Proposal [slot ${slotNum}]: ${title}` : `Proposal: ${title}`;
  const optionsTitle = slotNum !== null ? `Proposal options [slot ${slotNum}]: ${title}` : `Proposal options: ${title}`;
  notifyLog("outgoing", `Proposal for ${taskId}${slotSuffix}: ${title}`, 3, "proposal");

  if (!outTopic) {
    console.error("ludics: outgoing topic not configured, logging locally only");
    return;
  }

  const token = getToken();
  const project = taskId.split("-").slice(0, -1).join("-") || "unknown";

  // Compute dashboard view URL for the proposal
  const config = loadConfigSync();
  const dashboardPort = config.dashboard?.port ?? 7678;
  const dashboardBaseUrl = getUrl(dashboardPort);
  const proposalViewUrl = `${dashboardBaseUrl}/proposal.html?task=${encodeURIComponent(taskId)}`;

  const resolvedPath = resolveProposalFilePath(taskId, filePath);
  if (!resolvedPath) {
    console.error(`ludics: proposal file not found for attachment (${filePath}); sending notification without attachment`);
  }
  const attachmentName = resolvedPath ? basename(resolvedPath) : `${taskId}-proposal.md`;
  let proposalText = "";
  if (resolvedPath) {
    try {
      proposalText = readFileSync(resolvedPath, "utf-8");
    } catch {
      proposalText = "";
    }
  }
  const tagsHeader = `memo,${taskId}`;

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Build "view" action as first action (opens proposal in browser)
  const viewAction: NtfyAction = {
    action: "view",
    label: "view",
    url: proposalViewUrl,
  };

  const launchActions = inTopic
    ? buildProposalNotificationActions(taskId, project, inTopic, headers)
    : [];
  const allActions = [viewAction, ...launchActions];
  const actionBatches = chunkNotificationActions(allActions, NTFY_MAX_ACTIONS);
  const firstActionBatch = actionBatches[0] ?? [];

  // When we have a dashboard view URL, use a simpler message body
  const simpleMessage = summary.trim()
    ? `Proposal for ${taskId}${slotSuffix}: ${summary.trim()}`
    : `Proposal for ${taskId}${slotSuffix}`;

  // Use dashboard view URL message when available; file attachment is a fallback
  let first: { httpCode: string; stderr: string; body: string };
  first = notifyPublishMessage(
    outTopic,
    simpleMessage,
    token,
    proposalTitle,
    3,
    tagsHeader,
    firstActionBatch,
  );

  if (first.httpCode !== "200" && resolvedPath) {
    // Fallback: attach the file
    const detail = first.body || first.stderr;
    console.error(`ludics: ntfy.sh proposal notification failed (HTTP ${first.httpCode})${detail ? `: ${detail}` : ""}, retrying with file attachment`);
    const fallbackMessage = proposalInlineMessage(summary, proposalText, attachmentName).replace(/\r?\n/g, " ").trim();
    first = notifyPublishFile(
      outTopic,
      resolvedPath,
      attachmentName,
      token,
      proposalTitle,
      fallbackMessage,
      3,
      tagsHeader,
      firstActionBatch,
    );
  }

  if (first.httpCode !== "200") {
    const detail = first.body || first.stderr;
    console.error(`ludics: ntfy.sh proposal notification failed (HTTP ${first.httpCode})${detail ? `: ${detail}` : ""}, logged locally`);
    return;
  }

  if (!inTopic) return;

  for (const batch of actionBatches.slice(1)) {
    const followup = notifyPublishMessage(
      outTopic,
      `More launch options for ${taskId}${slotSuffix}.`,
      token,
      optionsTitle,
      3,
      tagsHeader,
      batch,
    );
    if (followup.httpCode !== "200") {
      const detail = followup.body || followup.stderr;
      console.error(`ludics: ntfy.sh proposal options notification failed (HTTP ${followup.httpCode})${detail ? `: ${detail}` : ""}, logged locally`);
    }
  }
}

export function notifyRecent(count: number = 10): void {
  const logFile = notificationLogFile();
  if (!existsSync(logFile)) {
    console.log("No notifications yet");
    return;
  }

  const lines = readFileSync(logFile, "utf-8").trim().split("\n");
  const recent = lines.slice(-count);
  for (const line of recent) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        console.log(line);
        continue;
      }
      const timestamp = getString(parsed.timestamp) ?? "";
      const tier = getString(parsed.tier) ?? "";
      const title = getString(parsed.title) ?? "";
      const message = getString(parsed.message) ?? "";
      console.log(`${timestamp} [${tier}] ${title}: ${message}`);
    } catch {
      console.log(line);
    }
  }
}

// --- Incoming subscriber ---

function subscriberStateFile(): string {
  return join(harnessDir(), "mag", "ntfy-subscriber.state");
}

function loadSubscriberState(): { last_id?: string; last_time?: string } {
  const file = subscriberStateFile();
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!isRecord(parsed)) return {};
    const out: { last_id?: string; last_time?: string } = {};
    const lastId = getString(parsed.last_id);
    const lastTime = getString(parsed.last_time);
    if (lastId) out.last_id = lastId;
    if (lastTime) out.last_time = lastTime;
    return out;
  } catch {
    return {};
  }
}

function saveSubscriberState(lastId: string): void {
  const file = subscriberStateFile();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  const state = { last_id: lastId, last_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  writeFileSync(file, JSON.stringify(state) + "\n");
}

// --- Pending-revise mode ---
// When user taps "revise" on a proposal notification, we write a flag file.
// The next incoming message gets bundled as feedback for that revision.

function pendingReviseFile(taskId: string): string {
  return join(harnessDir(), "mag", `pending-revise-${taskId}`);
}

function pendingFollowupReviseFile(taskId: string, adapter: string): string {
  return join(harnessDir(), "mag", `pending-followup-revise-${taskId}-${adapter}`);
}

function setPendingRevise(taskId: string): void {
  const file = pendingReviseFile(taskId);
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  writeFileSync(file, String(Math.floor(Date.now() / 1000)));
  console.log(`ludics: armed revise mode for ${taskId} — waiting for feedback message`);
}

function setPendingFollowupRevise(taskId: string, adapter: string): void {
  const file = pendingFollowupReviseFile(taskId, adapter);
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  const payload = {
    task: taskId,
    adapter,
    created: Math.floor(Date.now() / 1000),
  };
  writeFileSync(file, JSON.stringify(payload) + "\n");
  console.log(`ludics: armed followup revise mode for ${taskId} (${adapter}) — waiting for feedback message`);
}

/** Consume all pending-revise flags. Returns array of task IDs (may be empty). */
function consumeAllPendingRevises(): string[] {
  const magDir = join(harnessDir(), "mag");
  if (!existsSync(magDir)) return [];
  const taskIds: string[] = [];
  const files = readdirSync(magDir);
  for (const f of files) {
    if (f.startsWith("pending-revise-")) {
      const taskId = f.replace("pending-revise-", "");
      unlinkSync(join(magDir, f));
      taskIds.push(taskId);
    }
  }
  return taskIds;
}

/** Consume all pending followup-revise flags. */
function consumeAllPendingFollowupRevises(): PendingFollowupRevise[] {
  const magDir = join(harnessDir(), "mag");
  if (!existsSync(magDir)) return [];
  const pending: PendingFollowupRevise[] = [];
  const files = readdirSync(magDir);
  for (const f of files) {
    if (!f.startsWith("pending-followup-revise-")) continue;
    const filePath = join(magDir, f);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      const taskId = String(data.task ?? "").trim();
      const adapter = String(data.adapter ?? "").trim();
      if (taskId && adapter) pending.push({ taskId, adapter });
    } catch {
      // Skip malformed payloads.
    }
    unlinkSync(filePath);
  }
  return pending;
}

/** Expire pending-revise flags older than timeoutSec. Queue revision without feedback. */
export function expirePendingRevises(timeoutSec: number = 900): void {
  const magDir = join(harnessDir(), "mag");
  if (!existsSync(magDir)) return;
  const now = Math.floor(Date.now() / 1000);
  const files = readdirSync(magDir);
  for (const f of files) {
    if (!f.startsWith("pending-revise-")) continue;
    const taskId = f.replace("pending-revise-", "");
    try {
      const ts = parseInt(readFileSync(join(magDir, f), "utf-8").trim(), 10);
      if (now - ts > timeoutSec) {
        unlinkSync(join(magDir, f));
        queueRequest({ action: "revise-proposal", task: taskId });
        console.log(`ludics: pending revise for ${taskId} timed out, queued without feedback`);
      }
    } catch {
      unlinkSync(join(magDir, f));
    }
  }
}

/** Expire pending followup-revise flags older than timeoutSec. Queue followup without feedback. */
export function expirePendingFollowupRevises(timeoutSec: number = 900): void {
  const magDir = join(harnessDir(), "mag");
  if (!existsSync(magDir)) return;
  const now = Math.floor(Date.now() / 1000);
  const files = readdirSync(magDir);
  for (const f of files) {
    if (!f.startsWith("pending-followup-revise-")) continue;
    const filePath = join(magDir, f);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      const taskId = String(data.task ?? "").trim();
      const adapter = String(data.adapter ?? "").trim();
      const created = Number(data.created ?? 0);
      if (!taskId || !adapter || !Number.isFinite(created)) {
        unlinkSync(filePath);
        continue;
      }
      if (now - created > timeoutSec) {
        unlinkSync(filePath);
        queueRequest({ action: "adapter-followup", task: taskId, adapter });
        console.log(`ludics: pending followup revise for ${taskId} (${adapter}) timed out, queued without feedback`);
      }
    } catch {
      unlinkSync(filePath);
    }
  }
}

export async function subscribeIncoming(): Promise<void> {
  const topic = getTopic("incoming");
  if (!topic) {
    console.error("ludics: incoming topic not configured (set notifications.topics.incoming in config)");
    process.exit(1);
  }

  console.log(`ludics: subscribing to incoming messages on topic "${topic}"`);

  let backoff = 1000; // start at 1s
  const MAX_BACKOFF = 60000; // cap at 60s

  while (true) {
    try {
      const state = loadSubscriberState();
      let url = `https://ntfy.sh/${topic}/sse`;
      if (state.last_id) {
        url += `?since=${state.last_id}`;
      }

      console.log(`ludics: connecting to ${url}`);
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error("No response body");
      }

      // Reset backoff on successful connection
      backoff = 1000;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const incoming = parseIncomingMessageEvent(line.slice(6));
            if (incoming) {
              console.log(`ludics: received message [${incoming.id}]: ${incoming.message.slice(0, 80)}`);

              const msg = incoming.message;

              // Button taps and pending feedback capture modes
              // New simplified formats (match first)
              const launchNewMatch = msg.match(/^Launch task ([\w.-]+)$/);
              const followupNewMatch = msg.match(/^Followup task ([\w.-]+)$/);
              // Backward compat: old ntfy buttons may still post these formats.
              // New notifications emit simplified "Launch task <id>" / "Followup task <id>" only.
              const reviseProposalMatch = msg.match(/^Revise proposal for ([\w.-]+)$/);
              const followupLegacyMatch = msg.match(/^Followup ([\w-]+) for ([\w.-]+)$/);
              const followupReviseMatch = msg.match(/^Revise followup ([\w-]+) for ([\w.-]+)$/);
              const doneMatch = msg.match(/^Done task ([\w.-]+)$/);
              const launchLegacyMatch = msg.match(/^Launch ([\w-]+) for ([\w.-]+) in project (.+)$/);
              const abandonMatch = msg.match(/^Abandon task ([\w.-]+)$/);

              if (reviseProposalMatch) {
                setPendingRevise(reviseProposalMatch[1]!);
              } else if (followupReviseMatch) {
                // Legacy followup-revise — kept for backward compat
                const adapter = followupReviseMatch[1]!;
                const taskId = followupReviseMatch[2]!;
                setPendingFollowupRevise(taskId, adapter);
              } else if (followupNewMatch) {
                // New format — route as t3code followup
                queueRequest({ action: "adapter-followup", task: followupNewMatch[1]!, adapter: "t3code", followup_msg: "" });
              } else if (followupLegacyMatch) {
                // Legacy format
                const adapter = followupLegacyMatch[1]!;
                const taskId = followupLegacyMatch[2]!;
                queueRequest({ action: "adapter-followup", task: taskId, adapter, followup_msg: "" });
              } else if (doneMatch) {
                queueRequest({ action: "complete-task", task: doneMatch[1]! });
              } else if (launchNewMatch || launchLegacyMatch) {
                // Both new and legacy launch — route to mag queue as message
                queueRequest({ action: "message", content: msg });
              } else if (abandonMatch) {
                // Route Abandon messages directly — bypass pending-revise consumption
                queueRequest({ action: "message", content: msg });
              } else {
                const pendingTaskIds = consumeAllPendingRevises();
                const pendingFollowups = consumeAllPendingFollowupRevises();

                if (pendingTaskIds.length > 0 || pendingFollowups.length > 0) {
                  for (const taskId of pendingTaskIds) {
                    queueRequest({ action: "revise-proposal", task: taskId, feedback: msg });
                  }
                  for (const pending of pendingFollowups) {
                    queueRequest({ action: "adapter-followup", task: pending.taskId, adapter: pending.adapter, followup_msg: msg });
                  }
                } else {
                  // Normal message — direct queue injection
                  queueRequest({ action: "message", content: msg });
                }
              }

              // Log to journal
              notifyLog("incoming", msg, 3, incoming.title ?? "ntfy incoming");
              emitEvent({ event_type: "notify_incoming", source: "notify", scope: "notify", message: msg.slice(0, 200) });

              // Persist state
              saveSubscriberState(incoming.id);
            }
          } catch {
            // Ignore unparseable data lines (e.g. open events)
          }
        }
      }

      // Stream ended normally — reconnect
      console.log("ludics: SSE stream ended, reconnecting...");
    } catch (err) {
      console.error(`ludics: subscriber error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`ludics: retrying in ${backoff / 1000}s...`);
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }
}

export async function runNotify(args: string[]): Promise<void> {
  const tier = args[0] ?? "";

  switch (tier) {
    case "outgoing":
    case "pai":
      if (!args[1]) throw new Error("message required");
      notifyOutgoing(args.slice(1).join(" "));
      break;
    case "agents":
      if (!args[1]) throw new Error("message required");
      notifyAgents(args.slice(1).join(" "));
      break;
    case "proposal": {
      // ludics notify proposal <task-id> <title> <summary> <file-path>
      const taskId = args[1];
      const title = args[2];
      const summary = args[3];
      const filePath = args[4];
      if (!taskId || !title || !summary || !filePath) {
        throw new Error("usage: ludics notify proposal <task-id> <title> <summary> <file-path>");
      }
      notifyProposal(taskId, title, summary, filePath);
      break;
    }
    case "subscribe": {
      const { clusterIsController } = await import("./cluster.ts");
      if (!clusterIsController()) {
        console.error("ludics: notify subscribe skipped — not the cluster controller");
        break;
      }
      await subscribeIncoming();
      break;
    }
    case "recent":
      notifyRecent(args[1] ? parseInt(args[1], 10) : 10);
      break;
    default:
      throw new Error(`unknown notify command: ${tier} (use: outgoing, agents, proposal, subscribe, recent)`);
  }
}
