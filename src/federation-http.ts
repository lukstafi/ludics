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

// --- HTTP GET Client ---

export async function federationHttpGet(
  machine: FederationMachine,
  path: string,
): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const secret = federationSecret();
  const url = `${machineBaseUrl(machine)}${path}`;
  const headers: Record<string, string> = {};
  if (secret) headers["Authorization"] = `Bearer ${secret}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    const ct = resp.headers.get("content-type") ?? "";
    let data: unknown;
    if (ct.includes("json")) {
      try { data = await resp.json(); } catch { /* ignore */ }
    } else {
      try { data = await resp.text(); } catch { /* ignore */ }
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ludics: federation HTTP GET ${path} to ${machine.name} failed: ${msg}`);
    return { ok: false };
  }
}

// --- In-memory intent store (controller-side) ---

export interface PendingIntent {
  action: "start" | "stop" | "resume";
  epoch: number;
  machine: string;
  taskId?: string;
  preserveState?: boolean;
}

const pendingIntents = new Map<number, PendingIntent>();
const INTENT_TTL = 900; // seconds

export function recordIntent(slot: number, intent: PendingIntent): void {
  pendingIntents.set(slot, intent);
}

export function clearIntent(slot: number): void {
  pendingIntents.delete(slot);
}

export function getIntentForDashboard(slot: number): PendingIntent | null {
  const intent = pendingIntents.get(slot);
  if (!intent) return null;
  if ((Math.floor(Date.now() / 1000) - intent.epoch) >= INTENT_TTL) {
    pendingIntents.delete(slot);
    return null;
  }
  return intent;
}

function getIntentsForMachine(machine: string): Record<number, PendingIntent> {
  const now = Math.floor(Date.now() / 1000);
  const result: Record<number, PendingIntent> = {};
  for (const [slot, intent] of pendingIntents) {
    if (intent.machine === machine && (now - intent.epoch) < INTENT_TTL) {
      result[slot] = intent;
    }
  }
  return result;
}

function expireStaleIntents(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [slot, intent] of pendingIntents) {
    if ((now - intent.epoch) >= INTENT_TTL) pendingIntents.delete(slot);
  }
}

// --- Client helpers for worker → controller communication ---

async function resolveAndPost(path: string, body: object): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const { resolveControllerCandidates } = await import("./federation.ts");
  const candidates = resolveControllerCandidates();
  for (const candidate of candidates) {
    const result = await federationHttpPost(candidate, path, body);
    if (result.ok) return result;
  }
  return { ok: false };
}

async function resolveAndGet(path: string): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const { resolveControllerCandidates } = await import("./federation.ts");
  const candidates = resolveControllerCandidates();
  for (const candidate of candidates) {
    const result = await federationHttpGet(candidate, path);
    if (result.ok) return result;
  }
  return { ok: false };
}

export async function federationPostJournal(category: string, message: string): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/federation/journal", { category, message });
}

export async function federationPostEvent(event: object): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/federation/event", event);
}

export async function federationPostOrchestrationState(slot: number, state: object): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/federation/orchestration-state", { slot, state });
}

export async function federationGetOrchestrationState(slot: number): Promise<{ ok: boolean; data?: unknown }> {
  return resolveAndGet(`/api/federation/orchestration-state/${slot}`);
}

export async function federationPostTaskUpdate(taskId: string, field: string, value: string): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/federation/task-update", { taskId, field, value });
}

export async function federationGetTask(taskId: string): Promise<{ ok: boolean; data?: string }> {
  const result = await resolveAndGet(`/api/federation/task/${taskId}`);
  return { ok: result.ok, data: typeof result.data === "string" ? result.data : undefined };
}

export async function federationGetSlots(): Promise<{ ok: boolean; data?: string }> {
  const result = await resolveAndGet("/api/federation/slots");
  return { ok: result.ok, data: typeof result.data === "string" ? result.data : undefined };
}

export async function federationPostSlotUpdate(slot: number, sections: Record<string, string | undefined>): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/federation/slot-update", { slot, ...sections });
}

export async function federationGetIntents(): Promise<{ ok: boolean; data?: Record<number, PendingIntent> }> {
  const result = await resolveAndGet("/api/federation/intents");
  return { ok: result.ok, data: result.data as Record<number, PendingIntent> | undefined };
}

