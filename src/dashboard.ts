// Dashboard — generate JSON data, serve, install

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";
import { harnessDir, loadConfigSync, slotsFilePath } from "./config.ts";
import { parseSlotBlocks, getField, getProcess, getTask, getMode, getSessionStarted } from "./slots/markdown.ts";
import { readStash } from "./slots/preempt.ts";
import { getUrl } from "./network.ts";
import { inspectManagedServerProcess, readServerRecord, t3codeStartingPath } from "./t3code/server.ts";
import { readOrchestrationState } from "./orchestration/state.ts";
import { startDashboardServer } from "./dashboard-server.ts";

function dashboardDataDir(): string {
  return join(harnessDir(), "dashboard", "data");
}

// --- Generate slots.json ---

interface SlotJson {
  number: number;
  empty: boolean;
  process: string | null;
  task: string | null;
  taskContent: string | null;
  mode: string | null;
  started: string | null;
  /** ISO timestamp written by slotStart(); null if no session is running. */
  sessionStarted: string | null;
  phase: string | null;
  terminals: Record<string, string> | null;
  preempted: boolean;
  preemptedTask: string | null;
  hasProposal: boolean;
  proposalLink: string | null;
  prUrl: string | null;
  githubUrl: string | null;
  t3codeThreadLinks: Record<string, string> | null;
  effort: string | null;
}

function lookupTaskContent(taskId: string): string | null {
  const tasksDir = join(harnessDir(), "tasks");
  const taskFile = join(tasksDir, taskId + ".md");
  if (!existsSync(taskFile)) return null;
  const content = readFileSync(taskFile, "utf-8");
  // Strip YAML frontmatter, return the markdown body
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  return body || null;
}

