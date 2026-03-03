// Notification system — ntfy.sh integration (outgoing + incoming + agents)

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from "fs";
import { basename, join, resolve } from "path";
import { loadConfigSync, harnessDir, slotsFilePath } from "./config.ts";
import { queueRequest } from "./queue.ts";
import { emitEvent } from "./events.ts";
import { parseSlotBlocks, getTask, getPath } from "./slots/markdown.ts";
import { listSessions, type SessionInfo } from "./adapters/peer-sync.ts";
import { readSingleFile, readStatusFile, resolveProjectDir, isGitWorktree, getMainRepoFromWorktree } from "./adapters/base.ts";
import type { AdapterContext } from "./adapters/types.ts";

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
    "-d", message,
  ];
  if (title) curlArgs.push("-H", `Title: ${title}`);
  curlArgs.push("-H", `Priority: ${priority}`);
  if (tags) curlArgs.push("-H", `Tags: ${tags}`);
  const token = getToken();
  if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`);
  curlArgs.push(`https://ntfy.sh/${topic}`);

  const result = Bun.spawnSync(curlArgs, { stdout: "pipe", stderr: "pipe" });
  const httpCode = result.stdout.toString().trim();
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
const FOLLOWUP_SUMMARY_CHAR_CUTOFF = 300;
const FOLLOWUP_PHASE = "suggest-refactor";
const FOLLOWUP_TERMINAL_PHASES = new Set(["done", "completed", "complete", "finished", "stopped"]);
const FOLLOWUP_TERMINAL_STATUSES = new Set(["done", "completed", "complete", "finished", "stopped", "error", "interrupted", "failed", "canceled", "cancelled"]);

interface FollowupNotificationInput {
  taskId: string;
  adapter: string;
  slotNum: number | null;
  sessionToken: string;
  phaseToken: string;
  prLinks: string[];
  kind: "ready" | "completed";
  refactorSummary?: string;
}

interface PendingFollowupRevise {
  taskId: string;
  adapter: string;
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

