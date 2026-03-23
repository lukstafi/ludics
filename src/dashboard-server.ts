// Dashboard server — Bun.serve() replacement for dashboard_server.py
//
// Serves static files from the dashboard directory and lazily regenerates
// data/*.json files when they become stale (TTL-based).

import { existsSync, readFileSync, statSync } from "fs";
import { resolve, extname } from "path";
import YAML from "yaml";
import { dashboardGenerate } from "./dashboard.ts";
import { loadConfigSync } from "./config.ts";

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
      const data = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;
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
          const proc = Bun.spawnSync(
            [process.execPath, "slot", slotParam, "clear", status],
            { stdout: "pipe", stderr: "pipe", cwd: process.env.HOME, env: process.env as Record<string, string> },
          );
          if (proc.exitCode !== 0) {
            return new Response(proc.stderr.toString() || "slot clear failed", { status: 500 });
          }
          lastGenerated = 0; // force regeneration on next data request
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
          const proc = Bun.spawnSync(
            [process.execPath, "slot", slotParam, "start"],
            { stdout: "pipe", stderr: "pipe", cwd: process.env.HOME, env: process.env as Record<string, string> },
          );
          if (proc.exitCode !== 0) {
            return new Response(proc.stderr.toString() || "slot start failed", { status: 500 });
          }
          lastGenerated = 0;
          return new Response("OK", { status: 200 });
        } catch (e) {
          return new Response(String(e), { status: 500 });
        }
      }

      if (pathname.startsWith("/task-files/")) {
        const taskPath = pathname.slice("/task-files/".length);
        const taskMatch = taskPath.match(/^([A-Za-z0-9._-]+)\.md$/);
        if (!taskMatch) {
          return new Response("Bad Request", { status: 400 });
        }

        const taskFilePath = resolve(tasksRoot, taskMatch[1]! + ".md");
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
