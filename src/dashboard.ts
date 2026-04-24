// Dashboard — generate JSON data, serve, install

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";
import { isPlainObject } from "./json.ts";
import { safeSyncOutput } from "./spawn.ts";
import { globalAdapter, harnessDir, loadConfigSync, slotsCount, effectivePriorityValue, milestonesEnabledProjects } from "./config.ts";
import { readAllSlotJson } from "./slots/json.ts";
import type { SlotData } from "./slots/types.ts";
import { isRemoteMachine } from "./remote.ts";
import { clusterMachine } from "./cluster.ts";
import { priorityValue } from "./tasks/markdown.ts";
import { readStash } from "./slots/preempt.ts";
import { getUrl } from "./network.ts";
import { recentResults } from "./queue.ts";
import { inspectManagedServerProcess, processAlive, readServerRecord, readSlotState, t3codeStartingPath } from "./t3code/server.ts";
import { readTmuxSlotState } from "./adapters/tmux-adapter.ts";
import { readOrchestrationState } from "./orchestration/state.ts";
import { ludicsSelfCommand } from "./orchestration/util.ts";
import { startDashboardServer } from "./dashboard-server.ts";
import { clusterIsController, heartbeatIsFresh, clusterCurrentMachineName } from "./cluster.ts";
import { getIntentForDashboard } from "./cluster-http.ts";

function readSlotIntentForDashboard(slotNum: number): { action: string } | null {
  return getIntentForDashboard(slotNum);
}

function dashboardDataDir(): string {
  return join(harnessDir(), "dashboard", "data");
}

// Centralized URL builders for the dashboard's task/proposal link patterns.
// Every server- and client-side call site routes through these so the
// encoding choice (encodeURIComponent) and path shape (absolute, leading `/`)
// live in one place. Client-side mirrors live in templates/dashboard/links.js.
export function taskLink(id: string): string {
  return `/task.html?task=${encodeURIComponent(id)}`;
}

export function proposalLink(id: string): string {
  return `/proposal.html?task=${encodeURIComponent(id)}`;
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
  round: number | null;
  preempted: boolean;
  preemptedTask: string | null;
  hasProposal: boolean;
  proposalLink: string | null;
  prUrl: string | null;
  githubUrl: string | null;
  terminalLinks: Record<string, string> | null;
  effort: string | null;
  liveness: "alive" | "interrupted" | "escalated" | null;
  machine: string | null;
  /** Pending controller action for remote slots, derived from intent files. */
  pendingAction: "starting" | "stopping" | "resuming" | null;
  /** True when the assigned machine exists but is not online. */
  machineOffline: boolean;
}

export interface SlotLivenessContext {
  slotNum: number;
  mode: string | null;
  slotData?: SlotData;
}

export function computeSlotLiveness(ctx: SlotLivenessContext): "alive" | "interrupted" | "escalated" | null {
  const { slotNum, mode, slotData } = ctx;
  // Check explicit Liveness field from slot data (set by markSlotSetupFailed
  // or the runner's escalation halt).
  if (slotData) {
    const explicit = (slotData.liveness ?? "").trim();
    if (explicit === "escalated") return "escalated";
    if (explicit === "interrupted") return "interrupted";
  }
  if (!mode) return null;
  let orchPid: number | undefined;
  if (mode === "t3code") {
    const slotState = readSlotState(slotNum);
    orchPid = slotState?.orchestration?.pid;
  } else if (mode === "tmux") {
    const tmuxState = readTmuxSlotState(slotNum, harnessDir());
    orchPid = tmuxState?.orchestration?.pid;
  }
  if (orchPid !== undefined && orchPid > 0) {
    return processAlive(orchPid) ? "alive" : "interrupted";
  }
  return null;
}

interface TaskMetadata {
  content: string | null;
  githubUrl: string | null;
  effort: string | null;
  hasProposal: boolean;
}

