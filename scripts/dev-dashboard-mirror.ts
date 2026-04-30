#!/usr/bin/env bun
// Boot the dashboard against a temp-dir mirror of templates/dashboard/.
//
// Citable shorthand for pattern (b) of the Manual-Smoke Evidence playbook
// in skills/worker-conventions.md. Mirrors the asset tree so the live HTTP
// probe runs against the real `startDashboardServer` entrypoint without
// touching the in-repo templates directory.
//
// Usage: bun run scripts/dev-dashboard-mirror.ts [--port N] [--ttl SEC] [--keep]

import { mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDashboardServer } from "../src/dashboard-server.ts";

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(parseArg("--port", "0"));
const ttl = Number(parseArg("--ttl", "3600"));
const keep = process.argv.includes("--keep");

const root = mkdtempSync(join(tmpdir(), "ludics-dash-mirror-"));
const dashboardDir = join(root, "dashboard");
const tasksDir = join(root, "tasks");
mkdirSync(tasksDir, { recursive: true });
cpSync(
  resolve(import.meta.dir, "..", "templates", "dashboard"),
  dashboardDir,
  { recursive: true },
);

const server = startDashboardServer(port, dashboardDir, ttl);
console.log(
  `dashboard listening on http://localhost:${server.port} (mirror=${root}${keep ? ", kept" : ""})`,
);

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  void server.stop(true);
  if (!keep) rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
