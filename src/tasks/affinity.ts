// Relation-affinity helper — computes connected components over task relation
// edges and classifies each task into affinity tiers based on whether its
// component contains a slotted or completed task.

export interface AffinityInput {
  id: string;
  status: string;
  completed: string | null;
  dependencies: {
    blocks: string[];
    blocked_by: string[];
    relates_to: string[];
  };
}

export interface AffinityLookup {
  getTier(taskId: string): 1 | 2 | 3;
}

// --- Union-Find with path compression and union-by-rank ---

function makeUnionFind() {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  function find(x: string): string {
    if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); }
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = x;
    while (cur !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rA = rank.get(ra) ?? 0;
    const rB = rank.get(rb) ?? 0;
    if (rA < rB) { parent.set(ra, rb); }
    else if (rA > rB) { parent.set(rb, ra); }
    else { parent.set(rb, ra); rank.set(ra, rA + 1); }
  }

  return { find, union };
}

function isCompletedTask(t: AffinityInput): boolean {
  if (t.status === "done" || t.status === "abandoned") return true;
  const c = (t.completed ?? "").trim().toLowerCase();
  return !!c && c !== "null";
}

/**
 * Build an affinity lookup from all tasks and the set of currently slotted task IDs.
 *
 * The undirected relation graph includes edges from `relates_to`, `blocks`, and
 * `blocked_by`. Connected components are computed via union-find, and each
 * component is classified:
 *   - Tier 1 if it contains any slotted task
 *   - Tier 2 if it contains any completed/abandoned task (but no slotted task)
 *   - Tier 3 otherwise
 */
export function buildAffinityLookup(
  tasks: AffinityInput[],
  slottedTaskIds: Set<string>,
): AffinityLookup {
  const uf = makeUnionFind();

  // Build undirected graph via union-find
  for (const t of tasks) {
    for (const other of t.dependencies.relates_to) { uf.union(t.id, other); }
    for (const other of t.dependencies.blocks) { uf.union(t.id, other); }
    for (const other of t.dependencies.blocked_by) { uf.union(t.id, other); }
  }

  // Classify each component root
  const componentHasSlotted = new Set<string>();
  const componentHasCompleted = new Set<string>();

  for (const t of tasks) {
    const root = uf.find(t.id);
    if (slottedTaskIds.has(t.id)) componentHasSlotted.add(root);
    if (isCompletedTask(t)) componentHasCompleted.add(root);
  }

  // Also check slotted IDs that may not be in the tasks array (e.g. unknown IDs)
  for (const sid of slottedTaskIds) {
    const root = uf.find(sid);
    componentHasSlotted.add(root);
  }

  return {
    getTier(taskId: string): 1 | 2 | 3 {
      const root = uf.find(taskId);
      if (componentHasSlotted.has(root)) return 1;
      if (componentHasCompleted.has(root)) return 2;
      return 3;
    },
  };
}
