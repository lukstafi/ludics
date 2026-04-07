// Dashboard server — Bun.serve() replacement for dashboard_server.py
//
// Serves static files from the dashboard directory and lazily regenerates
// data/*.json files when they become stale (TTL-based).

import { existsSync, readFileSync, statSync } from "fs";
import { resolve, extname, join } from "path";
import YAML from "yaml";
import { safeSyncOutput } from "./spawn.ts";
import { dashboardGenerate } from "./dashboard.ts";
import { harnessDir, slotsFilePath, loadConfigSync } from "./config.ts";
import { updateFrontmatterField, addFrontmatterField, removeFrontmatterField, TASK_ID_RE } from "./tasks/markdown.ts";
import { findSlotForTask, setQueueHold } from "./mag.ts";
import { handleFederationRequest } from "./federation-http.ts";

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

export function startDashboardServer(
  port: number,
  dashboardDir: string,
  ttlSeconds: number,
): void {
  // Normalize to absolute path with trailing separator for safe startsWith checks
  const resolvedRoot = resolve(dashboardDir) + "/";
  const tasksRoot = resolve(dashboardDir, "..", "tasks") + "/";
  const homeRoot = resolve(process.env.HOME ?? "~") + "/";
  let lastGenerated = 0;

  function isSafeRegularFile(path: string): boolean {
    return path.startsWith(homeRoot) && existsSync(path) && !statSync(path).isDirectory();
  }

  function parseTaskFrontmatter(taskFilePath: string): { project: string; proposal: string | null } | null {
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

    const parsed = parseTaskFrontmatter(taskFilePath);
    if (!parsed || !parsed.proposal) return null;

    // "inline" means the proposal is written directly in the task file
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

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // Default to index.html
      if (pathname === "/") pathname = "/index.html";

      // Federation HTTP endpoints — cross-node coordination via HTTP
      if (pathname.startsWith("/federation/") || pathname.startsWith("/api/federation/")) {
        return handleFederationRequest(req, pathname);
      }

      // Regenerate data if stale on any request to /data/
      if (pathname.startsWith("/data/")) {
        maybeRegenerate();
      }

      // API: clear a slot as done
      if (pathname === "/api/slot-clear") {
        const slotParam = url.searchParams.get("slot");
        const status = url.searchParams.get("status") ?? "done";
        if (!slotParam || !/^[1-6]$/.test(slotParam)) {
          return new Response("Bad Request: slot must be 1-6", { status: 400 });
        }
        try {
          const proc = safeSyncOutput(
            [process.execPath, "slot", slotParam, "clear", status],
            { cwd: process.env.HOME },
          );
          if (!proc.ok) {
            return new Response(proc.stderr || "slot clear failed", { status: 500 });
          }
          lastGenerated = 0; // force regeneration on next data request
          return new Response("OK", { status: 200 });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      // API: set slot mode
      if (pathname === "/api/slot-mode") {
        const slotParam = url.searchParams.get("slot");
        const mode = url.searchParams.get("mode");
        if (!slotParam || !/^[1-6]$/.test(slotParam)) {
          return new Response("Bad Request: slot must be 1-6", { status: 400 });
        }
        if (!mode || !["manual", "tmux", "t3code"].includes(mode)) {
          return new Response("Bad Request: mode must be manual, tmux, or t3code", { status: 400 });
        }
        try {
          const proc = safeSyncOutput(
            [process.execPath, "slot", slotParam, "mode", mode],
            { cwd: process.env.HOME },
          );
          if (!proc.ok) {
            return new Response(proc.stderr || "slot mode failed", { status: 500 });
          }
          lastGenerated = 0;
          return new Response("OK", { status: 200 });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      // API: start a slot session
      if (pathname === "/api/slot-start") {
        const slotParam = url.searchParams.get("slot");
        if (!slotParam || !/^[1-6]$/.test(slotParam)) {
          return new Response("Bad Request: slot must be 1-6", { status: 400 });
        }
        try {
          const proc = safeSyncOutput(
            [process.execPath, "slot", slotParam, "start"],
            { cwd: process.env.HOME },
          );
          if (!proc.ok) {
            return new Response(proc.stderr || "slot start failed", { status: 500 });
          }
          lastGenerated = 0;
          return new Response("OK", { status: 200 });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      // API: resume an interrupted slot session
      if (pathname === "/api/slot-resume") {
        const slotParam = url.searchParams.get("slot");
        if (!slotParam || !/^[1-6]$/.test(slotParam)) {
          return new Response("Bad Request: slot must be 1-6", { status: 400 });
        }
        try {
          const proc = safeSyncOutput(
            [process.execPath, "slot", slotParam, "resume"],
            { cwd: process.env.HOME },
          );
          if (!proc.ok) {
            return new Response(proc.stderr || "slot resume failed", { status: 500 });
          }
          lastGenerated = 0;
          return new Response("OK", { status: 200 });
        } catch (e) {
          return new Response(String(e), { status: 500 });
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
          const slotsFile = slotsFilePath();
          if (existsSync(slotsFile)) {
            const slotsContent = readFileSync(slotsFile, "utf-8");
            const slotSection = slotsContent.match(
              new RegExp(`## Slot ${slotNum}\\n([\\s\\S]*?)(?=## Slot |$)`),
            );
            const taskIdMatch = slotSection?.[1]?.match(/\*\*Task:\*\*\s*(.+)/);
            const taskId = taskIdMatch ? taskIdMatch[1]!.trim() : null;
            if (taskId && taskId !== "null" && TASK_ID_RE.test(taskId)) {
              const taskResolved = resolveTaskFile(taskId);
              if (!("error" in taskResolved)) {
                const taskFile = taskResolved.path;
                const PRIORITY_DECREASE: Record<string, string> = { S: "A", A: "B", B: "C" };
                const content = readFileSync(taskFile, "utf-8");
                const priorityMatch = content.match(/^priority:\s*(.+)$/m);
                const currentPriority = priorityMatch ? priorityMatch[1]!.trim() : "B";
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

          const proc = safeSyncOutput(
            [process.execPath, "slot", slotParam, "clear", "ready"],
            { cwd: process.env.HOME },
          );
          if (!proc.ok) {
            return new Response(proc.stderr || "slot clear failed", { status: 500 });
          }

          lastGenerated = 0;
          return new Response("OK", { status: 200 });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      // API: promote task priority one level (C→B→A→S)
      if (pathname === "/api/task-promote") {
        const taskParam = url.searchParams.get("task");
        if (!taskParam || !TASK_ID_RE.test(taskParam)) {
          return new Response("Bad Request: invalid task id", { status: 400 });
        }
        try {
          const resolved = resolveTaskFile(taskParam);
          if ("error" in resolved) return resolved.error;
          const taskFile = resolved.path;
          const PRIORITY_INCREASE: Record<string, string> = { C: "B", B: "A", A: "S" };
          const content = readFileSync(taskFile, "utf-8");
          const priorityMatch = content.match(/^priority:\s*(.+)$/m);
          const currentPriority = priorityMatch ? priorityMatch[1]!.trim() : "B";
          const newPriority = PRIORITY_INCREASE[currentPriority] ?? currentPriority;
          if (newPriority !== currentPriority) {
            addFrontmatterField(taskFile, "priority", newPriority);
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
          const statusMatch = content.match(/^status:\s*(.+)$/m);
          const currentStatus = statusMatch ? statusMatch[1]!.trim() : "";
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
          const statusMatch = content.match(/^status:\s*(.+)$/m);
          const currentStatus = statusMatch ? statusMatch[1]!.trim() : "";
          if (currentStatus !== "needs-confirmation") {
            return new Response(JSON.stringify({ error: "task is not needs-confirmation" }), {
              status: 409, headers: { "Content-Type": "application/json" },
            });
          }
          updateFrontmatterField(taskFile, "status", "abandoned");
          lastGenerated = 0;
          return new Response(JSON.stringify({ status: "abandoned" }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      // API: approve a deferred-launch task (clear deferred_launch, set approved=true)
      if (pathname === "/api/deferred-approve") {
        const taskParam = url.searchParams.get("task");
        if (!taskParam || !TASK_ID_RE.test(taskParam)) {
          return new Response("Bad Request: invalid task id", { status: 400 });
        }
        try {
          const resolved = resolveTaskFile(taskParam);
          if ("error" in resolved) return resolved.error;
          const taskFile = resolved.path;
          removeFrontmatterField(taskFile, "deferred_launch");
          addFrontmatterField(taskFile, "approved", "true");
          lastGenerated = 0;
          return new Response(JSON.stringify({ status: "approved" }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      // API: abandon a deferred-launch task (clear slot if assigned, set abandoned)
      if (pathname === "/api/deferred-abandon") {
        const taskParam = url.searchParams.get("task");
        if (!taskParam || !TASK_ID_RE.test(taskParam)) {
          return new Response("Bad Request: invalid task id", { status: 400 });
        }
        try {
          const resolved = resolveTaskFile(taskParam);
          if ("error" in resolved) return resolved.error;
          const taskFile = resolved.path;

          // Check if task is assigned to a slot — if so, clear it synchronously
          const slotNum = findSlotForTask(taskParam);
          if (slotNum !== null) {
            const proc = safeSyncOutput(
              [process.execPath, "slot", String(slotNum), "clear", "abandoned"],
              { cwd: process.env.HOME },
            );
            if (!proc.ok) {
              return new Response(proc.stderr || "slot clear failed", { status: 500 });
            }
          } else {
            updateFrontmatterField(taskFile, "status", "abandoned");
            updateFrontmatterField(taskFile, "completed", new Date().toISOString().slice(0, 19) + "Z");
          }
          removeFrontmatterField(taskFile, "deferred_launch");
          removeFrontmatterField(taskFile, "approved");
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
    },
  });

  console.error(`ludics: dashboard server listening on http://localhost:${server.port}`);
  console.error(`ludics: data regenerates lazily (TTL: ${ttlSeconds}s)`);
  console.error("ludics: press Ctrl+C to stop");
}
