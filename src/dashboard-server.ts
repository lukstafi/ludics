// Dashboard server — Bun.serve() replacement for dashboard_server.py
//
// Serves static files from the dashboard directory and lazily regenerates
// data/*.json files when they become stale (TTL-based).

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { resolve, extname, join } from "path";
import YAML from "yaml";
import { dashboardGenerate } from "./dashboard.ts";
import { harnessDir, loadConfigSync } from "./config.ts";
import { readSlotJson, normalizeTaskId } from "./slots/json.ts";
import { slotClear, slotSetMode, slotStart, slotResume, findSlotForTask, VALID_CLEAR_STATUSES, CLEAR_STATUS_READY, CLEAR_STATUS_DONE } from "./slots/index.ts";
import { updateFrontmatterField, addFrontmatterField, removeFrontmatterField, parseTaskFrontmatter, transitionStatus, TASK_ID_RE, PRIORITY_INCREASE, PRIORITY_DECREASE } from "./tasks/markdown.ts";
import { emitEvent } from "./events.ts";
import { ADAPTER_NAMES } from "./adapters/index.ts";
import { readTmuxSlotState, writeTmuxSlotState } from "./adapters/tmux-adapter.ts";
import { tasksAbandon, tasksCreate } from "./tasks/index.ts";
import { setQueueHold, maybeFeedMagQueue, clearAutoProposalDebounce, listInFlightDeliveries, readInFlight, clearInFlight, magResultFile, type InFlightDelivery } from "./mag.ts";
import { queueList, queueRequest, recentResults, queuePromoteToTop, queueCancel, queueReinsertHeadWithFreshId } from "./queue.ts";
import { resolveSkillCommand } from "./skill-queue-registry.ts";
import { handleClusterRequest } from "./cluster-http.ts";
import { validatePayload } from "./orchestration-defaults.ts";
import { writeOrchestrationDefaults } from "./config.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const QUEUE_ID_RE = /^req-\d+-\d+$/;

export interface DashboardHandlerDeps {
  dashboardDir: string;
  ttlSeconds: number;
}