function lookupTaskMetadata(taskId: string): TaskMetadata {
  const tasksDir = join(harnessDir(), "tasks");
  const taskFile = join(tasksDir, taskId + ".md");
  if (!existsSync(taskFile)) return { content: null, githubUrl: null, effort: null, hasProposal: false };
  let raw: string;
  try {
    raw = readFileSync(taskFile, "utf-8");
  } catch {
    return { content: null, githubUrl: null, effort: null, hasProposal: false };
  }
  // Body extraction never depends on YAML — do it before the YAML try/catch so
  // a malformed frontmatter block cannot lose the task body (regression guard).
  const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const content = body || null;
  try {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { content, githubUrl: null, effort: null, hasProposal: false };
    const data = (YAML.parse(fmMatch[1]!, { uniqueKeys: false }) ?? {}) as Record<string, unknown>;
    const urlVal = data.url;
    const githubUrl =
      urlVal && typeof urlVal === "string" && urlVal.trim() !== "" && urlVal.trim().toLowerCase() !== "null"
        ? urlVal.trim()
        : null;
    const effortVal = data.effort;
    const effort =
      effortVal && typeof effortVal === "string" && effortVal.trim() !== "" && effortVal.trim().toLowerCase() !== "null"
        ? effortVal.trim()
        : null;
    return { content, githubUrl, effort, hasProposal: hasNonNullProposal(data.proposal) };
  } catch {
    // YAML parse failed — return body but null out frontmatter-derived fields
    return { content, githubUrl: null, effort: null, hasProposal: false };
  }
}

function lookupSlotOrchestrationLinks(
  slotNum: number,
  t3codeWebUrl: string | null,
  currentTaskId: string | null,
  machineName: string | null,
): { prUrl: string | null; terminalLinks: Record<string, string> | null } {
  const orchState = readOrchestrationState(slotNum);
  if (!orchState) return { prUrl: null, terminalLinks: null };
  // Skip stale orchestration state from a previous task
  if (currentTaskId && orchState.taskId && orchState.taskId !== currentTaskId) {
    return { prUrl: null, terminalLinks: null };
  }

  // Extract first non-null PR URL from agent states
  let prUrl: string | null = null;
  for (const agentState of Object.values(orchState.agentStates)) {
    if (agentState.prUrl) {
      prUrl = agentState.prUrl;
      break;
    }
  }

  // Build agent links — t3code threads or tmux ttyd URLs
  let terminalLinks: Record<string, string> | null = null;
  if (orchState.backend === "tmux") {
    // Generate ttyd URLs for each agent
    const host = (machineName && clusterMachine(machineName)?.host) || machineName;
    if (host) {
      terminalLinks = {};
      for (const agent of orchState.agents) {
        const roleIndex = agent.role === "reviewer" ? 1 : 0;
        const port = 7681 + (orchState.slot - 1) * 2 + roleIndex;
        terminalLinks[agent.name] = `http://${host}:${port}`;
      }
    }
  } else if (t3codeWebUrl && orchState.threadIds && Object.keys(orchState.threadIds).length > 0) {
    terminalLinks = {};
    for (const [agentName, threadId] of Object.entries(orchState.threadIds)) {
      terminalLinks[agentName] = `${t3codeWebUrl}/${encodeURIComponent(threadId)}`;
    }
    if (Object.keys(terminalLinks).length === 0) terminalLinks = null;
  }

  return { prUrl, terminalLinks };
}