// Discover running ttyd processes and map tmux session names to their URLs
function discoverTtydUrls(): Map<string, string> {
  const result = new Map<string, string>();
  try {
    const proc = Bun.spawnSync(["pgrep", "-fa", "ttyd"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return result;
    const lines = proc.stdout.toString().trim().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      // Match port: -p PORT or --port PORT or --port=PORT
      const portMatch = line.match(/(?:-p\s+|--port[= ])(\d+)/);
      // Match tmux session: tmux ... -t SESSION (covers attach, new-session, etc.)
      const sessionMatch = line.match(/tmux\s+\S.*?-t\s+(\S+)/);
      if (portMatch && sessionMatch) {
        const port = portMatch[1]!;
        const session = sessionMatch[1]!.replace(/^['"]|['"]$/g, "");
        const url = getUrl(port);
        if (url) result.set(session, url);
      }
    }
  } catch {
    // ignore — pgrep may not be available or ttyd may not be running
  }
  return result;
}

function lookupTaskGithubUrl(taskId: string): string | null {
  const tasksDir = join(harnessDir(), "tasks");
  const taskFile = join(tasksDir, taskId + ".md");
  if (!existsSync(taskFile)) return null;
  try {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const data = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;
    const url = data.url;
    if (!url || typeof url !== "string" || url.trim() === "" || url.trim().toLowerCase() === "null") return null;
    return url.trim();
  } catch {
    return null;
  }
}

function lookupTaskEffort(taskId: string): string | null {
  const tasksDir = join(harnessDir(), "tasks");
  const taskFile = join(tasksDir, taskId + ".md");
  if (!existsSync(taskFile)) return null;
  try {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const data = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;
    const effort = data.effort;
    if (!effort || typeof effort !== "string" || effort.trim() === "" || effort.trim().toLowerCase() === "null") return null;
    return effort.trim();
  } catch {
    return null;
  }
}

function lookupSlotOrchestrationLinks(
  slotNum: number,
  t3codeWebUrl: string | null,
  currentTaskId: string | null,
): { prUrl: string | null; t3codeThreadLinks: Record<string, string> | null } {
  const orchState = readOrchestrationState(slotNum);
  if (!orchState) return { prUrl: null, t3codeThreadLinks: null };
  // Skip stale orchestration state from a previous task
  if (currentTaskId && orchState.taskId && orchState.taskId !== currentTaskId && orchState.feature !== currentTaskId) {
    return { prUrl: null, t3codeThreadLinks: null };
  }

  // Extract first non-null PR URL from agent states
  let prUrl: string | null = null;
  for (const agentState of Object.values(orchState.agentStates)) {
    if (agentState.prUrl) {
      prUrl = agentState.prUrl;
      break;
    }
  }

  // Build t3code thread links from threadIds + server webUrl
  let t3codeThreadLinks: Record<string, string> | null = null;
  if (t3codeWebUrl && orchState.threadIds && Object.keys(orchState.threadIds).length > 0) {
    t3codeThreadLinks = {};
    for (const [agentName, threadId] of Object.entries(orchState.threadIds)) {
      t3codeThreadLinks[agentName] = `${t3codeWebUrl}/${encodeURIComponent(threadId)}`;
    }
    if (Object.keys(t3codeThreadLinks).length === 0) t3codeThreadLinks = null;
  }

  return { prUrl, t3codeThreadLinks };
}

function lookupTaskHasProposal(taskId: string): boolean {
  const tasksDir = join(harnessDir(), "tasks");
  const taskFile = join(tasksDir, taskId + ".md");
  if (!existsSync(taskFile)) return false;
  try {
    const content = readFileSync(taskFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;
    const data = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;
    return hasNonNullProposal(data.proposal);
  } catch {
    return false;
  }
}

function generateSlots(): SlotJson[] {
  const slotsFile = slotsFilePath();
  if (!existsSync(slotsFile)) return [];

  const content = readFileSync(slotsFile, "utf-8");
  const blocks = parseSlotBlocks(content);
  const ttydBySession = discoverTtydUrls();
  const result: SlotJson[] = [];

  // Resolve t3code web URL once for all slots
  const t3codeRecord = readServerRecord();
  const t3codeWebUrl = t3codeRecord ? t3codeRecord.webUrl : null;

  for (const [num, block] of blocks) {
    const process = getProcess(block).trim();
    const empty = !process || process === "(empty)";

    // Parse terminals from block
    const terminals: Record<string, string> = {};
    let inTerminals = false;
    for (const line of block.split("\n")) {
      if (line === "**Terminals:**") { inTerminals = true; continue; }
      if (line.match(/^\*\*[A-Za-z]+:\*\*/)) { inTerminals = false; continue; }
      if (inTerminals) {
        const m = line.match(/^- ([^:]+):\s*(.+)$/);
        if (m) {
          terminals[m[1]!.toLowerCase().replace(/ /g, "_")] = m[2]!;
        }
      }
    }

    // Enrich terminals: cross-reference tmux session references with discovered ttyd processes
    for (const key of Object.keys(terminals)) {
      const value = terminals[key]!;
      if (!value.startsWith("http://") && !value.startsWith("https://")) {
        // Non-URL entry — extract tmux session name and look up a ttyd URL
        const tmuxMatch = value.match(/tmux\s+session\s+'?([^']+)'?/i)
          || value.match(/^([^\s]+)$/); // bare session name
        const sessionName = tmuxMatch?.[1]?.trim();
        if (sessionName && ttydBySession.has(sessionName)) {
          terminals[key] = ttydBySession.get(sessionName)!;
        }
      }
    }

    const taskId = empty ? null : getTask(block).trim() || null;

    // Parse phase: prefer orchestration state JSON (authoritative), fall back to Runtime section in slots.md
    let phase: string | null = null;
    if (!empty) {
      const orchState = readOrchestrationState(num);
      if (orchState && (!taskId || orchState.taskId === taskId || orchState.feature === taskId)) {
        phase = orchState.phase ?? null;
      }
    }
    if (!phase) {
      const phaseMatch = block.match(/^- Phase:\s*(.+)$/m);
      if (phaseMatch) phase = phaseMatch[1]!.trim();
    }
    const taskContent = taskId && taskId !== "null" ? lookupTaskContent(taskId) : null;
    const taskEffort = taskId && taskId !== "null" ? lookupTaskEffort(taskId) : null;
    const slotHasProposal = taskId && taskId !== "null" ? lookupTaskHasProposal(taskId) : false;
    const slotProposalLink = slotHasProposal && taskId ? `/proposal.html?task=${encodeURIComponent(taskId)}` : null;
    const githubUrl = taskId && taskId !== "null" ? lookupTaskGithubUrl(taskId) : null;

    // Read orchestration state for PR URL and t3code thread links.
    // Only use the state if its feature matches the slot's current task
    // to avoid showing stale links from a previous task.
    const orchLinks = empty ? { prUrl: null, t3codeThreadLinks: null }
      : lookupSlotOrchestrationLinks(num, t3codeWebUrl, taskId);

    // Check for preemption stash
    const stash = readStash(num);

    const rawSessionStarted = getSessionStarted(block).trim();
    const sessionStarted = (rawSessionStarted && rawSessionStarted !== "null") ? rawSessionStarted : null;

    result.push({
      number: num,
      empty,
      process: empty ? null : process,
      task: taskId,
      taskContent,
      mode: empty ? null : getMode(block).trim() || null,
      started: empty ? null : getField(block, "Started").trim() || null,
      sessionStarted: empty ? null : sessionStarted,
      phase: empty ? null : phase,
      terminals: empty ? null : Object.keys(terminals).length > 0 ? terminals : null,
      preempted: stash !== null,
      preemptedTask: stash?.previousTask ?? null,
      hasProposal: slotHasProposal,
      proposalLink: slotProposalLink,
      prUrl: empty ? null : orchLinks.prUrl,
      githubUrl: empty ? null : githubUrl,
      t3codeThreadLinks: empty ? null : orchLinks.t3codeThreadLinks,
      effort: taskEffort,
    });
  }

  return result;
}

// --- Generate ready.json ---

interface ReadyTask {
  id: string;
  title: string;
  priority: string;
  project: string;
  context: string;
  deadline: string | null;
}

interface DashboardTask {
  id: string;
  title: string;
  project: string;
  status: string;
  priority: string;
  context: string;
  deadline: string | null;
  completed: string | null;
  isCompleted: boolean;
  url: string | null;
  hasProposal: boolean;
  proposalPath: string | null;
  dependencies: {
    blocks: string[];
    blocked_by: string[];
    subtask_of: string | null;
  };
}

interface TasksTreeNode {
  kind: "project" | "task";
  id: string;
  title: string;
  link: string | null;
  proposalLink: string | null;
  priority: string | null;
  status: string | null;
  hasProposal: boolean;
  highlighted: boolean;
  children: TasksTreeNode[];
}

function priorityValue(priority: string): number {
  if (priority === "S") return 0;
  if (priority === "A") return 1;
  if (priority === "B") return 2;
  if (priority === "C") return 3;
  return 9;
}

function hasNonNullProposal(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "null";
  }
  return true;
}

function isNonNullValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "null";
  }
  return true;
}

