// Dashboard — generate JSON data, serve, install

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";
import { harnessDir, loadConfigSync, slotsFilePath } from "./config.ts";
import { parseSlotBlocks, getField, getProcess, getTask, getMode } from "./slots/markdown.ts";
import { readStash } from "./slots/preempt.ts";
import { getUrl } from "./network.ts";
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
  phase: string | null;
  terminals: Record<string, string> | null;
  preempted: boolean;
  preemptedTask: string | null;
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

function generateSlots(): SlotJson[] {
  const slotsFile = slotsFilePath();
  if (!existsSync(slotsFile)) return [];

  const content = readFileSync(slotsFile, "utf-8");
  const blocks = parseSlotBlocks(content);
  const result: SlotJson[] = [];

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

    // Parse phase from Runtime section
    let phase: string | null = null;
    const phaseMatch = block.match(/^- Phase:\s*(.+)$/m);
    if (phaseMatch) phase = phaseMatch[1]!.trim();

    const taskId = empty ? null : getTask(block).trim() || null;
    const taskContent = taskId && taskId !== "null" ? lookupTaskContent(taskId) : null;

    // Check for preemption stash
    const stash = readStash(num);

    result.push({
      number: num,
      empty,
      process: empty ? null : process,
      task: taskId,
      taskContent,
      mode: empty ? null : getMode(block).trim() || null,
      started: empty ? null : getField(block, "Started").trim() || null,
      phase: empty ? null : phase,
      terminals: empty ? null : Object.keys(terminals).length > 0 ? terminals : null,
      preempted: stash !== null,
      preemptedTask: stash?.previousTask ?? null,
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
    const proposalLink = task.proposalPath ? `/proposal-files/${encodeURIComponent(task.id)}.md` : null;

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

  // Get ttyd port
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
    default:
      throw new Error(`unknown dashboard command: ${sub} (use: generate, serve, install)`);
  }
}