function generateSlots(): SlotJson[] {
  const count = slotsCount();
  const blocks = readAllSlotJson(count);
  const result: SlotJson[] = [];

  // Resolve t3code web URL once for all slots
  const t3codeRecord = readServerRecord();
  const t3codeWebUrl = t3codeRecord ? t3codeRecord.webUrl : null;

  for (const [num, data] of blocks) {
    const process = data.process;
    const empty = !process || process === "(empty)";

    const taskId = empty ? null : (data.task ?? "") || null;

    // Parse phase: prefer orchestration state JSON (authoritative), fall back to Runtime section in slot data
    let phase: string | null = null;
    let round: number | null = null;
    if (!empty) {
      const orchState = readOrchestrationState(num);
      if (orchState && (!taskId || orchState.taskId === taskId)) {
        phase = orchState.phase ?? null;
        round = orchState.round ?? null;
      }
    }
    if (!phase) {
      const runtimeMatch = data.runtime?.match(/^- Phase:\s*(.+)$/m);
      if (runtimeMatch) phase = runtimeMatch[1]!.trim();
    }
    const taskMeta = taskId
      ? lookupTaskMetadata(taskId)
      : { content: null, githubUrl: null, effort: null, hasProposal: false };
    const taskContent = taskMeta.content;
    const taskEffort = taskMeta.effort;
    const slotHasProposal = taskMeta.hasProposal;
    const slotProposalLink = slotHasProposal && taskId ? proposalLink(taskId) : null;
    const githubUrl = taskMeta.githubUrl;

    const machineName = data.machine ?? "";

    // Read orchestration state for PR URL and terminal links.
    // Only use the state if its feature matches the slot's current task
    // to avoid showing stale links from a previous task.
    const orchLinks = empty ? { prUrl: null, terminalLinks: null }
      : lookupSlotOrchestrationLinks(num, t3codeWebUrl, taskId, machineName || null);

    // Fallback for adapters that don't maintain orchestration state
    // (e.g. agent-claude/agent-codex solo sessions): parse URL-valued
    // entries from the slot record's Terminals markdown. Status strings
    // like "ttyd pid N (alive)" are filtered out — the URL guard keeps
    // the shadow-label path dead.
    let terminalLinks = orchLinks.terminalLinks;
    if (!empty && terminalLinks == null && data.terminals) {
      const fallback: Record<string, string> = {};
      for (const line of data.terminals.split("\n")) {
        const m = line.match(/^- ([^:]+):\s*(.+)$/);
        if (!m) continue;
        const value = m[2]!.trim();
        if (value.startsWith("http://") || value.startsWith("https://")) {
          fallback[m[1]!.trim()] = value;
        }
      }
      if (Object.keys(fallback).length > 0) terminalLinks = fallback;
    }

    // Check for preemption stash
    const stash = readStash(num);

    const rawSessionStarted = data.sessionStarted ?? "";
    const sessionStarted = rawSessionStarted ? rawSessionStarted : null;

    // Compute liveness — for local slots use PID check, for remote slots use heartbeat.
    let liveness: "alive" | "interrupted" | "escalated" | null = null;
    if (!empty) {
      const explicitLiveness = (data.liveness ?? "").trim();
      const shouldCheck = (phase && phase !== "done")
        || explicitLiveness === "interrupted"
        || explicitLiveness === "escalated";
      if (shouldCheck) {
        if (!machineName || !isRemoteMachine(machineName)) {
          liveness = computeSlotLiveness({ slotNum: num, mode: (data.mode ?? "") || null, slotData: data });
        } else if (explicitLiveness === "escalated") {
          // Remote escalation marker propagates via git-sync of the slot json;
          // the user's resume on the owning node is the only clearing path.
          liveness = "escalated";
        } else {
          // Remote slot: use heartbeat freshness as liveness proxy
          liveness = heartbeatIsFresh(machineName) ? "alive" : "interrupted";
        }
      }
    }

    const machine = machineName || null;

    // Pending controller action derived from intent files
    let pendingAction: "starting" | "stopping" | "resuming" | null = null;
    if (!empty && machine) {
      const intent = readSlotIntentForDashboard(num);
      if (intent) {
        const actionMap: Record<string, "starting" | "stopping" | "resuming"> = { start: "starting", stop: "stopping", resume: "resuming" };
        pendingAction = actionMap[intent.action] ?? null;
      }
    }

    result.push({
      number: num,
      empty,
      process: empty ? null : process,
      task: taskId,
      taskContent,
      mode: empty ? null : (data.mode ?? "") || null,
      started: empty ? null : (data.started ?? "") || null,
      sessionStarted: empty ? null : sessionStarted,
      phase: empty ? null : phase,
      round: empty ? null : round,
      preempted: stash !== null,
      preemptedTask: stash?.previousTask ?? null,
      hasProposal: slotHasProposal,
      proposalLink: slotProposalLink,
      prUrl: empty ? null : orchLinks.prUrl,
      githubUrl: empty ? null : githubUrl,
      terminalLinks: empty ? null : terminalLinks,
      effort: taskEffort,
      liveness,
      machine,
      pendingAction,
      machineOffline: !empty && !!machine && isRemoteMachine(machine) && !heartbeatIsFresh(machine),
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
  effort: string | null;
}

interface DashboardTask {
  id: string;
  title: string;
  project: string;
  status: string;
  priority: string;
  context: string;
  deadline: string | null;
  effort: string | null;
  milestone: string | null;
  created: string | null;
  completed: string | null;
  isCompleted: boolean;
  url: string | null;
  hasProposal: boolean;
  proposalPath: string | null;
  mtime: string | null;
  hasRetrospective: boolean;
  dependencies: {
    blocks: string[];
    blocked_by: string[];
    relates_to: string[];
    subtask_of: string | null;
  };
  hasQuestions: boolean;
}

interface FilteredTaskTileConfig {
  filter: (task: DashboardTask) => boolean;
  extraFields: (task: DashboardTask) => Record<string, unknown>;
  sort?: (a: DashboardTask, b: DashboardTask) => number;
}

interface TasksTreeNode {
  kind: "project" | "task";
  id: string;
  title: string;
  link: string | null;
  proposalLink: string | null;
  retroLink: string | null;
  priority: string | null;
  status: string | null;
  hasProposal: boolean;
  highlighted: boolean;
  mtime: string | null;
  children: TasksTreeNode[];
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

  const retroDir = join(harnessDir(), "retrospectives");
  for (const f of files) {
    const filePath = join(tasksDir, f);
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    try {
      const data = YAML.parse(fmMatch[1]!, { uniqueKeys: false }) as Record<string, unknown>;
      const deps = (data.dependencies as Record<string, unknown>) ?? {};
      const id = String(data.id ?? "");
      if (!id) continue;
      const fileMtime = statSync(filePath).mtime.toISOString();
      const isCompleted = isNonNullValue(data.completed);
      const hasRetrospective = isCompleted && existsSync(join(retroDir, `${id}.json`));
      tasks.push({
        id,
        title: String(data.title ?? ""),
        status: String(data.status ?? "ready"),
        priority: String(data.priority ?? "B"),
        project: String(data.project ?? ""),
        context: String(data.context ?? ""),
        deadline: data.deadline ? String(data.deadline) : null,
        effort: isNonNullValue(data.effort) ? String(data.effort).trim() : null,
        milestone: isNonNullValue(data.milestone) ? String(data.milestone).trim() : null,
        created: isNonNullValue(data.created) ? String(data.created) : null,
        completed: isNonNullValue(data.completed) ? String(data.completed) : null,
        isCompleted,
        url: data.url ? String(data.url) : null,
        hasProposal: hasNonNullProposal(data.proposal),
        proposalPath: isNonNullValue(data.proposal) ? String(data.proposal).trim() : null,
        mtime: fileMtime,
        hasRetrospective,
        dependencies: {
          blocks: Array.isArray(deps.blocks) ? (deps.blocks as string[]) : [],
          blocked_by: Array.isArray(deps.blocked_by) ? (deps.blocked_by as string[]) : [],
          relates_to: Array.isArray(deps.relates_to) ? (deps.relates_to as string[]) : [],
          subtask_of: isNonNullValue(deps.subtask_of) ? String(deps.subtask_of) : null,
        },
        hasQuestions: !!data.has_questions,
      });
    } catch {
      // skip
    }
  }

  return tasks;
}

function generateReady(tasks: DashboardTask[]): ReadyTask[] {
  // Exclude tasks already assigned to a slot (status may lag due to state-sync races)
  const slottedIds = new Set<string>();
  const slots = readAllSlotJson(slotsCount());
  for (const [, data] of slots) {
    if (data.task) slottedIds.add(data.task);
  }

  const ready: ReadyTask[] = tasks
    .filter((task) => task.status === "ready" && !slottedIds.has(task.id) && task.dependencies.blocked_by.length === 0)
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      project: task.project,
      context: task.context,
      deadline: task.deadline,
      effort: task.effort,
      milestone: task.milestone,
    }));

  // Sort using the same logic as flow.ts: milestone position → priority → deadline
  const milestonesProjects = milestonesEnabledProjects();
  const anyMilestones = milestonesProjects.size > 0;

  const milestonePosition = new Map<string, number>();
  if (anyMilestones) {
    const projectMilestones = new Map<string, Set<string>>();
    for (const t of tasks) {
      if (t.status !== "ready") continue;
      if (!milestonesProjects.has(t.project) || !t.milestone) continue;
      let ms = projectMilestones.get(t.project);
      if (!ms) { ms = new Set(); projectMilestones.set(t.project, ms); }
      ms.add(t.milestone);
    }
    for (const [project, ms] of projectMilestones) {
      const sorted = [...ms].sort();
      for (let i = 0; i < sorted.length; i++) {
        milestonePosition.set(`${project}\0${sorted[i]}`, i);
      }
    }
  }
  function relMilestonePos(t: { milestone?: string; project: string }): number {
    if (!t.milestone || !milestonesProjects.has(t.project)) return 0;
    return milestonePosition.get(`${t.project}\0${t.milestone}`) ?? 0;
  }

  ready.sort((a, b) => {
    const mp = relMilestonePos(a) - relMilestonePos(b);
    if (mp !== 0) return mp;
    const pd = effectivePriorityValue(a.priority, a.project) - effectivePriorityValue(b.priority, b.project);
    if (pd !== 0) return pd;
    return (a.deadline ?? "9999-99-99").localeCompare(b.deadline ?? "9999-99-99");
  });

  return ready;
}

