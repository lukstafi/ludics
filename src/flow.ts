// Flow engine — priority/dependency-based views of tasks

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { harnessDir, slotsFilePath, effectivePriority, effectivePriorityValue, milestonesEnabledProjects, milestoneKey } from "./config.ts";
import { buildAffinityLookup, type AffinityInput } from "./tasks/affinity.ts";

interface TaskData {
  id: string;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  started: string | null;
  completed: string | null;
  modified: string | null;
  project: string;
  context: string;
  milestone?: string;
  dependencies: { blocks?: string[]; blocked_by?: string[]; relates_to?: string[]; subtask_of?: string | null };
  _file: string;
}

function tasksDir(): string {
  return join(harnessDir(), "tasks");
}

function collectTasks(): TaskData[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
  const tasks: TaskData[] = [];

  for (const f of files) {
    const filePath = join(dir, f);
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    try {
      const data = YAML.parse(fmMatch[1]!, { uniqueKeys: false }) as Record<string, unknown>;
      const deps = (data.dependencies as Record<string, unknown>) ?? {};
      tasks.push({
        id: String(data.id ?? ""),
        title: String(data.title ?? ""),
        status: String(data.status ?? "ready"),
        priority: String(data.priority ?? "B"),
        deadline: data.deadline ? String(data.deadline) : null,
        started: data.started ? String(data.started) : null,
        completed: data.completed ? String(data.completed) : null,
        modified: data.modified ? String(data.modified) : null,
        project: String(data.project ?? ""),
        context: String(data.context ?? ""),
        milestone: data.milestone ? String(data.milestone) : undefined,
        dependencies: {
          blocks: Array.isArray(deps.blocks) ? (deps.blocks as string[]) : [],
          blocked_by: Array.isArray(deps.blocked_by) ? (deps.blocked_by as string[]) : [],
          relates_to: Array.isArray(deps.relates_to) ? (deps.relates_to as string[]) : [],
          subtask_of: deps.subtask_of ? String(deps.subtask_of) : null,
        },
        _file: filePath,
      });
    } catch {
      // skip unparseable files
    }
  }

  return tasks;
}

function checkCycle(tasks: TaskData[]): boolean {
  // Build adjacency list: for each "X blocked_by Y" we have edge Y -> X
  const edges: [string, string][] = [];
  for (const t of tasks) {
    const blockedBy = t.dependencies.blocked_by ?? [];
    for (const dep of blockedBy) {
      edges.push([dep, t.id]);
    }
  }

  if (edges.length === 0) return false; // no cycle

  // Topological sort via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const [from, to] of edges) {
    allNodes.add(from);
    allNodes.add(to);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    if (!inDegree.has(from)) inDegree.set(from, 0);
  }

  const queue: string[] = [];
  for (const node of allNodes) {
    if ((inDegree.get(node) ?? 0) === 0) queue.push(node);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of (adj.get(node) ?? [])) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  return visited < allNodes.size; // cycle exists if not all visited
}

function readSlottedTaskIds(): Set<string> {
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return new Set();
  const content = readFileSync(sFile, "utf-8");
  const ids = new Set<string>();
  const re = /^\*\*Task:\*\*\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = m[1]!.trim();
    if (id && id !== "(empty)" && id !== "null") ids.add(id);
  }
  return ids;
}