export async function federationDeleteIntent(slot: number): Promise<{ ok: boolean }> {
  const { resolveControllerCandidates } = await import("./federation.ts");
  const candidates = resolveControllerCandidates();
  for (const candidate of candidates) {
    const secret = federationSecret();
    const url = `${machineBaseUrl(candidate)}/api/federation/intent/${slot}`;
    const headers: Record<string, string> = {};
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
      const resp = await fetch(url, { method: "DELETE", headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) return { ok: true };
    } catch { /* try next */ }
  }
  return { ok: false };
}

export async function federationReportWorkerSignal(
  slot: number, taskId: string, status: string, message: string,
): Promise<void> {
  const { resolveControllerCandidates, federationCurrentMachineName } = await import("./federation.ts");
  const candidates = resolveControllerCandidates();
  const machine = federationCurrentMachineName() ?? "";
  const epoch = Math.floor(Date.now() / 1000);
  for (const candidate of candidates) {
    const result = await federationHttpPost(candidate, "/federation/signal", {
      slot, taskId, status, message, machine, epoch,
    });
    if (result.ok) return;
  }
}

// --- Server handlers ---

const SIGNAL_MAX_AGE_SECONDS = 1800; // 30 minutes

/** Main federation request dispatcher — called from dashboard-server.ts. */
export async function handleFederationRequest(req: Request, pathname: string): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  // GET endpoints
  if (req.method === "GET") {
    if (pathname === "/api/federation/slots") return handleGetSlots();
    if (pathname === "/api/federation/intents") return handleGetIntents(req);
    if (pathname === "/api/federation/leader") return handleGetLeader();
    const taskMatch = pathname.match(/^\/api\/federation\/task\/(.+)$/);
    if (taskMatch) return handleGetTask(taskMatch[1]!);
    const orchMatch = pathname.match(/^\/api\/federation\/orchestration-state\/(\d+)$/);
    if (orchMatch) return handleGetOrchestrationState(Number(orchMatch[1]));
  }

  // DELETE endpoints
  if (req.method === "DELETE") {
    const intentMatch = pathname.match(/^\/api\/federation\/intent\/(\d+)$/);
    if (intentMatch) {
      clearIntent(Number(intentMatch[1]));
      return jsonResponse(200, { ok: true });
    }
  }

  // POST endpoints
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "invalid JSON" });
  }

  switch (pathname) {
    case "/federation/heartbeat": return handleHeartbeat(body);
    case "/federation/signal": return handleSignal(body);
    case "/api/federation/journal": return handlePostJournal(body);
    case "/api/federation/event": return handlePostEvent(body);
    case "/api/federation/orchestration-state": return handlePostOrchestrationState(body);
    case "/api/federation/task-update": return handlePostTaskUpdate(body);
    case "/api/federation/slot-update": return handlePostSlotUpdate(body);
    default:
      return jsonResponse(404, { error: "not found" });
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

  // Also clear any pending intent for this slot
  clearIntent(slot);

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

  return jsonResponse(200, { ok: true, status, slot, taskId });
}

// --- Phase 4 GET handlers ---