function generateFilteredTaskList(tasks: DashboardTask[], config: FilteredTaskTileConfig): Record<string, unknown>[] {
  const filtered = tasks.filter(config.filter);
  if (config.sort) filtered.sort(config.sort);
  return filtered.map((task) => ({
    id: task.id,
    title: task.title,
    project: task.project,
    priority: task.priority,
    ...config.extraFields(task),
  }));
}

const byCreatedDescNullLast = (a: DashboardTask, b: DashboardTask): number =>
  (b.created ?? "").localeCompare(a.created ?? "");

const needsConfirmationConfig: FilteredTaskTileConfig = {
  filter: (task) => task.status === "needs-confirmation",
  extraFields: (task) => ({ created: task.created, relatesTo: task.dependencies.relates_to }),
  sort: byCreatedDescNullLast,
};

const unansweredQuestionsConfig: FilteredTaskTileConfig = {
  filter: (task) => task.hasQuestions && !task.isCompleted,
  extraFields: () => ({}),
};

const deferredLaunchConfig: FilteredTaskTileConfig = {
  filter: (task) => task.status === "deferred",
  extraFields: (task) => ({
    created: task.created,
    hasProposal: task.hasProposal,
    proposalPath: task.proposalPath,
  }),
  sort: byCreatedDescNullLast,
};

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
        retroLink: null,
        priority: null,
        status: null,
        hasProposal: false,
        highlighted: false,
        mtime: null,
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
    const taskFileLink = taskLink(task.id);
    const taskProposalLink = task.proposalPath ? proposalLink(task.id) : null;
    const retroLink = task.hasRetrospective ? `retrospective.html?task=${encodeURIComponent(task.id)}` : null;

    return {
      node: {
        kind: "task",
        id: task.id,
        title: task.title || task.id,
        link: taskFileLink,
        proposalLink: taskProposalLink,
        retroLink,
        priority: task.priority,
        status: task.status,
        hasProposal: hasActiveProposal,
        highlighted,
        mtime: task.mtime,
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
      retroLink: null,
      priority: null,
      status: null,
      hasProposal: false,
      highlighted: childResults.some((child) => child.subtreeHasActiveProposal),
      mtime: null,
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
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result.push(parsed);
      }
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
  if (safeSyncOutput(["tmux", "has-session", "-t", magSession]).ok) status = "running";

  // Get ttyd port for mag terminal
  const magPort = String((config.mag as Record<string, unknown> | undefined)?.ttyd_port ?? "7679");
  const terminal = getUrl(magPort);

  // Check for last activity
  let lastActivity: string | null = null;
  try {
    const recentRes = recentResults(1);
    if (recentRes.length > 0 && recentRes[0]!.data.timestamp) {
      lastActivity = String(recentRes[0]!.data.timestamp);
    }
  } catch {
    // ignore — malformed result files should not break dashboard
  }

  // Check queue hold state
  const queueHeld = existsSync(join(harness, "mag", "queue-hold"));

  return {
    status,
    lastActivity,
    pendingRequests: pending,
    terminal: terminal || null,
    queueHeld,
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
      const parsed: unknown = JSON.parse(readFileSync(startingPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const marker = parsed as { since?: string };
        if (marker.since) {
          const age = Date.now() - new Date(marker.since).getTime();
          if (age < 120_000) {
            return { available: false, starting: true, webUrl };
          }
        }
      }
    } catch { /* malformed marker — ignore */ }
  }

  return { available: false, starting: false, webUrl };
}