function readDashboardTasks(): DashboardTask[] {
  const tasksDir = join(harnessDir(), "tasks");
  if (!existsSync(tasksDir)) return [];

  const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
  const tasks: DashboardTask[] = [];

  for (const f of files) {
    const content = readFileSync(join(tasksDir, f), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    try {
      const data = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
      const deps = (data.dependencies as Record<string, unknown>) ?? {};
      const id = String(data.id ?? "");
      if (!id) continue;
      tasks.push({
        id,
        title: String(data.title ?? ""),
        status: String(data.status ?? "ready"),
        priority: String(data.priority ?? "B"),
        project: String(data.project ?? ""),
        context: String(data.context ?? ""),
        deadline: data.deadline ? String(data.deadline) : null,
        completed: isNonNullValue(data.completed) ? String(data.completed) : null,
        isCompleted: isNonNullValue(data.completed),
        url: data.url ? String(data.url) : null,
        hasProposal: hasNonNullProposal(data.proposal),
        proposalPath: isNonNullValue(data.proposal) ? String(data.proposal).trim() : null,
        dependencies: {
          blocks: Array.isArray(deps.blocks) ? (deps.blocks as string[]) : [],
          blocked_by: Array.isArray(deps.blocked_by) ? (deps.blocked_by as string[]) : [],
          subtask_of: deps.subtask_of ? String(deps.subtask_of) : null,
        },
      });
    } catch {
      // skip
    }
  }

  return tasks;
}

function generateReady(tasks: DashboardTask[]): ReadyTask[] {
  const ready: ReadyTask[] = tasks
    .filter((task) => task.status === "ready" && task.dependencies.blocked_by.length === 0)
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      project: task.project,
      context: task.context,
      deadline: task.deadline,
    }));

  ready.sort((a, b) => {
    const pd = priorityValue(a.priority) - priorityValue(b.priority);
    if (pd !== 0) return pd;
    return (a.deadline ?? "9999-99-99").localeCompare(b.deadline ?? "9999-99-99");
  });

  return ready;
}