  const result = Bun.spawnSync(curlArgs, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const splitAt = stdout.lastIndexOf("\n");
  const body = splitAt >= 0 ? stdout.slice(0, splitAt).trim() : "";
  const httpCode = splitAt >= 0 ? stdout.slice(splitAt + 1).trim() : stdout.trim();
  return {
    httpCode,
    stderr: result.stderr.toString().trim(),
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

  const result = Bun.spawnSync(curlArgs, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const splitAt = stdout.lastIndexOf("\n");
  const body = splitAt >= 0 ? stdout.slice(0, splitAt).trim() : "";
  const httpCode = splitAt >= 0 ? stdout.slice(splitAt + 1).trim() : stdout.trim();
  return {
    httpCode,
    stderr: result.stderr.toString().trim(),
    body,
  };
}

function truncateInline(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function extractRefactorSummary(markdownText: string): string {
  const lines = markdownText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) return truncateInline(numbered[1]!, FOLLOWUP_SUMMARY_CHAR_CUTOFF);
    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) return truncateInline(bullet[1]!, FOLLOWUP_SUMMARY_CHAR_CUTOFF);
  }
  const firstText = lines.map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return truncateInline(firstText, FOLLOWUP_SUMMARY_CHAR_CUTOFF);
}

function followupNotifyStateFile(): string {
  return join(harnessDir(), "mag", "followup-notified.json");
}

function loadFollowupNotifyState(): Record<string, string> {
  const file = followupNotifyStateFile();
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

function saveFollowupNotifyState(state: Record<string, string>): void {
  const file = followupNotifyStateFile();
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

function followupNotifyKey(input: FollowupNotificationInput): string {
  return `${input.taskId}|${input.adapter}|${input.kind}|${input.sessionToken}|${input.phaseToken}`;
}

function normalizeProjectDirCandidate(raw: string): string {
  const expanded = raw.startsWith("~/")
    ? join(process.env.HOME ?? "~", raw.slice(2))
    : raw;
  const abs = resolve(expanded);
  if (isGitWorktree(abs)) {
    const mainRepo = getMainRepoFromWorktree(abs);
    if (mainRepo) return mainRepo;
  }
  return abs;
}

function resolveAdapterProjectDir(ctx: AdapterContext): string {
  const candidates: string[] = [];
  if (ctx.path && ctx.path !== "null") candidates.push(ctx.path);
  candidates.push(resolveProjectDir(ctx.session, true));

  const normalized = Array.from(new Set(candidates.map(normalizeProjectDirCandidate)));

  for (const dir of normalized) {
    if (existsSync(join(dir, ".agent-sessions"))) return dir;
  }
  for (const dir of normalized) {
    if (existsSync(dir)) return dir;
  }
  return normalized[0] ?? process.cwd();
}

function orchestratedModeFilter(adapter: string): string | null {
  switch (adapter) {
    case "agent-duo":
      return "duo";
    case "agent-pair-codex":
    case "agent-pair-claude":
      return "pair";
    default:
      return null;
  }
}

function matchesOrchestratedMode(peerSyncPath: string, modeFilter: string | null): boolean {
  if (!modeFilter) return false;
  const mode = readSingleFile(join(peerSyncPath, "mode")) ?? "";
  return mode === modeFilter;
}

function selectSessionForTask(
  sessions: SessionInfo[],
  taskId: string,
): SessionInfo | null {
  if (sessions.length === 0) return null;
  if (!taskId) return sessions.length === 1 ? sessions[0]! : null;

  const aliases = taskFeatureAliases(taskId);
  const candidates = [taskId, ...aliases];

  for (const candidate of candidates) {
    const exact = sessions.find((s) => s.feature === candidate);
    if (exact) return exact;
  }

  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundaryPattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
    const boundaryMatch = sessions.find((s) => boundaryPattern.test(s.feature));
    if (boundaryMatch) return boundaryMatch;
  }

  if (sessions.length === 1) return sessions[0]!;
  return null;
}

function isFollowupSession(session: SessionInfo): boolean {
  const rootName = basename(session.rootWorktree).toLowerCase();
  if (rootName.endsWith("-followup")) return true;
  const feature = session.feature.toLowerCase();
  return /(^|[-_])followup($|[-_])/.test(feature);
}

function taskFeatureAliases(taskId: string): string[] {
  const aliases = new Set<string>();
  const taskFile = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return [];

  try {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return [];

    const proposalMatch = fmMatch[1]!.match(/^\s*proposal:\s*(.+)$/m);
    if (!proposalMatch) return [];

    const raw = proposalMatch[1]!.trim();
    if (!raw || raw.toLowerCase() === "null") return [];
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1).trim()
        : raw;
    const base = unquoted.split("/").pop() ?? "";
    const feature = base.replace(/\.md$/i, "").trim();
    if (feature) aliases.add(feature);
  } catch {
    return [];
  }

  return Array.from(aliases);
}

function collectPrLinks(peerSyncPath: string): string[] {
  const links = new Set<string>();
  try {
    const files = readdirSync(peerSyncPath).filter((f) => f.endsWith(".pr"));
    for (const fileName of files) {
      const content = readFileSync(join(peerSyncPath, fileName), "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const url = line.trim();
        if (/^https?:\/\/\S+$/i.test(url)) links.add(url);
      }
    }
  } catch {
    // ignore read failures
  }
  return Array.from(links);
}

function collectRefactorSummary(peerSyncPath: string): string {
  const candidates = [
    "suggest-refactor-combined.md",
    "suggest-refactor-coder.md",
  ];
  for (const fileName of candidates) {
    const fullPath = join(peerSyncPath, fileName);
    if (!isRegularFile(fullPath)) continue;
    try {
      const text = readFileSync(fullPath, "utf-8");
      const summary = extractRefactorSummary(text);
      if (summary) return summary;
    } catch {
      // keep trying fallbacks
    }
  }
  return "";
}

function isFollowupSlotRun(ctx: AdapterContext): boolean {
  return /(^|\s)--followup(?:\s|$)/.test(ctx.adapterArgs) || /(^|\s)--followup-msg(?:\s|$)/.test(ctx.adapterArgs);
}

function sessionToken(peerSyncPath: string, fallback: string): string {
  return readSingleFile(join(peerSyncPath, "session")) ?? basename(peerSyncPath) ?? fallback;
}

function isCompletedFollowupPhase(phase: string): boolean {
  return FOLLOWUP_TERMINAL_PHASES.has(phase.toLowerCase());
}

function parseIsoEpochSeconds(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (!raw || raw.toLowerCase() === "null") return 0;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000);
}