// --- Generate adapter.json ---

function generateAdapter(): Record<string, unknown> {
  const adapter = globalAdapter();
  if (adapter === "tmux") {
    return { adapter: "tmux", t3codeAvailable: false, t3codeWebUrl: null };
  }
  // t3code mode — check server availability
  const record = readServerRecord();
  const webUrl = record ? getUrl(record.port) : null;
  let t3codeAvailable = false;
  if (record) {
    const inspection = inspectManagedServerProcess(record);
    t3codeAvailable = inspection.alive && inspection.matchesRecord;
  }
  return { adapter: "t3code", t3codeAvailable, t3codeWebUrl: webUrl };
}

// --- Generate terminals.json ---

function generateTerminals(): Record<string, unknown> {
  const activeSlots: number[] = [];
  const slotMachines: Map<number, string> = new Map();

  const blocks = readAllSlotJson(slotsCount());
  for (const [num, data] of blocks) {
    const mode = data.mode ?? "";
    const sessionStarted = data.sessionStarted ?? "";
    if (mode === "tmux" && sessionStarted) {
      activeSlots.push(num);
      const machine = data.machine ?? "";
      const host = (machine && clusterMachine(machine)?.host) || machine;
      if (host) slotMachines.set(num, host);
    }
  }

  const terminals: { slot: number; role: string; port: number; host: string; active: boolean }[] = [];
  for (let slot = 1; slot <= 6; slot++) {
    const slotActive = activeSlots.includes(slot);
    const host = slotMachines.get(slot);
    if (!host) continue;
    for (const role of ["coder", "reviewer"]) {
      const roleIndex = role === "reviewer" ? 1 : 0;
      const port = 7681 + (slot - 1) * 2 + roleIndex;
      terminals.push({ slot, role, port, host, active: slotActive });
    }
  }

  return { terminals, activeSlots };
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
            const parsed: unknown = JSON.parse(line);
            if (!isPlainObject(parsed)) continue;
            if (parsed.event_type === "pr_merged" && parsed.task) {
              mergedTasks.add(String(parsed.task));
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
      const parsed: unknown = JSON.parse(readFileSync(retroFile, "utf-8"));
      if (!isPlainObject(parsed)) continue;
      if (parsed.prUrl && typeof parsed.prUrl === "string") {
        prUrls.set(t.id, parsed.prUrl);
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
      proposalLink: t.hasProposal ? proposalLink(t.id) : null,
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

// --- Generate health.json ---

let doctorCache: { output: string; timestamp: string; cachedAt: number } | null = null;
const DOCTOR_CACHE_TTL = 300_000; // 5 minutes

/** Exported for testing; resets the doctor subprocess cache. */
export function _resetDoctorCache(): void {
  doctorCache = null;
}

export function generateHealthData(): Record<string, unknown> {
  const reportFile = join(harnessDir(), "mag", "health-report.md");
  let healthReport: Record<string, unknown>;
  if (existsSync(reportFile)) {
    const content = readFileSync(reportFile, "utf-8");
    let date: string | null = null;
    const dateMatch = content.match(/^# Health Check - (.+)$/m);
    if (dateMatch) date = dateMatch[1]!;
    healthReport = { exists: true, content, date };
  } else {
    healthReport = { exists: false, content: "", date: null };
  }

  const now = Date.now();
  if (!doctorCache || now - doctorCache.cachedAt > DOCTOR_CACHE_TTL) {
    const result = safeSyncOutput(ludicsSelfCommand(["doctor"]), { timeout: 10_000 });
    let output: string;
    if (result.ok) {
      output = result.stdout;
    } else {
      const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
      output = "Doctor check failed" + (details ? `\n${details}` : "");
    }
    doctorCache = {
      output,
      timestamp: new Date().toISOString(),
      cachedAt: now,
    };
  }

  return {
    healthReport,
    doctor: { output: doctorCache.output, timestamp: doctorCache.timestamp },
  };
}

// --- Generate all ---

export function dashboardGenerate(): void {
  const dataDir = dashboardDataDir();
  mkdirSync(dataDir, { recursive: true });
  const tasks = readDashboardTasks();

  console.error("ludics: generating dashboard data...");

  const meta = { controllerMachine: clusterCurrentMachineName() ?? null };
  writeFileSync(join(dataDir, "meta.json"), JSON.stringify(meta, null, 2));
  console.error("  meta.json");

  writeFileSync(join(dataDir, "slots.json"), JSON.stringify(generateSlots(), null, 2));
  console.error("  slots.json");

  writeFileSync(join(dataDir, "ready.json"), JSON.stringify(generateReady(tasks), null, 2));
  console.error("  ready.json");

  writeFileSync(join(dataDir, "needs-confirmation.json"), JSON.stringify(generateFilteredTaskList(tasks, needsConfirmationConfig), null, 2));
  console.error("  needs-confirmation.json");

  writeFileSync(join(dataDir, "unanswered-questions.json"), JSON.stringify(generateFilteredTaskList(tasks, unansweredQuestionsConfig), null, 2));
  console.error("  unanswered-questions.json");

  writeFileSync(join(dataDir, "deferred-launch.json"), JSON.stringify(generateFilteredTaskList(tasks, deferredLaunchConfig), null, 2));
  console.error("  deferred-launch.json");

  writeFileSync(join(dataDir, "tasks-tree.json"), JSON.stringify(generateTasksTree(tasks), null, 2));
  console.error("  tasks-tree.json");

  writeFileSync(join(dataDir, "notifications.json"), JSON.stringify(generateNotifications(), null, 2));
  console.error("  notifications.json");

  writeFileSync(join(dataDir, "mag.json"), JSON.stringify(generateMag(), null, 2));
  console.error("  mag.json");

  writeFileSync(join(dataDir, "briefing.json"), JSON.stringify(generateBriefing(), null, 2));
  console.error("  briefing.json");

  writeFileSync(join(dataDir, "health.json"), JSON.stringify(generateHealthData(), null, 2));
  console.error("  health.json");

  writeFileSync(join(dataDir, "t3code.json"), JSON.stringify(generateT3code(), null, 2));
  console.error("  t3code.json");

  writeFileSync(join(dataDir, "adapter.json"), JSON.stringify(generateAdapter(), null, 2));
  console.error("  adapter.json");

  writeFileSync(join(dataDir, "terminals.json"), JSON.stringify(generateTerminals(), null, 2));
  console.error("  terminals.json");

  writeFileSync(join(dataDir, "ntfy.json"), JSON.stringify(generateNtfy(), null, 2));
  console.error("  ntfy.json");

  writeFileSync(join(dataDir, "recently-completed.json"), JSON.stringify(generateRecentlyCompleted(tasks), null, 2));
  console.error("  recently-completed.json");

  console.error(`ludics: dashboard data generated in ${dataDir}`);
}

// --- Serve ---

export function dashboardServe(port: number = 7678): void {
  if (!clusterIsController()) {
    console.error("ludics: dashboard serve skipped — not the cluster controller");
    return;
  }
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
    const result = safeSyncOutput(["pgrep", "-f", "ludics dashboard serve"]);
    if (!result.ok) {
      console.error("ludics: no dashboard server running");
      return;
    }
    const pids = result.stdout.split("\n").filter(Boolean);
    const myPid = String(process.pid);
    const targetPids: number[] = [];
    for (const pid of pids) {
      if (pid.trim() === myPid) continue;
      const n = parseInt(pid.trim(), 10);
      try {
        process.kill(n, "SIGTERM");
        targetPids.push(n);
      } catch { /* already dead */ }
    }
    if (targetPids.length === 0) {
      console.error("ludics: no dashboard server running");
      return;
    }
    // Wait for processes to die, escalate to SIGKILL
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const alive = targetPids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
      if (alive.length === 0) break;
      Bun.sleepSync(100);
    }
    for (const p of targetPids) {
      try { process.kill(p, "SIGKILL"); } catch { /* already dead */ }
    }
    // Wait for port to free
    Bun.sleepSync(500);
    console.error(`ludics: stopped dashboard server (${targetPids.length} process${targetPids.length > 1 ? "es" : ""})`);
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