function generateTasksTree(tasks: DashboardTask[]): TasksTreeNode[] {
  if (tasks.length === 0) return [];

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByTask = new Map<string, Set<string>>();
  const parentsByTask = new Map<string, Set<string>>();
  const projectByTask = new Map<string, string>();

  function taskProject(task: DashboardTask): string {
    const project = task.project.trim();
    return project ? project : "(no project)";
  }

  function addEdge(parentId: string, childId: string): void {
    if (parentId === childId) return;
    if (!taskById.has(parentId) || !taskById.has(childId)) return;
    const children = childrenByTask.get(parentId) ?? new Set<string>();
    children.add(childId);
    childrenByTask.set(parentId, children);

    const parents = parentsByTask.get(childId) ?? new Set<string>();
    parents.add(parentId);
    parentsByTask.set(childId, parents);
  }

  for (const task of tasks) {
    projectByTask.set(task.id, taskProject(task));
  }

  for (const task of tasks) {
    if (task.dependencies.subtask_of) addEdge(task.dependencies.subtask_of, task.id);
    for (const childId of task.dependencies.blocks) addEdge(task.id, childId);
    for (const parentId of task.dependencies.blocked_by) addEdge(parentId, task.id);
  }

  function compareTaskIds(aId: string, bId: string): number {
    const a = taskById.get(aId);
    const b = taskById.get(bId);
    if (!a || !b) return aId.localeCompare(bId);
    const prioDiff = priorityValue(a.priority) - priorityValue(b.priority);
    if (prioDiff !== 0) return prioDiff;
    const titleDiff = a.title.localeCompare(b.title);
    if (titleDiff !== 0) return titleDiff;
    return a.id.localeCompare(b.id);
  }

  function buildTaskNode(
    taskId: string,
    path: Set<string>,
    depth: number,
  ): { node: TasksTreeNode; subtreeHasActiveProposal: boolean } {
    function fallbackNode(id: string): TasksTreeNode {
      return {
        kind: "task",
        id,
        title: id,
        link: null,
        proposalLink: null,
        priority: null,
        status: null,
        hasProposal: false,
        highlighted: false,
        children: [],
      };
    }

    const task = taskById.get(taskId);
    if (!task) {
      return { node: fallbackNode(taskId), subtreeHasActiveProposal: false };
    }

    const nextPath = new Set(path);
    nextPath.add(taskId);
    const childIds = Array.from(childrenByTask.get(taskId) ?? [])
      .filter((childId) => !nextPath.has(childId))
      .sort(compareTaskIds);
    const childResults = depth >= 64
      ? []
      : childIds.map((childId) => buildTaskNode(childId, nextPath, depth + 1));
    const children = childResults.map((child) => child.node);
    const descendantHasActiveProposal = childResults.some((child) => child.subtreeHasActiveProposal);
    const hasActiveProposal = task.hasProposal && !task.isCompleted;
    const subtreeHasActiveProposal = hasActiveProposal || descendantHasActiveProposal;
    const highlighted = !task.isCompleted && subtreeHasActiveProposal;
    const taskFileLink = `/task-files/${encodeURIComponent(task.id)}.md`;
    const proposalLink = task.proposalPath ? `/proposal.html?task=${encodeURIComponent(task.id)}` : null;

    return {
      node: {
        kind: "task",
        id: task.id,
        title: task.title || task.id,
        link: taskFileLink,
        proposalLink,
        priority: task.priority,
        status: task.status,
        hasProposal: hasActiveProposal,
        highlighted,
        children,
      },
      subtreeHasActiveProposal,
    };
  }

  const tasksByProject = new Map<string, string[]>();
  for (const task of tasks) {
    const project = projectByTask.get(task.id) ?? "(no project)";
    const ids = tasksByProject.get(project) ?? [];
    ids.push(task.id);
    tasksByProject.set(project, ids);
  }

  const projectNames = Array.from(tasksByProject.keys()).sort((a, b) => a.localeCompare(b));
  const forest: TasksTreeNode[] = [];

  for (const project of projectNames) {
    const ids = tasksByProject.get(project) ?? [];
    let rootIds = ids.filter((id) => {
      const parents = Array.from(parentsByTask.get(id) ?? []);
      return !parents.some((parentId) => (projectByTask.get(parentId) ?? "(no project)") === project);
    });

    if (rootIds.length === 0) rootIds = ids;
    rootIds.sort(compareTaskIds);

    const childResults = rootIds.map((id) => buildTaskNode(id, new Set<string>(), 0));
    const projectNode: TasksTreeNode = {
      kind: "project",
      id: `project:${project}`,
      title: project,
      link: null,
      proposalLink: null,
      priority: null,
      status: null,
      hasProposal: false,
      highlighted: childResults.some((child) => child.subtreeHasActiveProposal),
      children: childResults.map((child) => child.node),
    };
    forest.push(projectNode);
  }

  return forest;
}