function handleGetSlots(): Response {
  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return jsonResponse(404, { error: "slots file not found" });
  return new Response(readFileSync(sFile, "utf-8"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

function handleGetIntents(req: Request): Response {
  expireStaleIntents();
  // If ?machine= param, filter by machine
  const url = new URL(req.url);
  const machine = url.searchParams.get("machine");
  if (machine) {
    return jsonResponse(200, { intents: getIntentsForMachine(machine) });
  }
  // Return all pending intents
  const all: Record<number, PendingIntent> = {};
  for (const [slot, intent] of pendingIntents) all[slot] = intent;
  return jsonResponse(200, { intents: all });
}

function handleGetLeader(): Response {
  try {
    const { federationCurrentController } = require("./federation.ts");
    return jsonResponse(200, { leader: federationCurrentController() });
  } catch {
    return jsonResponse(200, { leader: null });
  }
}

function handleGetTask(taskId: string): Response {
  const TASK_ID_RE = /^[a-z0-9_-]+$/i;
  if (!TASK_ID_RE.test(taskId)) return jsonResponse(400, { error: "invalid task id" });
  const file = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(file)) return jsonResponse(404, { error: "task not found" });
  return new Response(readFileSync(file, "utf-8"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

function handleGetOrchestrationState(slot: number): Response {
  if (!Number.isFinite(slot)) return jsonResponse(400, { error: "invalid slot" });
  const file = join(harnessDir(), "orchestration", `slot-${slot}.json`);
  if (!existsSync(file)) return jsonResponse(404, { error: "orchestration state not found" });
  try {
    return jsonResponse(200, JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    return jsonResponse(500, { error: "failed to read orchestration state" });
  }
}

// --- Phase 4 POST handlers ---

function handlePostJournal(body: Record<string, unknown>): Response {
  const category = String(body.category ?? "");
  const message = String(body.message ?? "");
  if (!category || !message) return jsonResponse(400, { error: "category and message required" });
  try {
    const { journalAppend } = require("./journal.ts");
    journalAppend(category, message);
  } catch (err) {
    return jsonResponse(500, { error: String(err) });
  }
  return jsonResponse(200, { ok: true });
}

function handlePostEvent(body: Record<string, unknown>): Response {
  try {
    const { appendFileSync } = require("fs");
    const dir = join(harnessDir(), "journal");
    mkdirSync(dir, { recursive: true });
    // Use worker-supplied ts/epoch if present, otherwise generate
    const now = new Date();
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) cleaned[k] = v;
    }
    if (!cleaned.ts) cleaned.ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    if (!cleaned.epoch) cleaned.epoch = Math.floor(now.getTime() / 1000);
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(cleaned) + "\n");
  } catch (err) {
    return jsonResponse(500, { error: String(err) });
  }
  return jsonResponse(200, { ok: true });
}

function handlePostOrchestrationState(body: Record<string, unknown>): Response {
  const slot = Number(body.slot);
  const state = body.state;
  if (!Number.isFinite(slot) || !state) return jsonResponse(400, { error: "slot and state required" });
  try {
    const dir = join(harnessDir(), "orchestration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `slot-${slot}.json`), JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    return jsonResponse(500, { error: String(err) });
  }
  return jsonResponse(200, { ok: true });
}

function handlePostTaskUpdate(body: Record<string, unknown>): Response {
  const taskId = String(body.taskId ?? "");
  const field = String(body.field ?? "");
  const value = String(body.value ?? "");
  if (!taskId || !field) return jsonResponse(400, { error: "taskId and field required" });
  const TASK_ID_RE = /^[a-z0-9_-]+$/i;
  if (!TASK_ID_RE.test(taskId)) return jsonResponse(400, { error: "invalid task id" });
  const file = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(file)) return jsonResponse(404, { error: "task not found" });
  try {
    const { updateFrontmatterField } = require("./tasks/markdown.ts");
    updateFrontmatterField(file, field, value);
  } catch (err) {
    return jsonResponse(500, { error: String(err) });
  }
  return jsonResponse(200, { ok: true });
}

function handlePostSlotUpdate(body: Record<string, unknown>): Response {
  const slot = Number(body.slot);
  if (!Number.isFinite(slot)) return jsonResponse(400, { error: "slot required" });

  const sFile = slotsFilePath();
  if (!existsSync(sFile)) return jsonResponse(404, { error: "slots file not found" });

  const { setField, writeSlotFile } = require("./slots/markdown.ts");
  const { slotsCount } = require("./config.ts");
  const { replaceSections } = require("./state.ts");
  const content = readFileSync(sFile, "utf-8");
  const blocks = parseSlotBlocks(content);
  const count = slotsCount();

  let block: string | undefined = blocks.get(slot);
  if (!block) return jsonResponse(404, { error: `slot ${slot} not found` });

  // Merge runtime fields only
  if (body.sessionStarted !== undefined) block = setField(block, "Session Started", String(body.sessionStarted));
  if (body.liveness !== undefined) block = setField(block, "Liveness", String(body.liveness));

  // Merge sections (Terminals, Runtime, Git)
  if (body.terminals !== undefined || body.runtime !== undefined || body.git !== undefined) {
    const sections: Record<string, string> = {};
    if (typeof body.terminals === "string") sections.terminals = body.terminals;
    if (typeof body.runtime === "string") sections.runtime = body.runtime;
    if (typeof body.git === "string") sections.git = body.git;
    block = replaceSections(block, sections);
  }

  blocks.set(slot, block as string);
  writeSlotFile(sFile, blocks, count);
  return jsonResponse(200, { ok: true });
}

// --- Helpers ---

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
