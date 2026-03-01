// Notification system — ntfy.sh integration (outgoing + incoming + agents)

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { loadConfigSync, harnessDir } from "./config.ts";
import { queueRequest } from "./queue.ts";
import { emitEvent } from "./events.ts";

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

function resolveProposalFilePath(taskId: string, filePath: string): string | null {
  const rawPath = filePath.trim();
  if (!rawPath) return null;

  const expanded = rawPath.startsWith("~/")
    ? resolve(process.env.HOME ?? "~", rawPath.slice(2))
    : rawPath;

  const direct = resolve(expanded);
  if (isRegularFile(direct)) return direct;

  const home = process.env.HOME ?? "~";
  const candidates: string[] = [];
  for (const dir of candidateProjectDirs(taskProject(taskId))) {
    candidates.push(resolve(home, dir, expanded));
  }
  candidates.push(resolve(home, expanded));

  for (const candidate of candidates) {
    if (isRegularFile(candidate)) return candidate;
  }

  return null;
}

function proposalMessageBody(taskId: string, summary: string, filePath: string): string {
  let proposalText = "";
  const resolvedPath = resolveProposalFilePath(taskId, filePath);

  if (resolvedPath) {
    try {
      const raw = readFileSync(resolvedPath, "utf-8");
      proposalText = raw.length > 2000 ? raw.slice(0, 2000) + "\n\n[truncated]" : raw;
    } catch {
      proposalText = "";
    }
  }

  const trimmedSummary = summary.trim();
  const trimmedProposal = proposalText.trim();

  if (trimmedProposal && trimmedSummary && trimmedProposal !== trimmedSummary) {
    return `Summary: ${trimmedSummary}\n\n${proposalText}`;
  }
  if (proposalText) return proposalText;
  return summary;
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
  notifyLog("outgoing", `Proposal for ${taskId}: ${title}`, 3, "proposal");

  if (!outTopic) {
    console.error("ludics: outgoing topic not configured, logging locally only");
    return;
  }

  const token = getToken();
  const project = taskId.split("-").slice(0, -1).join("-") || "unknown";
  const messageBody = proposalMessageBody(taskId, summary, filePath);

  // Build JSON payload with action buttons. ntfy clients may cap rendered count.
  const payload: Record<string, unknown> = {
    topic: outTopic,
    title: `Proposal: ${title}`,
    message: messageBody,
    priority: 3,
    tags: ["memo", taskId],
  };

  if (inTopic) {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Keep all configured launch actions in payload; backend/client may cap rendered count.
    payload.actions = [
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
  }

  const curlArgs = [
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "-X", "POST",
    "-H", "Content-Type: application/json",
  ];
  if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`);
  curlArgs.push("-d", JSON.stringify(payload), "https://ntfy.sh/");

  const result = Bun.spawnSync(curlArgs, { stdout: "pipe", stderr: "pipe" });
  const httpCode = result.stdout.toString().trim();
  if (httpCode !== "200") {
    const stderr = result.stderr.toString().trim();
    console.error(`ludics: ntfy.sh proposal notification failed (HTTP ${httpCode})${stderr ? `: ${stderr}` : ""}, logged locally`);
    notifySend(outTopic, `Proposal for ${taskId}\n\n${messageBody}`, 3, `Proposal: ${title}`, "memo");
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