function phaseFileUpdatedSince(peerSyncPath: string, minEpochSec: number): boolean {
  if (minEpochSec <= 0) return true;
  const phaseFile = join(peerSyncPath, "phase");
  if (!existsSync(phaseFile)) return false;
  try {
    return statSync(phaseFile).mtimeMs >= minEpochSec * 1000;
  } catch {
    return false;
  }
}

function followupStatusFiles(adapter: string): string[] {
  switch (adapter) {
    case "agent-duo":
      return ["claude.status", "codex.status"];
    case "agent-pair-codex":
    case "agent-pair-claude":
      return ["coder.status", "reviewer.status"];
    default:
      return [];
  }
}

function hasCompletedFollowupStatuses(peerSyncPath: string, adapter: string, minEpochSec: number): boolean {
  const files = followupStatusFiles(adapter);
  if (files.length === 0) return false;
  const statuses = files
    .map((fileName) => readStatusFile(join(peerSyncPath, fileName)))
    .filter((status): status is NonNullable<typeof status> => status !== null);
  if (statuses.length !== files.length) return false;
  return statuses.every((status) =>
    FOLLOWUP_TERMINAL_STATUSES.has(status.status.toLowerCase())
    && (minEpochSec <= 0 || status.epoch >= minEpochSec),
  );
}

function readPhaseToken(peerSyncPath: string): string {
  const token = readSingleFile(join(peerSyncPath, "phase-token")) ?? "";
  if (token) return token;
  const phase = readSingleFile(join(peerSyncPath, "phase")) ?? "";
  const round = readSingleFile(join(peerSyncPath, "round")) ?? "";
  return phase && round ? `${phase}|r${round}` : phase;
}

