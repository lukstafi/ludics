// Notification system — ntfy.sh integration (outgoing + incoming + agents)

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { loadConfigSync, harnessDir, slotsFilePath } from "./config.ts";
import { queueRequest } from "./queue.ts";
import { emitEvent } from "./events.ts";
import { parseSlotBlocks, getTask, getPath } from "./slots/markdown.ts";

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
    {
      action: "http",
      label: "codex",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Launch agent-codex for ${taskId} in project ${project}`,
    },
    {
      action: "http",
      label: "claude",
      url: `https://ntfy.sh/${inTopic}`,
      method: "POST",
      headers,
      body: `Launch agent-claude for ${taskId} in project ${project}`,
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

              // Direct queue injection — message content goes into the queue entry
              const escaped = JSON.stringify(data.message);
              queueRequest("message", `"content":${escaped}`);

              // Log to journal
              notifyLog("incoming", data.message, 3, data.title || "ntfy incoming");
              emitEvent({ event_type: "notify_incoming", source: "notify", scope: "notify", message: data.message.slice(0, 200) });

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