export function flowReady(): void {
  const tasks = collectTasks();

  if (checkCycle(tasks)) {
    console.error("ludics: dependency cycle detected in tasks");
  }

  // Pre-compute milestones-enabled project set to avoid repeated config reads
  const milestonesProjects = milestonesEnabledProjects();
  const anyMilestones = milestonesProjects.size > 0;

  // Build affinity lookup once for tie-breaking
  const slottedIds = readSlottedTaskIds();
  const affinityInputs: AffinityInput[] = tasks.map((t) => ({
    id: t.id,
    status: t.status,
    completed: t.completed,
    dependencies: {
      blocks: t.dependencies.blocks ?? [],
      blocked_by: t.dependencies.blocked_by ?? [],
      relates_to: t.dependencies.relates_to ?? [],
    },
  }));
  const affinity = buildAffinityLookup(affinityInputs, slottedIds);

  const ready = tasks
    .filter(
      (t) =>
        t.status === "ready" &&
        !slottedIds.has(t.id) &&
        (!t.dependencies.blocked_by || t.dependencies.blocked_by.length === 0),
    );

  // Compute relative milestone positions per project (same logic as maybeFillEmptySlots)
  const milestonePosition = new Map<string, number>();
  if (anyMilestones) {
    const projectMilestones = new Map<string, Set<string>>();
    for (const c of ready) {
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

  function relMilestonePos(t: { milestone?: string; project: string }): number {
    if (!t.milestone || !milestonesProjects.has(t.project)) return 0;
    return milestonePosition.get(`${t.project}\0${t.milestone}`) ?? 0;
  }

  ready.sort((a, b) => {
      // Relative milestone position (globally comparable, 0 = earliest/no milestone)
      const mp = relMilestonePos(a) - relMilestonePos(b);
      if (mp !== 0) return mp;
      // Effective priority (with focus project boost)
      const pDiff = effectivePriorityValue(a.priority, a.project) - effectivePriorityValue(b.priority, b.project);
      if (pDiff !== 0) return pDiff;
      const tDiff = affinity.getTier(a.id) - affinity.getTier(b.id);
      if (tDiff !== 0) return tDiff;
      const aHas = a.deadline ? 1 : 2;
      const bHas = b.deadline ? 1 : 2;
      if (aHas !== bHas) return aHas - bHas;
      return (a.deadline ?? "9999-99-99").localeCompare(b.deadline ?? "9999-99-99");
    });

  if (ready.length === 0) {
    console.log("No ready tasks");
  } else {
    for (const t of ready) {
      // Show virtual priority when a focus project is configured (for transparency)
      const displayPri = effectivePriority(t.priority, t.project);
      // Show milestone alongside priority when milestones are enabled for this task's project
      const milestoneDisplay = anyMilestones && milestonesProjects.has(t.project)
        ? ` [${t.milestone ?? "no milestone"}]`
        : "";
      console.log(`${t.id} (${displayPri})${milestoneDisplay} ${t.title}`);
    }
  }
}

export function flowBlocked(): void {
  const tasks = collectTasks();

  const blocked = tasks
    .filter((t) => t.dependencies.blocked_by && t.dependencies.blocked_by.length > 0)
    .sort((a, b) => (a.priority ?? "Z").localeCompare(b.priority ?? "Z"));

  if (blocked.length === 0) {
    console.log("No blocked tasks");
  } else {
    for (const t of blocked) {
      console.log(`${t.id} blocked by: ${t.dependencies.blocked_by!.join(", ")}`);
    }
  }
}

export function flowCritical(): void {
  const tasks = collectTasks();
  const nowEpoch = Math.floor(Date.now() / 1000);

  // Approaching deadlines (within 30 days)
  console.log("=== Approaching Deadlines (within 30 days) ===");
  const withDeadline = tasks
    .filter(
      (t) =>
        t.deadline &&
        t.status !== "done" &&
        t.status !== "abandoned" &&
        t.status !== "merged",
    )
    .map((t) => {
      const deadlineEpoch = new Date(t.deadline!).getTime() / 1000;
      const daysLeft = Math.floor((deadlineEpoch - nowEpoch) / 86400);
      return { ...t, daysLeft };
    })
    .filter((t) => t.daysLeft >= 0 && t.daysLeft <= 30)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  if (withDeadline.length === 0) {
    console.log("(none)");
  } else {
    for (const t of withDeadline) {
      console.log(`${t.id} - ${t.daysLeft} days - ${t.title}`);
    }
  }

  // High-priority ready (A)
  console.log("");
  console.log("=== High-Priority Ready (priority A) ===");
  const highPriReady = tasks.filter(
    (t) =>
      t.status === "ready" &&
      t.priority === "A" &&
      (!t.dependencies.blocked_by || t.dependencies.blocked_by.length === 0),
  );

  if (highPriReady.length === 0) {
    console.log("(none)");
  } else {
    for (const t of highPriReady) {
      console.log(`${t.id} - ${t.title}`);
    }
  }
}

export function flowImpact(taskId: string): void {
  if (!taskId) throw new Error("task id required");

  const tasks = collectTasks();

  // Tasks that have this task in their blocked_by
  const directUnblocks = tasks.filter(
    (t) =>
      t.dependencies.blocked_by &&
      t.dependencies.blocked_by.includes(taskId),
  );

  console.log(`=== Direct Unblocks (immediately ready if ${taskId} completes) ===`);
  const immediatelyReady = directUnblocks.filter(
    (t) => t.dependencies.blocked_by!.length === 1,
  );
  if (immediatelyReady.length === 0) {
    console.log("(none)");
  } else {
    for (const t of immediatelyReady) {
      console.log(`${t.id} - ${t.title}`);
    }
  }

  console.log("");
  console.log("=== Partial Unblocks (still has other blockers) ===");
  const partialUnblocks = directUnblocks.filter(
    (t) => t.dependencies.blocked_by!.length > 1,
  );
  if (partialUnblocks.length === 0) {
    console.log("(none)");
  } else {
    for (const t of partialUnblocks) {
      const remaining = t.dependencies.blocked_by!.filter((d) => d !== taskId);
      console.log(`${t.id} - still blocked by: ${remaining.join(", ")}`);
    }
  }

  // Related tasks
  const related = tasks.filter(
    (t) => t.dependencies.relates_to && t.dependencies.relates_to.includes(taskId),
  );
  if (related.length > 0) {
    console.log("");
    console.log("=== Related Tasks ===");
    for (const t of related) {
      console.log(`${t.id} - ${t.title}`);
    }
  }

  // Subtasks
  const subtasks = tasks.filter(
    (t) => t.dependencies.subtask_of === taskId,
  );
  if (subtasks.length > 0) {
    console.log("");
    console.log("=== Subtasks ===");
    for (const t of subtasks) {
      console.log(`${t.id} (${t.status}) - ${t.title}`);
    }
  }
}

export function flowContext(): void {
  const slotsFile = slotsFilePath();
  if (!existsSync(slotsFile)) {
    throw new Error(`slots file not found: ${slotsFile}`);
  }

  const tasks = collectTasks();
  const slotsContent = readFileSync(slotsFile, "utf-8");

  // Extract active task IDs from slots
  const activeTaskIds: string[] = [];
  const taskRegex = /^\*\*Task:\*\*\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = taskRegex.exec(slotsContent)) !== null) {
    const taskId = match[1]!.trim();
    if (taskId && taskId !== "(empty)" && taskId !== "null") {
      activeTaskIds.push(taskId);
    }
  }

  console.log("=== Context Distribution ===");

  if (activeTaskIds.length === 0) {
    console.log("No active slots");
    return;
  }

  const contextCounts = new Map<string, number>();
  for (const taskId of activeTaskIds) {
    const task = tasks.find((t) => t.id === taskId);
    const ctx = task?.context || "untagged";
    console.log(`  ${taskId}: ${ctx}`);
    contextCounts.set(ctx, (contextCounts.get(ctx) ?? 0) + 1);
  }

  console.log("");
  console.log("=== Context Summary ===");
  const sorted = [...contextCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ctx, count] of sorted) {
    console.log(`  ${ctx}: ${count} slot(s)`);
  }
}

export function flowCheckCycle(): void {
  const tasks = collectTasks();
  if (checkCycle(tasks)) {
    console.log("Dependency cycle detected!");
    process.exit(1);
  } else {
    console.log("No dependency cycles detected");
  }
}

export async function runFlow(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "ready":
      flowReady();
      break;
    case "blocked":
      flowBlocked();
      break;
    case "critical":
      flowCritical();
      break;
    case "impact":
      flowImpact(args[1] ?? "");
      break;
    case "context":
      flowContext();
      break;
    case "check-cycle":
      flowCheckCycle();
      break;
    default:
      throw new Error(`unknown flow command: ${sub} (use: ready, blocked, critical, impact, context, check-cycle)`);
  }
}
