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
import { join, resolve } from "node:path";
import { startDashboardServer } from "../src/dashboard-server.ts";

function parseNumberArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const raw = process.argv[i + 1];
  if (raw === undefined || raw.startsWith("--")) {
    console.error(`error: ${name} requires a numeric value`);
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`error: ${name} value ${JSON.stringify(raw)} is not a finite number`);
    process.exit(2);
  }
  return n;
}

const port = parseNumberArg("--port", 0);
const ttl = parseNumberArg("--ttl", 3600);
const keep = process.argv.includes("--keep");

// AC7 requires the mirror to live under /tmp/ literally — not the platform
// tmpdir, which on macOS resolves to /var/folders/.../T. The playbook's
// example transcript and reviewer probe both expect a /tmp/ path.
const root = mkdtempSync("/tmp/ludics-dash-mirror-");
const dashboardDir = join(root, "dashboard");
const tasksDir = join(root, "tasks");

let server: ReturnType<typeof startDashboardServer>;
try {
  mkdirSync(tasksDir, { recursive: true });
  cpSync(
    resolve(import.meta.dir, "..", "templates", "dashboard"),
    dashboardDir,
    { recursive: true },
  );
  server = startDashboardServer(port, dashboardDir, ttl);
} catch (err) {
  // Server start (or mirror copy) threw before signal handlers were
  // registered — clean up the temp directory so we don't leak it.
  rmSync(root, { recursive: true, force: true });
  throw err;
}

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