export function buildHandlers(deps: DashboardHandlerDeps): (req: Request) => Promise<Response> {
  const { dashboardDir, ttlSeconds } = deps;
  // Normalize to absolute path with trailing separator for safe startsWith checks
  const resolvedRoot = resolve(dashboardDir) + "/";
  const tasksRoot = resolve(dashboardDir, "..", "tasks") + "/";
  const homeRoot = resolve(process.env.HOME ?? "~") + "/";
  let lastGenerated = 0;

  function isSafeRegularFile(path: string): boolean {
    return path.startsWith(homeRoot) && existsSync(path) && !statSync(path).isDirectory();
  }

  function readDashboardTaskInfo(taskFilePath: string): { project: string; proposal: string | null } | null {
    try {
      const content = readFileSync(taskFilePath, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const data = (YAML.parse(fmMatch[1]!, { uniqueKeys: false }) ?? {}) as Record<string, unknown>;
      const rawProject = String(data.project ?? "").trim();
      const rawProposal = String(data.proposal ?? "").trim();
      const proposal = rawProposal && rawProposal.toLowerCase() !== "null" ? rawProposal : null;
      return { project: rawProject, proposal };
    } catch {
      return null;
    }
  }

  function candidateProjectDirs(project: string): string[] {
    const dirs = new Set<string>();
    const trimmed = project.trim();
    if (trimmed) {
      dirs.add(trimmed);
      dirs.add(trimmed.toLowerCase());
    }

    try {
      const config = loadConfigSync();
      const projects = config.projects ?? [];
      for (const p of projects) {
        const repoTail = String(p.repo ?? "").split("/").pop() ?? "";
        const name = String(p.name ?? "");
        if (
          trimmed &&
          trimmed.toLowerCase() !== name.toLowerCase() &&
          trimmed.toLowerCase() !== repoTail.toLowerCase()
        ) {
          continue;
        }
        if (repoTail) dirs.add(repoTail);
      }
    } catch {
      // ignore
    }

    return Array.from(dirs);
  }

  function resolveProposalFile(taskId: string): string | null {
    const taskFilePath = resolve(tasksRoot, `${taskId}.md`);
    if (!taskFilePath.startsWith(tasksRoot) || !existsSync(taskFilePath) || statSync(taskFilePath).isDirectory()) {
      return null;
    }

    const parsed = readDashboardTaskInfo(taskFilePath);
    if (!parsed || !parsed.proposal) return null;

    // Deprecated sentinel — kept for backward compat; resolve inline to the task file itself.
    if (parsed.proposal === "inline") return taskFilePath;

    const normalizedProposal = parsed.proposal.startsWith("~/")
      ? resolve(process.env.HOME ?? "~", parsed.proposal.slice(2))
      : parsed.proposal;

    if (normalizedProposal.startsWith("/")) {
      const abs = resolve(normalizedProposal);
      return isSafeRegularFile(abs) ? abs : null;
    }

    const candidates: string[] = [];
    for (const dir of candidateProjectDirs(parsed.project)) {
      candidates.push(resolve(process.env.HOME ?? "~", dir, normalizedProposal));
    }
    candidates.push(resolve(process.env.HOME ?? "~", normalizedProposal));

    for (const candidate of candidates) {
      if (isSafeRegularFile(candidate)) return candidate;
    }

    return null;
  }

  function resolveTaskFile(taskId: string): { path: string } | { error: Response } {
    const hDir = harnessDir();
    const taskFile = resolve(hDir, "tasks", `${taskId}.md`);
    const safeTasksRoot = resolve(hDir, "tasks") + "/";
    if (!taskFile.startsWith(safeTasksRoot)) {
      return { error: new Response("Forbidden", { status: 403 }) };
    }
    if (!existsSync(taskFile) || statSync(taskFile).isDirectory()) {
      return { error: new Response("Not Found", { status: 404 }) };
    }
    return { path: taskFile };
  }

  function maybeRegenerate(): void {
    const now = Math.floor(Date.now() / 1000);
    if (now - lastGenerated >= ttlSeconds) {
      try {
        dashboardGenerate();
        lastGenerated = now;
      } catch (e) {
        console.error(`ludics: dashboard regeneration failed: ${e}`);
      }
    }
  }

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Default to index.html
    if (pathname === "/") pathname = "/index.html";

    // Cluster HTTP endpoints — cross-node coordination via HTTP
    if (pathname.startsWith("/cluster/") || pathname.startsWith("/api/cluster/")) {
      return handleClusterRequest(req, pathname);
    }

    // Regenerate data if stale on any request to /data/
    if (pathname.startsWith("/data/")) {
      maybeRegenerate();
    }

    // API: clear ttyd flap-suppression counters for a slot (or one agent in it).
    // Triggered from the Terminals tab on full page reload — the user's
    // natural "kick it" gesture becomes the recovery action.
    // task-7476a03a — slot ttyd observability + flap-suppression.
    if (pathname === "/api/ttyd-reset" && req.method === "POST") {
      const slotParam = url.searchParams.get("slot");
      const agentParam = url.searchParams.get("agent");
      if (!slotParam || !/^[1-6]$/.test(slotParam)) {
        return new Response("Bad Request: slot must be 1-6", { status: 400 });
      }
      const slot = parseInt(slotParam, 10);
      const tmuxState = readTmuxSlotState(slot, harnessDir());
      if (!tmuxState) return new Response("Not Found", { status: 404 });
      if (!tmuxState.ttydRestartCounts) {
        // Already sparse — no-op succeeds without rewriting the file.
        return new Response("OK", { status: 200 });
      }
      if (agentParam) {
        delete tmuxState.ttydRestartCounts[agentParam];
        if (Object.keys(tmuxState.ttydRestartCounts).length === 0) {
          // Keep persisted shape sparse so future reads see undefined.
          delete tmuxState.ttydRestartCounts;
        }
      } else {
        // Slot-wide reset → drop the entire field.
        delete tmuxState.ttydRestartCounts;
      }
      writeTmuxSlotState(tmuxState, harnessDir());
      return new Response("OK", { status: 200 });
    }

    // API: clear a slot as done
    if (pathname === "/api/slot-clear") {
      const slotParam = url.searchParams.get("slot");
      const status = url.searchParams.get("status") ?? CLEAR_STATUS_DONE;
      if (!slotParam || !/^[1-6]$/.test(slotParam)) {
        return new Response("Bad Request: slot must be 1-6", { status: 400 });
      }
      if (!(VALID_CLEAR_STATUSES as readonly string[]).includes(status)) {
        return new Response(`Bad Request: status must be ${VALID_CLEAR_STATUSES.join(", ")}`, { status: 400 });
      }
      try {
        await slotClear(parseInt(slotParam, 10), status);
        lastGenerated = 0; // force regeneration on next data request
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    }

    // API: set slot mode
    if (pathname === "/api/slot-mode") {
      const slotParam = url.searchParams.get("slot");
      const mode = url.searchParams.get("mode");
      if (!slotParam || !/^[1-6]$/.test(slotParam)) {
        return new Response("Bad Request: slot must be 1-6", { status: 400 });
      }
      if (!mode || !ADAPTER_NAMES.includes(mode)) {
        return new Response(`Bad Request: mode must be one of ${ADAPTER_NAMES.join(", ")}`, { status: 400 });
      }
      try {
        await slotSetMode(parseInt(slotParam, 10), mode);
        lastGenerated = 0;
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    }

    // API: start a slot session
    if (pathname === "/api/slot-start") {
      const slotParam = url.searchParams.get("slot");
      if (!slotParam || !/^[1-6]$/.test(slotParam)) {
        return new Response("Bad Request: slot must be 1-6", { status: 400 });
      }
      try {
        await slotStart(parseInt(slotParam, 10));
        lastGenerated = 0;
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    }

    // API: resume an interrupted slot session
    if (pathname === "/api/slot-resume") {
      const slotParam = url.searchParams.get("slot");
      if (!slotParam || !/^[1-6]$/.test(slotParam)) {
        return new Response("Bad Request: slot must be 1-6", { status: 400 });
      }
      try {
        await slotResume(parseInt(slotParam, 10));
        lastGenerated = 0;
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    }

    // API: postpone a slot (decrease task priority one level + clear as ready)
    if (pathname === "/api/slot-postpone") {
      const slotParam = url.searchParams.get("slot");
      if (!slotParam || !/^[1-6]$/.test(slotParam)) {
        return new Response("Bad Request: slot must be 1-6", { status: 400 });
      }
      try {
        const slotNum = parseInt(slotParam, 10);

        // Resolve task ID and new priority *before* clearing, but do NOT write yet.
        // Only write priority after the clear succeeds (atomicity).
        let pendingPriorityWrite: (() => void) | null = null;
        {
          const slotData = readSlotJson(slotNum);
          const taskId = normalizeTaskId(slotData.task);
          if (taskId && TASK_ID_RE.test(taskId)) {
            const taskResolved = resolveTaskFile(taskId);
            if (!("error" in taskResolved)) {
              const taskFile = taskResolved.path;
              const content = readFileSync(taskFile, "utf-8");
              const currentPriority = parseTaskFrontmatter(content).priority ?? "B";
              const newPriority = PRIORITY_DECREASE[currentPriority] ?? currentPriority;
              if (newPriority !== currentPriority) {
                // Capture the write as a closure; execute only after clear succeeds.
                pendingPriorityWrite = () => updateFrontmatterField(taskFile, "priority", newPriority);
              }
            }
          }
        }

        // Demote priority BEFORE clearing the slot, so the task never appears
        // in the ready queue at its old priority (race with auto-assign).
        pendingPriorityWrite?.();

        await slotClear(slotNum, CLEAR_STATUS_READY);

        lastGenerated = 0;
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: promote task priority one level (D→C→B→A→S)
    if (pathname === "/api/task-promote") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const taskFile = resolved.path;
        const content = readFileSync(taskFile, "utf-8");
        const currentPriority = parseTaskFrontmatter(content).priority ?? "B";
        const newPriority = PRIORITY_INCREASE[currentPriority] ?? currentPriority;
        if (newPriority !== currentPriority) {
          addFrontmatterField(taskFile, "priority", newPriority);
          // Priority increase is a user-driven "act on this now" signal —
          // invalidate the auto-proposal debounce so the next keepalive cycle
          // re-evaluates this task instead of waiting out the TTL.
          clearAutoProposalDebounce(taskParam);
        }
        lastGenerated = 0;
        return new Response(JSON.stringify({ priority: newPriority }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: confirm a needs-confirmation task (set status to ready)
    if (pathname === "/api/task-confirm") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const taskFile = resolved.path;
        const content = readFileSync(taskFile, "utf-8");
        const currentStatus = parseTaskFrontmatter(content).status ?? "";
        if (currentStatus !== "needs-confirmation") {
          return new Response(JSON.stringify({ error: "task is not needs-confirmation" }), {
            status: 409, headers: { "Content-Type": "application/json" },
          });
        }
        updateFrontmatterField(taskFile, "status", "ready");
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "ready" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: dismiss a needs-confirmation task (set status to abandoned)
    if (pathname === "/api/task-dismiss") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const taskFile = resolved.path;
        const content = readFileSync(taskFile, "utf-8");
        const currentStatus = parseTaskFrontmatter(content).status ?? "";
        if (currentStatus !== "needs-confirmation") {
          return new Response(JSON.stringify({ error: "task is not needs-confirmation" }), {
            status: 409, headers: { "Content-Type": "application/json" },
          });
        }
        await tasksAbandon(taskParam, { source: "dashboard", scope: "task" });
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "abandoned" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: approve a deferred task (set status: ready)
    if (pathname === "/api/deferred-approve") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const taskFile = resolved.path;
        const approveContent = readFileSync(taskFile, "utf-8");
        const approveStatus = parseTaskFrontmatter(approveContent).status;
        if (approveStatus !== "deferred") {
          return new Response(
            JSON.stringify({ error: `task is ${approveStatus}, not deferred` }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        updateFrontmatterField(taskFile, "status", "ready");
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "approved" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: abandon a deferred task. Slotted deferred tasks are rejected
    // with 409 — the user must clear the slot first (slot operations'
    // terminal transitions handle displaced-task recovery via
    // task-4028c493). tasksAbandon's slot-aware path is preserved for
    // the CLI caller `ludics tasks abandon <id>`.
    if (pathname === "/api/deferred-abandon") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const slotNum = findSlotForTask(taskParam);
        if (slotNum !== null) {
          return new Response(
            JSON.stringify({ error: `task is in slot ${slotNum}; use slot operations to change state` }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        await tasksAbandon(taskParam, { source: "dashboard", scope: "task" });
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "abandoned" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: revive a stale task (flip status: stale -> ready)
    if (pathname === "/api/stale-revive") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const taskFile = resolved.path;
        // transitionStatus enforces stale -> ready exactly. Any other current
        // status returns false (the endpoint must NOT silently revive
        // unrelated statuses — see proposal § Edge Cases #5).
        const ok = transitionStatus(taskFile, "stale", "ready");
        if (!ok) {
          return new Response(JSON.stringify({ error: "task is not stale" }), {
            status: 409, headers: { "Content-Type": "application/json" },
          });
        }
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "ready" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: abandon a stale task. Slotted stale tasks are rejected with
    // 409 — the user must clear the slot first (slot operations' terminal
    // transitions handle displaced-task recovery via task-4028c493). For
    // unslotted stale tasks we bypass tasksAbandon and do the abandon
    // flow inline because tasksAbandon's terminal-status guard rejects
    // status: stale.
    //
    // The findSlotForTask / transitionStatus pair is check-then-act; a
    // task could in principle be slotted between the two calls. Per
    // proposal § Race notes (task-ad39a394) this is accepted as
    // best-effort: no production path slots a stale task post-check
    // (the staleness sweeper never targets in-progress, slot-assign
    // paths reject non-ready/deferred statuses for stale tasks). The
    // same applies symmetrically to /api/deferred-abandon below.
    if (pathname === "/api/stale-abandon") {
      const taskParam = url.searchParams.get("task");
      if (!taskParam || !TASK_ID_RE.test(taskParam)) {
        return new Response("Bad Request: invalid task id", { status: 400 });
      }
      try {
        const resolved = resolveTaskFile(taskParam);
        if ("error" in resolved) return resolved.error;
        const taskFile = resolved.path;

        const slotNum = findSlotForTask(taskParam);
        if (slotNum !== null) {
          return new Response(
            JSON.stringify({ error: `task is in slot ${slotNum}; use slot operations to change state` }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        const ok = transitionStatus(taskFile, "stale", "abandoned");
        if (!ok) {
          return new Response(JSON.stringify({ error: "task is not stale" }), {
            status: 409, headers: { "Content-Type": "application/json" },
          });
        }

        const completed = new Date().toISOString().slice(0, 19) + "Z";
        updateFrontmatterField(taskFile, "completed", completed);
        removeFrontmatterField(taskFile, "deferred_launch");
        removeFrontmatterField(taskFile, "approved");

        emitEvent({
          event_type: "task_abandon",
          source: "dashboard",
          scope: "task",
          task: taskParam,
          status: "abandoned",
          message: "abandoned (stale → abandoned)",
        });

        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "abandoned" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: set queue hold state (state=true → hold, state=false → resume)
    if (pathname === "/api/queue-hold") {
      const stateParam = url.searchParams.get("state");
      if (stateParam !== "true" && stateParam !== "false") {
        return new Response("Bad Request: state must be true or false", { status: 400 });
      }
      try {
        const held = stateParam === "true";
        setQueueHold(held, "dashboard");
        lastGenerated = 0;
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: trigger queue delivery without queuing a message
    if (pathname === "/api/queue-deliver" && req.method === "POST") {
      try {
        const delivered = await maybeFeedMagQueue();
        return new Response(JSON.stringify({ delivered }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    }

    // API: enqueue a message
    if (pathname === "/api/queue" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return new Response("Bad Request: invalid JSON", { status: 400 });
      }
      const content = body.content;
      if (!content || typeof content !== "string" || !content.trim()) {
        return new Response("Bad Request: non-empty content required", { status: 400 });
      }
      try {
        const requestId = queueRequest({ action: "message", content: content.trim() });
        lastGenerated = 0;
        // Attempt immediate delivery if Mag is settled
        maybeFeedMagQueue().catch((e) => { console.error("ludics: dashboard queue-deliver:", e); });
        return new Response(JSON.stringify({ id: requestId }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: promote a pending queue item to the head
    if (pathname === "/api/queue-promote" && req.method === "POST") {
      const idParam = url.searchParams.get("id");
      if (!idParam || !QUEUE_ID_RE.test(idParam)) {
        return new Response("Bad Request: invalid queue id", { status: 400 });
      }
      try {
        const result = queuePromoteToTop(idParam);
        if (result.status === "promoted") {
          // Promoting a task-bound queue item is the user's "act on this now"
          // gesture for that task — clear its auto-proposal debounce so the
          // next keepalive cycle re-evaluates eligibility. Items without a
          // bound task (e.g. action: "briefing") are no-ops here.
          const taskField = result.record["task"];
          if (typeof taskField === "string" && taskField.length > 0) {
            clearAutoProposalDebounce(taskField);
          }
        }
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: result.status }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: cancel (remove) a pending queue item; return its payload for composer hydration
    if (pathname === "/api/queue-cancel" && req.method === "POST") {
      const idParam = url.searchParams.get("id");
      if (!idParam || !QUEUE_ID_RE.test(idParam)) {
        return new Response("Bad Request: invalid queue id", { status: 400 });
      }
      try {
        const result = queueCancel(idParam);
        lastGenerated = 0;
        if (result.status === "not-found") {
          return new Response(JSON.stringify({ status: "not-found" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        const request = result.request;
        const content = typeof request.content === "string" ? request.content : null;
        const action = typeof request.action === "string" ? request.action : "unknown";
        const task = typeof request.task === "string" ? request.task : undefined;
        const slashCommand = action !== "message" && action !== "unknown"
          ? resolveSkillCommand(action, request as Record<string, unknown>)
          : null;
        const body: Record<string, unknown> = { status: "cancelled", content, action, slashCommand };
        if (task !== undefined) body.task = task;
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: list queue items and recent results
    if (pathname === "/api/queue") {
      try {
        const pending = queueList();
        const results = recentResults(20).map(r => {
          const d = { ...r.data };
          delete d.output; // strip large blobs — UI only needs id/status/timestamp
          return d;
        });
        // gh-ludics-535: a popped-but-not-completed request is in neither
        // `pending` nor `results`. Surface every unresolved in-flight record
        // (one file per delivery under mag/in-flight/, sorted by deliveredAt
        // ascending). Always an array — `[]` when there are none.
        const inFlight: InFlightDelivery[] = listInFlightDeliveries();
        return new Response(JSON.stringify({ pending, results, inFlight }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: re-fire an in-flight delivery (gh-ludics-535 A8). Mints a fresh
    // queue id, sets `re-fired-from: <original>` provenance, reinserts at
    // queue head, and clears the original in-flight record. Short-circuits
    // to `already-completed` when the original result file has appeared
    // since the dashboard last fetched.
    if (pathname === "/api/in-flight-refire" && req.method === "POST") {
      const idParam = url.searchParams.get("id");
      if (!idParam || !QUEUE_ID_RE.test(idParam)) {
        return new Response("Bad Request: invalid queue id", { status: 400 });
      }
      try {
        const record = readInFlight(idParam);
        if (!record) {
          return new Response(JSON.stringify({ status: "not-found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        // Race: result landed in the dashboard-read → click window. Clear
        // the in-flight record and tell the client; do not re-queue.
        if (existsSync(magResultFile(idParam))) {
          clearInFlight(idParam);
          return new Response(JSON.stringify({ status: "already-completed" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        // Parse the original line tolerantly. A malformed line still gets
        // wrapped into `{ raw }` so provenance is preserved.
        let parsed: Record<string, unknown>;
        try {
          const maybeObj: unknown = JSON.parse(record.line);
          parsed = (maybeObj && typeof maybeObj === "object" && !Array.isArray(maybeObj))
            ? (maybeObj as Record<string, unknown>) : { raw: record.line };
        } catch {
          parsed = { raw: record.line };
        }
        const newId = queueReinsertHeadWithFreshId(parsed, idParam);
        clearInFlight(idParam);
        emitEvent({
          event_type: "mag_in_flight_refired", source: "dashboard", scope: "mag",
          message: `re-fired ${idParam} as ${newId}`,
        });
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "refired", newId }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: discard an in-flight delivery (gh-ludics-535 A8). Idempotent —
    // ENOENT is a no-op. No archive directory; the briefing-prep step
    // absorbs orphans (A9) as the audit trail.
    if (pathname === "/api/in-flight-discard" && req.method === "POST") {
      const idParam = url.searchParams.get("id");
      if (!idParam || !QUEUE_ID_RE.test(idParam)) {
        return new Response("Bad Request: invalid queue id", { status: 400 });
      }
      try {
        clearInFlight(idParam);
        emitEvent({
          event_type: "mag_in_flight_discarded", source: "dashboard", scope: "mag",
          message: `discarded ${idParam}`,
        });
        lastGenerated = 0;
        return new Response(JSON.stringify({ status: "discarded" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: list available projects from config
    if (pathname === "/api/projects") {
      try {
        const config = loadConfigSync();
        const projects = (config.projects ?? []).map((p: { name?: string }) => String(p.name ?? "")).filter(Boolean);
        return new Response(JSON.stringify({ projects }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // API: persist dashboard role-switcher state to config.yaml (task-b43bd578)
    if (pathname === "/api/orchestration-defaults") {
      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "method not allowed" }),
          { status: 405, headers: { "Content-Type": "application/json" } },
        );
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "invalid JSON" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const result = validatePayload(body);
      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: result.error }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      try {
        writeOrchestrationDefaults({ coder: result.coder, reviewer: result.reviewer });
        lastGenerated = 0; // force regeneration on next data request
        return new Response(
          JSON.stringify({ coder: result.coder, reviewer: result.reviewer }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // API: create a new task
    if (pathname === "/api/task-create" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return new Response("Bad Request: invalid JSON", { status: 400 });
      }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        return new Response("Bad Request: title is required", { status: 400 });
      }
      const project = typeof body.project === "string" ? body.project.trim() || "personal" : "personal";
      const priority = typeof body.priority === "string" && /^[A-DS]$/.test(body.priority) ? body.priority : "C";
      const effort = typeof body.effort === "string" && ["tiny", "small", "medium", "large"].includes(body.effort) ? body.effort : "medium";
      const usesBrowser = body.usesBrowser === true;
      const taskBody = typeof body.body === "string" ? body.body.trim() : "";

      try {
        const result = tasksCreate(title, project, priority, usesBrowser);

        // Set effort if non-default
        if (result.created && effort !== "medium") {
          updateFrontmatterField(result.path, "effort", effort);
        }

        // Replace default body content if custom body provided
        if (result.created && taskBody) {
          const fileContent = readFileSync(result.path, "utf-8");
          const fmEnd = fileContent.indexOf("\n---\n");
          if (fmEnd !== -1) {
            const frontmatter = fileContent.slice(0, fmEnd + 5); // include trailing \n---\n
            const newContent = frontmatter + "\n# " + title + "\n\n" + taskBody + "\n";
            writeFileSync(result.path, newContent);
          }
        }

        lastGenerated = 0;
        return new Response(JSON.stringify({ created: result.created, id: result.id }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    if (pathname.startsWith("/task-files/")) {
      const taskPath = pathname.slice("/task-files/".length);
      const taskId = taskPath.endsWith(".md") ? taskPath.slice(0, -3) : null;
      if (!taskId || !TASK_ID_RE.test(taskId)) {
        return new Response("Bad Request", { status: 400 });
      }

      const taskFilePath = resolve(tasksRoot, taskId + ".md");
      if (!taskFilePath.startsWith(tasksRoot)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!existsSync(taskFilePath) || statSync(taskFilePath).isDirectory()) {
        return new Response("Not Found", { status: 404 });
      }

      const body = readFileSync(taskFilePath);
      return new Response(body, {
        headers: { "Content-Type": MIME_TYPES[".md"]! },
      });
    }

    if (pathname.startsWith("/proposal-files/")) {
      const proposalPath = pathname.slice("/proposal-files/".length);
      const proposalMatch = proposalPath.match(/^([A-Za-z0-9._-]+)\.md$/);
      if (!proposalMatch) {
        return new Response("Bad Request", { status: 400 });
      }

      const proposalFilePath = resolveProposalFile(proposalMatch[1]!);
      if (!proposalFilePath) {
        return new Response("Not Found", { status: 404 });
      }

      const body = readFileSync(proposalFilePath);
      const ext = extname(proposalFilePath);
      return new Response(body, {
        headers: { "Content-Type": MIME_TYPES[ext] ?? MIME_TYPES[".md"]! },
      });
    }

    if (pathname.startsWith("/retrospective-files/")) {
      const retroPath = pathname.slice("/retrospective-files/".length);
      const retroMatch = retroPath.match(/^([A-Za-z0-9._-]+)\.json$/);
      if (!retroMatch) {
        return new Response("Bad Request", { status: 400 });
      }
      const retroRoot = resolve(join(harnessDir(), "retrospectives"));
      const retroFilePath = resolve(retroRoot, retroMatch[1]! + ".json");
      if (!retroFilePath.startsWith(retroRoot)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!existsSync(retroFilePath) || statSync(retroFilePath).isDirectory()) {
        return new Response("Not Found", { status: 404 });
      }
      const retroBody = readFileSync(retroFilePath);
      return new Response(retroBody, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Resolve file path with proper traversal prevention
    const filePath = resolve(resolvedRoot, "." + pathname);
    if (!filePath.startsWith(resolvedRoot)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      return new Response("Not Found", { status: 404 });
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    const body = readFileSync(filePath);
    return new Response(body, {
      headers: { "Content-Type": contentType },
    });
  };
}

export function startDashboardServer(
  port: number,
  dashboardDir: string,
  ttlSeconds: number,
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    fetch: buildHandlers({ dashboardDir, ttlSeconds }),
  });
  console.error(`ludics: dashboard server listening on http://localhost:${server.port}`);
  console.error(`ludics: data regenerates lazily (TTL: ${ttlSeconds}s)`);
  console.error("ludics: press Ctrl+C to stop");
  return server;
}
