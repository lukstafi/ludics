// Federation HTTP transport — real-time cross-node coordination via HTTP
//
// Server handlers are called by dashboard-server routing.
// Client helper is used by slots, federation, and worker-signal modules.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { harnessDir, loadConfigSync, slotsFilePath } from "./config.ts";
import { parseSlotBlocks, getTask, getMachine } from "./slots/markdown.ts";
import { slotClear } from "./slots/index.ts";
import { emitEvent } from "./events.ts";
import type { FederationMachine } from "./federation.ts";

// --- Config helpers ---

/** Read the shared secret from federation config. Empty string = no secret configured. */
export function federationSecret(): string {
  try {
    const config = loadConfigSync();
    const raw = config as unknown as Record<string, unknown>;
    const fed = raw.federation as Record<string, unknown> | undefined;
    return String(fed?.secret ?? "");
  } catch {
    return "";
  }
}

/** Resolve dashboard port for a machine, falling back to global dashboard.port then 7678. */
export function machineDashboardPort(machine: FederationMachine): number {
  const m = machine as FederationMachine & { dashboard_port?: number };
  if (m.dashboard_port && Number.isFinite(m.dashboard_port)) return m.dashboard_port;
  try {
    const config = loadConfigSync();
    return config.dashboard?.port ?? 7678;
  } catch {
    return 7678;
  }
}

/** Build the base URL for a machine's dashboard server. */
export function machineBaseUrl(machine: FederationMachine): string {
  const port = machineDashboardPort(machine);
  return `http://${machine.host}:${port}`;
}

// --- HTTP Client ---

const HTTP_TIMEOUT_MS = 10_000;

export async function federationHttpPost(
  machine: FederationMachine,
  path: string,
  body: object,
): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const secret = federationSecret();
  const url = `${machineBaseUrl(machine)}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data: unknown;
    try { data = await resp.json(); } catch { /* ignore */ }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ludics: federation HTTP POST ${path} to ${machine.name} failed: ${msg}`);
    return { ok: false };
  }
}

// --- Auth check ---

function checkAuth(req: Request): Response | null {
  const secret = federationSecret();
  if (!secret) {
    return new Response(JSON.stringify({ error: "federation secret not configured" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// --- Server handlers ---

const SIGNAL_MAX_AGE_SECONDS = 1800; // 30 minutes

/** Main federation request dispatcher — called from dashboard-server.ts. */
export async function handleFederationRequest(req: Request, pathname: string): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  switch (pathname) {
    case "/federation/heartbeat": return handleHeartbeat(body);
    case "/federation/signal": return handleSignal(body);
    default:
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { "Content-Type": "application/json" },
      });
  }
}

// --- Heartbeat handler (runs on controller) ---

function handleHeartbeat(body: Record<string, unknown>): Response {
  const node = String(body.node ?? "");
  const epoch = Number(body.epoch ?? 0);

  if (!node || !epoch) {
    return jsonResponse(400, { error: "missing fields: node, epoch required" });
  }

  // Write heartbeat file to runtime dir (outside harness)
  const { stateRepoDir } = require("./config.ts");
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(stateRepoDir());
  const suffix = hasher.digest("hex").slice(0, 8);
  const heartbeatsDir = join(process.env.HOME ?? "/tmp", `.ludics-heartbeats-${suffix}`);
  mkdirSync(heartbeatsDir, { recursive: true });
  const heartbeatFile = join(heartbeatsDir, `${node}.json`);
  writeFileSync(heartbeatFile, JSON.stringify(body, null, 2) + "\n");

  console.error(`ludics: federation HTTP: received heartbeat from ${node}`);
  return jsonResponse(200, { ok: true, node });
}

// --- Signal handler (runs on controller) ---

function handleSignal(body: Record<string, unknown>): Response {
  const taskId = String(body.taskId ?? "");
  const status = String(body.status ?? "");
  const message = String(body.message ?? "");
  const epoch = Number(body.epoch ?? 0);
  const machine = String(body.machine ?? "");
  const slot = Number(body.slot);

  if (!taskId || !status || !machine || !Number.isFinite(slot)) {
    return jsonResponse(400, { error: "missing fields: taskId, status, machine, slot required" });
  }

  // Validate against current slot state
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) {
    return jsonResponse(409, { error: "slots file not found" });
  }

  const content = readFileSync(sFile, "utf-8");
  const blocks = parseSlotBlocks(content);
  const block = blocks.get(slot);
  if (!block) {
    return jsonResponse(409, { error: `slot ${slot} not found` });
  }

  const currentTaskId = getTask(block).trim();
  if (currentTaskId !== taskId) {
    return jsonResponse(409, { error: `slot ${slot} task is ${currentTaskId}, signal is for ${taskId}` });
  }

  const currentMachine = getMachine(block).trim();
  if (currentMachine && currentMachine !== "null" && currentMachine !== machine) {
    return jsonResponse(409, { error: `slot ${slot} machine is ${currentMachine}, signal from ${machine}` });
  }

  // Check signal age
  const now = Math.floor(Date.now() / 1000);
  if (epoch > 0 && (now - epoch) > SIGNAL_MAX_AGE_SECONDS) {
    return jsonResponse(409, { error: `signal expired (age: ${now - epoch}s)` });
  }

  // Write signal file for local audit
  const signalsDir = join(harnessDir(), "worker-signals");
  mkdirSync(signalsDir, { recursive: true });
  writeFileSync(
    join(signalsDir, `slot-${slot}.json`),
    JSON.stringify({ taskId, status, message, epoch, machine }, null, 2) + "\n",
  );

  // Process inline
  switch (status) {
    case "done":
      console.error(`ludics: federation HTTP: task ${taskId} completed on ${machine}`);
      slotClear(slot, "done");
      emitEvent({
        event_type: "worker_signal_done",
        source: "federation-http",
        scope: "slot",
        slot,
        task: taskId,
        machine,
        message: message || "completed via HTTP signal",
      });
      break;

    case "error":
      console.error(`ludics: federation HTTP: task ${taskId} errored on ${machine}: ${message}`);
      emitEvent({
        event_type: "worker_signal_error",
        source: "federation-http",
        scope: "slot",
        slot,
        task: taskId,
        machine,
        message,
      });
      break;

    default:
      // "progress" or other — log only
      break;
  }

  // Clear signal file after processing
  const signalFile = join(signalsDir, `slot-${slot}.json`);
  try {
    if (existsSync(signalFile)) {
      const { unlinkSync } = require("fs");
      unlinkSync(signalFile);
    }
  } catch { /* ignore */ }

  return jsonResponse(200, { ok: true, status, slot, taskId });
}

// --- Helpers ---

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