export function notifyPostMergeFollowup(input: FollowupNotificationInput): void {
  const outTopic = getTopic("outgoing");
  const inTopic = getTopic("incoming");
  if (!outTopic) {
    console.error("ludics: outgoing topic not configured, logging locally only");
    return;
  }
  const key = followupNotifyKey(input);
  const state = loadFollowupNotifyState();
  if (state[key]) return;

  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const titleBase = input.kind === "completed"
    ? "Followup complete"
    : "Post-merge followup";
  const title = input.slotNum !== null
    ? `${titleBase} [slot ${input.slotNum}]: ${input.taskId}`
    : `${titleBase}: ${input.taskId}`;

  const lines: string[] = [
    input.kind === "completed"
      ? `Followup session completed for ${input.taskId}.`
      : `Post-merge followup is ready for ${input.taskId}.`,
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
      body: `Followup ${input.adapter} for ${input.taskId}`,
    },
    {
      action: "http",
      label: "revise",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Revise followup ${input.adapter} for ${input.taskId}`,
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
    console.error(`ludics: ntfy.sh post-merge followup notification failed (HTTP ${result.httpCode})${detail ? `: ${detail}` : ""}, logged locally`);
    return;
  }

  state[key] = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  saveFollowupNotifyState(state);
  notifyLog("outgoing", message.replace(/\n/g, " "), 3, "post-merge followup");
}

export function maybeNotifyPostMergeFollowupForAdapter(ctx: AdapterContext): void {
  if (!ctx.taskId) return;
  const modeFilter = orchestratedModeFilter(ctx.mode);
  if (!modeFilter) return;

  const projectDir = resolveAdapterProjectDir(ctx);
  const followupSlotRun = isFollowupSlotRun(ctx);
  const sessions = listSessions(projectDir).filter((s) => matchesOrchestratedMode(s.peerSyncPath, modeFilter));
  if (sessions.length === 0) return;
  const candidateSessions = followupSlotRun ? sessions.filter(isFollowupSession) : sessions;
  if (candidateSessions.length === 0) return;

  const session = selectSessionForTask(candidateSessions, ctx.taskId);
  if (!session) return;
  const phase = readSingleFile(join(session.peerSyncPath, "phase")) ?? "";
  const followupStartedEpoch = parseIsoEpochSeconds(ctx.started);
  const completedFollowup = (
    isCompletedFollowupPhase(phase)
    && phaseFileUpdatedSince(session.peerSyncPath, followupStartedEpoch)
  ) || hasCompletedFollowupStatuses(session.peerSyncPath, ctx.mode, followupStartedEpoch);
  if (followupSlotRun) {
    if (!completedFollowup) return;
  } else if (phase !== FOLLOWUP_PHASE) {
    return;
  }

  const prLinks = collectPrLinks(session.peerSyncPath);
  const phaseToken = readPhaseToken(session.peerSyncPath) || FOLLOWUP_PHASE;
  const refactorSummary = collectRefactorSummary(session.peerSyncPath);
  if (!followupSlotRun && prLinks.length === 0) return;
  if (followupSlotRun && prLinks.length === 0 && !refactorSummary) return;
  notifyPostMergeFollowup({
    taskId: ctx.taskId,
    adapter: ctx.mode,
    slotNum: ctx.slot,
    sessionToken: sessionToken(session.peerSyncPath, ctx.taskId),
    phaseToken,
    kind: followupSlotRun ? "completed" : "ready",
    prLinks,
    refactorSummary: refactorSummary || undefined,
  });
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

/** @deprecated Use notifyOutgoing instead */
export const notifyPai = notifyOutgoing;

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
  const inlineMessage = proposalInlineMessage(summary, proposalText, attachmentName);
  const inlineHeaderMessage = inlineMessage.replace(/\r?\n/g, " ").trim();
  const tagsHeader = `memo,${taskId}`;

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const actions: Array<Record<string, unknown>> = [
    {
      action: "http",
      label: "agent-duo",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Launch agent-duo for ${taskId} in project ${project}`,
    },
    {
      action: "http",
      label: "revise",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Revise proposal for ${taskId}`,
    },
    {
      action: "http",
      label: "abandon",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Abandon task ${taskId}`,
    },
    {
      action: "http",
      label: "pair-claude",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Launch agent-pair-claude for ${taskId} in project ${project}`,
    },
    {
      action: "http",
      label: "pair-codex",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Launch agent-pair-codex for ${taskId} in project ${project}`,
    },
  ];

  let first: { httpCode: string; stderr: string; body: string };
  if (resolvedPath) {
    first = notifyPublishFile(
      outTopic,
      resolvedPath,
      attachmentName,
      token,
      proposalTitle,
      inlineHeaderMessage,
      3,
      tagsHeader,
      inTopic ? actions.slice(0, NTFY_MAX_ACTIONS) : [],
    );
  } else {
    first = notifyPublishMessage(
      outTopic,
      inlineMessage,
      token,
      proposalTitle,
      3,
      tagsHeader,
      inTopic ? actions.slice(0, NTFY_MAX_ACTIONS) : [],
    );
  }

  if (first.httpCode !== "200") {
    const detail = first.body || first.stderr;
    console.error(`ludics: ntfy.sh proposal notification failed (HTTP ${first.httpCode})${detail ? `: ${detail}` : ""}, retrying without attachment`);
    const fallback = notifyPublishMessage(
      outTopic,
      `Proposal for ${taskId}${slotSuffix}\n\n${inlineMessage}`,
      token,
      proposalTitle,
      3,
      tagsHeader,
      inTopic ? actions.slice(0, NTFY_MAX_ACTIONS) : [],
    );
    if (fallback.httpCode !== "200") {
      const fallbackDetail = fallback.body || fallback.stderr;
      console.error(`ludics: ntfy.sh proposal fallback failed (HTTP ${fallback.httpCode})${fallbackDetail ? `: ${fallbackDetail}` : ""}, logged locally`);
    }
    return;
  }

  if (!inTopic) return;

  for (let i = NTFY_MAX_ACTIONS; i < actions.length; i += NTFY_MAX_ACTIONS) {
    const followup = notifyPublishMessage(
      outTopic,
      `More launch options for ${taskId}${slotSuffix}.`,
      token,
      optionsTitle,
      3,
      tagsHeader,
      actions.slice(i, i + NTFY_MAX_ACTIONS),
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
      const obj = JSON.parse(line);
      console.log(`${obj.timestamp} [${obj.tier}] ${obj.title}: ${obj.message}`);
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
    return JSON.parse(readFileSync(file, "utf-8"));
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

function appendToInbox(message: string, title?: string): void {
  const inboxFile = join(harnessDir(), "mag", "inbox.md");
  mkdirSync(join(harnessDir(), "mag"), { recursive: true });

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const heading = title ? `## ntfy: ${title} - ${timestamp}` : `## ntfy Message - ${timestamp}`;
  const entry = `\n${heading}\n\n${message}\n`;

  const existing = existsSync(inboxFile) ? readFileSync(inboxFile, "utf-8") : "# Mag Inbox\n";
  writeFileSync(inboxFile, existing + entry);
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
        queueRequest("revise-proposal", `"task":"${taskId}"`);
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
        queueRequest("adapter-followup", `"task":"${taskId}","adapter":"${adapter}"`);
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
            const data = JSON.parse(line.slice(6));
            if (data.event === "message" && data.message) {
              console.log(`ludics: received message [${data.id}]: ${data.message.slice(0, 80)}`);

              const msg: string = data.message;

              // Button taps and pending feedback capture modes
              const reviseProposalMatch = msg.match(/^Revise proposal for ([\w.-]+)$/);
              const followupMatch = msg.match(/^Followup ([\w-]+) for ([\w.-]+)$/);
              const followupReviseMatch = msg.match(/^Revise followup ([\w-]+) for ([\w.-]+)$/);
              const doneMatch = msg.match(/^Done task ([\w.-]+)$/);

              if (reviseProposalMatch) {
                setPendingRevise(reviseProposalMatch[1]!);
              } else if (followupReviseMatch) {
                const adapter = followupReviseMatch[1]!;
                const taskId = followupReviseMatch[2]!;
                setPendingFollowupRevise(taskId, adapter);
              } else if (followupMatch) {
                const adapter = followupMatch[1]!;
                const taskId = followupMatch[2]!;
                queueRequest("adapter-followup", `"task":"${taskId}","adapter":"${adapter}"`);
              } else if (doneMatch) {
                queueRequest("complete-task", `"task":"${doneMatch[1]!}"`);
              } else {
                const pendingTaskIds = consumeAllPendingRevises();
                const pendingFollowups = consumeAllPendingFollowupRevises();

                if (pendingTaskIds.length > 0 || pendingFollowups.length > 0) {
                  const escaped = JSON.stringify(msg);
                  for (const taskId of pendingTaskIds) {
                    queueRequest("revise-proposal", `"task":"${taskId}","feedback":${escaped}`);
                  }
                  for (const pending of pendingFollowups) {
                    queueRequest(
                      "adapter-followup",
                      `"task":"${pending.taskId}","adapter":"${pending.adapter}","followup_msg":${escaped}`,
                    );
                  }
                } else {
                  // Normal message — direct queue injection
                  const escaped = JSON.stringify(msg);
                  queueRequest("message", `"content":${escaped}`);
                }
              }

              // Log to journal
              notifyLog("incoming", msg, 3, data.title || "ntfy incoming");
              emitEvent({ event_type: "notify_incoming", source: "notify", scope: "notify", message: msg.slice(0, 200) });

              // Persist state
              saveSubscriberState(data.id);
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
    case "subscribe":
      await subscribeIncoming();
      break;
    case "recent":
      notifyRecent(args[1] ? parseInt(args[1], 10) : 10);
      break;
    default:
      throw new Error(`unknown notify command: ${tier} (use: outgoing, agents, proposal, subscribe, recent)`);
  }
}