// --- Generate notifications.json ---

function generateNotifications(): unknown[] {
  const logFile = join(harnessDir(), "journal", "notifications.jsonl");
  if (!existsSync(logFile)) return [];

  const lines = readFileSync(logFile, "utf-8").trim().split("\n");
  const recent = lines.slice(-50).reverse();
  const result: unknown[] = [];
  for (const line of recent) {
    try {
      result.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return result;
}

// --- Generate mag.json ---

function generateMag(): Record<string, unknown> {
  const harness = harnessDir();
  const queueFile = join(harness, "mag", "queue.jsonl");

  let pending = 0;
  if (existsSync(queueFile)) {
    const content = readFileSync(queueFile, "utf-8").trim();
    if (content) pending = content.split("\n").length;
  }

  // Check tmux session
  let status = "unknown";
  const config = loadConfigSync();
  const magSession = String((config.mag as Record<string, unknown> | undefined)?.session ?? "ludics-mag");
  const tmuxResult = Bun.spawnSync(["tmux", "has-session", "-t", magSession], { stdout: "pipe", stderr: "pipe" });
  if (tmuxResult.exitCode === 0) status = "running";

  // Get ttyd port for mag terminal
  const magPort = String((config.mag as Record<string, unknown> | undefined)?.ttyd_port ?? "7679");
  const terminal = getUrl(magPort);

  // Check for last activity
  let lastActivity: string | null = null;
  const resultsDir = join(harness, "mag", "results");
  if (existsSync(resultsDir)) {
    const files = readdirSync(resultsDir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => join(resultsDir, f));

    if (files.length > 0) {
      // Sort by mtime descending
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      try {
        const data = JSON.parse(readFileSync(files[0]!, "utf-8")) as Record<string, unknown>;
        if (data.timestamp) lastActivity = String(data.timestamp);
      } catch {
        // ignore
      }
    }
  }

  return {
    status,
    lastActivity,
    pendingRequests: pending,
    terminal: terminal || null,
  };
}

// --- Generate t3code.json ---

function generateT3code(): Record<string, unknown> {
  const record = readServerRecord();
  const webUrl = record ? getUrl(record.port) : null;

  // Check process state if we have a record
  if (record) {
    const inspection = inspectManagedServerProcess(record);
    if (inspection.alive && inspection.matchesRecord) {
      return { available: true, starting: false, webUrl };
    }
    if (inspection.alive && !inspection.matchesRecord) {
      // HTTP fallback would be needed for full accuracy, but this is synchronous
      // context — treat a mismatched PID as unavailable
    }
  }

  // Not running — check if ensureServer() has recently written a starting marker.
  // Only show "starting…" when there's actual evidence that a restart is in flight.
  const startingPath = t3codeStartingPath();
  if (existsSync(startingPath)) {
    try {
      const marker = JSON.parse(readFileSync(startingPath, "utf-8")) as { since?: string };
      if (marker.since) {
        const age = Date.now() - new Date(marker.since).getTime();
        if (age < 120_000) {
          return { available: false, starting: true, webUrl };
        }
      }
    } catch { /* malformed marker — ignore */ }
  }

  return { available: false, starting: false, webUrl };
}

// --- Generate ntfy.json ---

function generateNtfy(): Record<string, unknown> {
  const config = loadConfigSync();
  const ntfyConfig = config.notifications as Record<string, unknown> | undefined;
  const appUrl = String(ntfyConfig?.app_url ?? "https://ntfy.sh/app");
  return { appUrl };
}

// --- Generate recently-completed.json ---

interface RecentlyCompletedTask {
  id: string;
  title: string;
  completedAt: string;
  prUrl: string | null;
  prStatus: "merged" | "open" | "none";
  retrospectiveLink: string;
  proposalLink: string | null;
}

function generateRecentlyCompleted(tasks: DashboardTask[]): RecentlyCompletedTask[] {
  const harness = harnessDir();
  const retroDir = join(harness, "retrospectives");

  // Filter to completed tasks with retrospective files
  const completed = tasks.filter((t) => {
    if (!t.isCompleted || !t.completed) return false;
    return existsSync(join(retroDir, `${t.id}.json`));
  });

  // Sort by completion date descending, then id as tiebreaker
  completed.sort((a, b) => {
    const dateA = new Date(a.completed!).getTime();
    const dateB = new Date(b.completed!).getTime();
    if (dateB !== dateA) return dateB - dateA;
    return a.id.localeCompare(b.id);
  });

  // Filter to last 7 days, cap at 10
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = completed.filter((t) => {
    const ts = new Date(t.completed!).getTime();
    return ts >= sevenDaysAgo;
  });
  // If fewer than 10 within 7 days, still cap at 10
  const capped = recent.length >= 10 ? recent.slice(0, 10) : recent;

  // Derive PR status from events log
  const mergedTasks = new Set<string>();
  const eventsFile = join(harness, "journal", "events.jsonl");
  if (existsSync(eventsFile)) {
    try {
      const content = readFileSync(eventsFile, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.event_type === "pr_merged" && event.task) {
              mergedTasks.add(String(event.task));
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  // Also try to read PR URL from retrospective JSON
  const prUrls = new Map<string, string>();
  for (const t of capped) {
    const retroFile = join(retroDir, `${t.id}.json`);
    try {
      const data = JSON.parse(readFileSync(retroFile, "utf-8")) as Record<string, unknown>;
      if (data.prUrl && typeof data.prUrl === "string") {
        prUrls.set(t.id, data.prUrl);
      }
    } catch { /* skip */ }
  }

  return capped.map((t) => {
    // Only use the retrospective's prUrl — t.url is the GitHub issue URL, not a PR
    const prUrl = prUrls.get(t.id) ?? null;
    let prStatus: "merged" | "open" | "none" = "none";
    if (mergedTasks.has(t.id)) {
      prStatus = "merged";
    } else if (prUrl) {
      prStatus = "open";
    }

    return {
      id: t.id,
      title: t.title,
      completedAt: t.completed!,
      prUrl,
      prStatus,
      retrospectiveLink: `/retrospective.html?task=${encodeURIComponent(t.id)}`,
      proposalLink: t.hasProposal ? `/proposal.html?task=${encodeURIComponent(t.id)}` : null,
    };
  });
}

// --- Generate briefing.json ---

function generateBriefing(): Record<string, unknown> {
  const briefingFile = join(harnessDir(), "briefing.md");
  if (!existsSync(briefingFile)) {
    return { date: null, content: "", exists: false };
  }

  const content = readFileSync(briefingFile, "utf-8");
  let date: string | null = null;
  const dateMatch = content.match(/^# Briefing - (\d{4}-\d{2}-\d{2})/m);
  if (dateMatch) date = dateMatch[1]!;

  return { date, content, exists: true };
}

// --- Generate all ---

export function dashboardGenerate(): void {
  const dataDir = dashboardDataDir();
  mkdirSync(dataDir, { recursive: true });
  const tasks = readDashboardTasks();

  console.error("ludics: generating dashboard data...");

  writeFileSync(join(dataDir, "slots.json"), JSON.stringify(generateSlots(), null, 2));
  console.error("  slots.json");

  writeFileSync(join(dataDir, "ready.json"), JSON.stringify(generateReady(tasks), null, 2));
  console.error("  ready.json");

  writeFileSync(join(dataDir, "tasks-tree.json"), JSON.stringify(generateTasksTree(tasks), null, 2));
  console.error("  tasks-tree.json");

  writeFileSync(join(dataDir, "notifications.json"), JSON.stringify(generateNotifications(), null, 2));
  console.error("  notifications.json");

  writeFileSync(join(dataDir, "mag.json"), JSON.stringify(generateMag(), null, 2));
  console.error("  mag.json");

  writeFileSync(join(dataDir, "briefing.json"), JSON.stringify(generateBriefing(), null, 2));
  console.error("  briefing.json");

  writeFileSync(join(dataDir, "t3code.json"), JSON.stringify(generateT3code(), null, 2));
  console.error("  t3code.json");

  writeFileSync(join(dataDir, "ntfy.json"), JSON.stringify(generateNtfy(), null, 2));
  console.error("  ntfy.json");

  writeFileSync(join(dataDir, "recently-completed.json"), JSON.stringify(generateRecentlyCompleted(tasks), null, 2));
  console.error("  recently-completed.json");

  console.error(`ludics: dashboard data generated in ${dataDir}`);
}

// --- Serve ---

export function dashboardServe(port: number = 7678): void {
  const dashboardDir = join(harnessDir(), "dashboard");
  if (!existsSync(dashboardDir)) {
    throw new Error("dashboard not installed. Run: ludics dashboard install");
  }

  const config = loadConfigSync();
  const ttl = config.dashboard?.ttl ?? 5;

  // Generate initial data
  dashboardGenerate();

  console.error(`ludics: serving dashboard at ${getUrl(port)}`);

  // Use native Bun.serve() — no python3 dependency
  startDashboardServer(port, dashboardDir, ttl);
}

// --- Install ---

export function dashboardInstall(): void {
  // Use process.execPath — in compiled Bun binaries, process.argv[1] is virtual
  const rootDir = dirname(dirname(process.execPath));
  const templateDir = join(rootDir, "templates", "dashboard");
  const dashboardDir = join(harnessDir(), "dashboard");

  if (!existsSync(templateDir)) {
    throw new Error(`dashboard templates not found: ${templateDir}`);
  }

  console.error(`ludics: installing dashboard to ${dashboardDir}`);
  mkdirSync(dashboardDir, { recursive: true });

  // Copy template files recursively
  function copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  copyDir(templateDir, dashboardDir);
  mkdirSync(join(dashboardDir, "data"), { recursive: true });

  console.error("ludics: dashboard installed");
  console.error("  run: ludics dashboard generate");
  console.error("  then: ludics dashboard serve");
}

// --- CLI dispatch ---

export function dashboardStop(): void {
  try {
    const result = Bun.spawnSync(["pgrep", "-f", "ludics dashboard serve"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error("ludics: no dashboard server running");
      return;
    }
    const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
    const myPid = String(process.pid);
    let killed = 0;
    for (const pid of pids) {
      if (pid.trim() === myPid) continue;
      try {
        process.kill(parseInt(pid.trim(), 10), "SIGTERM");
        killed++;
      } catch { /* already dead */ }
    }
    if (killed > 0) {
      console.error(`ludics: stopped dashboard server (${killed} process${killed > 1 ? "es" : ""})`);
    } else {
      console.error("ludics: no dashboard server running");
    }
  } catch {
    console.error("ludics: failed to find dashboard server process");
  }
}

export async function runDashboard(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "generate":
      dashboardGenerate();
      break;
    case "serve": {
      let port: number;
      if (args[1]) {
        port = parseInt(args[1], 10);
      } else {
        const config = loadConfigSync();
        port = config.dashboard?.port ?? 7678;
      }
      dashboardServe(port);
      break;
    }
    case "install":
      dashboardInstall();
      break;
    case "stop":
      dashboardStop();
      break;
    case "restart": {
      dashboardStop();
      let port: number;
      if (args[1]) {
        port = parseInt(args[1], 10);
      } else {
        const config = loadConfigSync();
        port = config.dashboard?.port ?? 7678;
      }
      dashboardServe(port);
      break;
    }
    default:
      throw new Error(`unknown dashboard command: ${sub} (use: generate, serve, stop, restart, install)`);
  }
}
