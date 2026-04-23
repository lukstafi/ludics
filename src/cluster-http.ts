// Cluster HTTP transport — real-time cross-node coordination via HTTP
//
// Server handlers are called by dashboard-server routing.
// Client helper is used by slots, cluster, and worker-signal modules.

import { existsSync, readFileSync, mkdirSync } from "fs";
import { atomicWriteFileSync, writeJsonFile } from "./json.ts";
import { join } from "path";
import { harnessDir, loadConfigSync, slotsCount } from "./config.ts";
import { readSlotJson, writeSlotJson, readAllSlotJson, slotDataToMarkdown } from "./slots/json.ts";
import type { SlotData } from "./slots/types.ts";
import { slotClear } from "./slots/index.ts";
import { emitEvent } from "./events.ts";
import type { ClusterMachine } from "./cluster.ts";

// --- Config helpers ---

/** Read the shared secret from cluster config. Empty string = no secret configured. */
export function clusterSecret(): string {
  try {
    const config = loadConfigSync();
    const raw = config as unknown as Record<string, unknown>;
    const fed = raw.cluster as Record<string, unknown> | undefined;
    return String(fed?.secret ?? "");
  } catch {
    return "";
  }
}

/** Resolve dashboard port for a machine, falling back to global dashboard.port then 7678. */
export function machineDashboardPort(machine: ClusterMachine): number {
  const m = machine as ClusterMachine & { dashboard_port?: number };
  if (m.dashboard_port && Number.isFinite(m.dashboard_port)) return m.dashboard_port;
  try {
    const config = loadConfigSync();
    return config.dashboard?.port ?? 7678;
  } catch {
    return 7678;
  }
}

/** Build the base URL for a machine's dashboard server. */
export function machineBaseUrl(machine: ClusterMachine): string {
  const port = machineDashboardPort(machine);
  return `http://${machine.host}:${port}`;
}

// --- HTTP Client ---

const HTTP_TIMEOUT_MS = 10_000;

export async function clusterHttpPost(
  machine: ClusterMachine,
  path: string,
  body: object,
): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const secret = clusterSecret();
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
    console.error(`ludics: cluster HTTP POST ${path} to ${machine.name} failed: ${msg}`);
    return { ok: false };
  }
}

// --- Auth check ---

function checkAuth(req: Request): Response | null {
  const secret = clusterSecret();
  if (!secret) {
    return new Response(JSON.stringify({ error: "cluster secret not configured" }), {
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

export async function clusterHttpGet(
  machine: ClusterMachine,
  path: string,
): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const secret = clusterSecret();
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
    console.error(`ludics: cluster HTTP GET ${path} to ${machine.name} failed: ${msg}`);
    return { ok: false };
  }
}

// --- File-backed intent store (controller-side, runtime dir outside harness) ---

export interface PendingIntent {
  action: "start" | "stop" | "resume";
  epoch: number;
  machine: string;
  taskId?: string;
  preserveState?: boolean;
}

const INTENT_TTL = 900; // seconds

function intentsDir(): string {
  const { stateRepoDir } = require("./config.ts");
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(stateRepoDir());
  const suffix = hasher.digest("hex").slice(0, 8);
  return join(process.env.HOME ?? "/tmp", `.ludics-intents-${suffix}`);
}

function intentFilePath(slot: number): string {
  return join(intentsDir(), `slot-${slot}.json`);
}

export function recordIntent(slot: number, intent: PendingIntent): void {
  const dir = intentsDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(intentFilePath(slot), JSON.stringify(intent) + "\n");
}

export function clearIntent(slot: number): void {
  const file = intentFilePath(slot);
  try { if (existsSync(file)) { const { unlinkSync } = require("fs"); unlinkSync(file); } } catch { /* ignore */ }
}

export function getIntentForDashboard(slot: number): PendingIntent | null {
  const file = intentFilePath(slot);
  if (!existsSync(file)) return null;
  try {
    const intent = JSON.parse(readFileSync(file, "utf-8")) as PendingIntent;
    if ((Math.floor(Date.now() / 1000) - intent.epoch) >= INTENT_TTL) {
      clearIntent(slot);
      return null;
    }
    return intent;
  } catch { return null; }
}

function getIntentsForMachine(machine: string): Record<number, PendingIntent> {
  const now = Math.floor(Date.now() / 1000);
  const result: Record<number, PendingIntent> = {};
  const dir = intentsDir();
  if (!existsSync(dir)) return result;
  try {
    const { readdirSync } = require("fs");
    for (const file of readdirSync(dir) as string[]) {
      const match = file.match(/^slot-(\d+)\.json$/);
      if (!match) continue;
      const slot = Number(match[1]);
      try {
        const intent = JSON.parse(readFileSync(join(dir, file), "utf-8")) as PendingIntent;
        if (intent.machine === machine && (now - intent.epoch) < INTENT_TTL) {
          result[slot] = intent;
        } else if ((now - intent.epoch) >= INTENT_TTL) {
          clearIntent(slot);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return result;
}

function expireStaleIntents(): void {
  const dir = intentsDir();
  if (!existsSync(dir)) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    const { readdirSync } = require("fs");
    for (const file of readdirSync(dir) as string[]) {
      const match = file.match(/^slot-(\d+)\.json$/);
      if (!match) continue;
      try {
        const intent = JSON.parse(readFileSync(join(dir, file), "utf-8")) as PendingIntent;
        if ((now - intent.epoch) >= INTENT_TTL) clearIntent(Number(match[1]));
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
}

// --- Client helpers for worker → controller communication ---

async function resolveAndPost(path: string, body: object): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const { resolveController } = await import("./cluster.ts");
  const controller = resolveController();
  if (!controller) return { ok: false };
  return clusterHttpPost(controller, path, body);
}

async function resolveAndGet(path: string): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  const { resolveController } = await import("./cluster.ts");
  const controller = resolveController();
  if (!controller) return { ok: false };
  return clusterHttpGet(controller, path);
}

export async function clusterPostJournal(category: string, message: string): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/cluster/journal", { category, message });
}

export async function clusterPostEvent(event: object): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/cluster/event", event);
}

export async function clusterPostOrchestrationState(slot: number, state: object): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/cluster/orchestration-state", { slot, state });
}

export async function clusterGetOrchestrationState(slot: number): Promise<{ ok: boolean; data?: unknown }> {
  return resolveAndGet(`/api/cluster/orchestration-state/${slot}`);
}

export async function clusterPostTaskUpdate(taskId: string, field: string, value: string): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/cluster/task-update", { taskId, field, value });
}

export async function clusterPostTaskSectionAppend(taskId: string, section: string, line: string): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/cluster/task-section-append", { taskId, section, line });
}

export async function clusterGetTask(taskId: string): Promise<{ ok: boolean; data?: string }> {
  const result = await resolveAndGet(`/api/cluster/task/${taskId}`);
  return { ok: result.ok, data: typeof result.data === "string" ? result.data : undefined };
}

export async function clusterGetSlots(): Promise<{ ok: boolean; data?: Map<number, SlotData> }> {
  const result = await resolveAndGet("/api/cluster/slots/json");
  if (!result.ok || !result.data) return { ok: false };
  const payload = result.data as { slots?: SlotData[] };
  if (!payload.slots) return { ok: false };
  const map = new Map<number, SlotData>();
  for (const s of payload.slots) map.set(s.slot, s);
  return { ok: true, data: map };
}

export async function clusterPostSlotUpdate(slot: number, sections: Record<string, string | undefined>): Promise<{ ok: boolean }> {
  return resolveAndPost("/api/cluster/slot-update", { slot, ...sections });
}

export async function clusterGetIntents(): Promise<{ ok: boolean; data?: Record<number, PendingIntent> }> {
  const result = await resolveAndGet("/api/cluster/intents");
  return { ok: result.ok, data: result.data as Record<number, PendingIntent> | undefined };
}

export async function clusterDeleteIntent(slot: number): Promise<{ ok: boolean }> {
  const { resolveController } = await import("./cluster.ts");
  const controller = resolveController();
  if (!controller) return { ok: false };
  const secret = clusterSecret();
  const url = `${machineBaseUrl(controller)}/api/cluster/intent/${slot}`;
  const headers: Record<string, string> = {};
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(url, { method: "DELETE", headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) return { ok: true };
  } catch { /* ignore */ }
  return { ok: false };
}

export async function clusterReportWorkerSignal(
  slot: number, taskId: string, status: string, message: string,
): Promise<void> {
  const { resolveController, clusterCurrentMachineName } = await import("./cluster.ts");
  const controller = resolveController();
  if (!controller) return;
  const machine = clusterCurrentMachineName() ?? "";
  const epoch = Math.floor(Date.now() / 1000);
  await clusterHttpPost(controller, "/cluster/signal", {
    slot, taskId, status, message, machine, epoch,
  });
}

// --- Server handlers ---

const SIGNAL_MAX_AGE_SECONDS = 1800; // 30 minutes

/**
 * Pure validation of a worker signal against current slot state.
 * Returns `{ valid: true }` on success, or `{ valid: false; reason; httpStatus }` on failure.
 * Pass `nowEpoch` explicitly in tests for deterministic TTL checks.
 */
export function validateSignal(
  signal: { taskId: string; machine: string; epoch: number },
  slotTaskId: string,
  slotMachine: string,
  nowEpoch: number = Math.floor(Date.now() / 1000),
): { valid: true } | { valid: false; reason: string; httpStatus: number } {
  if (signal.taskId !== slotTaskId) {
    return { valid: false, reason: "stale-task", httpStatus: 409 };
  }
  if (!signal.machine) {
    return { valid: false, reason: "missing-machine", httpStatus: 400 };
  }
  if (slotMachine && slotMachine !== "null" && slotMachine !== signal.machine) {
    return { valid: false, reason: "machine-mismatch", httpStatus: 409 };
  }
  if (signal.epoch > 0 && (nowEpoch - signal.epoch) > SIGNAL_MAX_AGE_SECONDS) {
    return { valid: false, reason: "expired", httpStatus: 409 };
  }
  return { valid: true };
}

/** Main cluster request dispatcher — called from dashboard-server.ts. */
export async function handleClusterRequest(req: Request, pathname: string): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  // GET endpoints
  if (req.method === "GET") {
    if (pathname === "/api/cluster/slots") return handleGetSlotsMarkdown();
    if (pathname === "/api/cluster/slots/json") return handleGetSlotsJson();
    if (pathname === "/api/cluster/intents") return handleGetIntents(req);
const taskMatch = pathname.match(/^\/api\/cluster\/task\/(.+)$/);
    if (taskMatch) return handleGetTask(taskMatch[1]!);
    const orchMatch = pathname.match(/^\/api\/cluster\/orchestration-state\/(\d+)$/);
    if (orchMatch) return handleGetOrchestrationState(Number(orchMatch[1]));
  }

  // DELETE endpoints
  if (req.method === "DELETE") {
    const intentMatch = pathname.match(/^\/api\/cluster\/intent\/(\d+)$/);
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
    case "/cluster/heartbeat": return handleHeartbeat(body);
    case "/cluster/signal": return await handleSignal(body);
    case "/api/cluster/journal": return handlePostJournal(body);
    case "/api/cluster/event": return handlePostEvent(body);
    case "/api/cluster/orchestration-state": return handlePostOrchestrationState(body);
    case "/api/cluster/task-update": return handlePostTaskUpdate(body);
    case "/api/cluster/task-section-append": return handlePostTaskSectionAppend(body);
    case "/api/cluster/slot-update": return handlePostSlotUpdate(body);
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
  writeJsonFile(heartbeatFile, body);

  console.error(`ludics: cluster HTTP: received heartbeat from ${node}`);
  return jsonResponse(200, { ok: true, node });
}

// --- Signal handler (runs on controller) ---

async function handleSignal(body: Record<string, unknown>): Promise<Response> {
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
  const slotData = readSlotJson(slot);
  if (slotData.process === "(empty)") {
    return jsonResponse(409, { error: `slot ${slot} not found` });
  }

  const currentTaskId = slotData.task ?? "";
  const currentMachine = slotData.machine ?? "";

  const validation = validateSignal(
    { taskId, machine, epoch },
    currentTaskId,
    currentMachine,
  );
  if (!validation.valid) {
    return jsonResponse(validation.httpStatus, { error: `signal rejected: ${validation.reason}` });
  }

  // Also clear any pending intent for this slot
  clearIntent(slot);

  // Process inline
  switch (status) {
    case "done":
      console.error(`ludics: cluster HTTP: task ${taskId} completed on ${machine}`);
      await slotClear(slot, "done");
      emitEvent({
        event_type: "worker_signal_done",
        source: "cluster-http",
        scope: "slot",
        slot,
        task: taskId,
        machine,
        message: message || "completed via HTTP signal",
      });
      break;

    case "error":
      console.error(`ludics: cluster HTTP: task ${taskId} errored on ${machine}: ${message}`);
      emitEvent({
        event_type: "worker_signal_error",
        source: "cluster-http",
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

function handleGetSlotsJson(): Response {
  const count = slotsCount();
  const slots = readAllSlotJson(count);
  const arr: SlotData[] = [];
  for (let i = 1; i <= count; i++) arr.push(slots.get(i)!);
  return jsonResponse(200, { slots: arr });
}

function handleGetSlotsMarkdown(): Response {
  const count = slotsCount();
  const slots = readAllSlotJson(count);
  const parts: string[] = ["# Slots\n\n"];
  for (let i = 1; i <= count; i++) {
    parts.push(slotDataToMarkdown(slots.get(i)!));
    if (i < count) parts.push("\n---\n\n");
  }
  return new Response(parts.join(""), {
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
  // Return all pending intents — scan runtime directory
  const dir = intentsDir();
  const all: Record<number, PendingIntent> = {};
  if (existsSync(dir)) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const { readdirSync } = require("fs");
      for (const file of readdirSync(dir) as string[]) {
        const match = file.match(/^slot-(\d+)\.json$/);
        if (!match) continue;
        try {
          const intent = JSON.parse(readFileSync(join(dir, file), "utf-8")) as PendingIntent;
          if ((now - intent.epoch) < INTENT_TTL) all[Number(match[1])] = intent;
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }
  return jsonResponse(200, { intents: all });
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
    writeJsonFile(join(dir, `slot-${slot}.json`), state);
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

function handlePostTaskSectionAppend(body: Record<string, unknown>): Response {
  const taskId = String(body.taskId ?? "");
  const section = String(body.section ?? "");
  const line = String(body.line ?? "");
  if (!taskId || !section || !line) return jsonResponse(400, { error: "taskId, section, and line required" });
  const TASK_ID_RE = /^[a-z0-9_-]+$/i;
  if (!TASK_ID_RE.test(taskId)) return jsonResponse(400, { error: "invalid task id" });
  const file = join(harnessDir(), "tasks", `${taskId}.md`);
  if (!existsSync(file)) return jsonResponse(404, { error: "task not found" });
  try {
    const { appendToSection } = require("./tasks/markdown.ts");
    appendToSection(file, section, line);
  } catch (err) {
    return jsonResponse(500, { error: String(err) });
  }
  return jsonResponse(200, { ok: true });
}

function handlePostSlotUpdate(body: Record<string, unknown>): Response {
  const slot = Number(body.slot);
  if (!Number.isFinite(slot)) return jsonResponse(400, { error: "slot required" });

  const data = readSlotJson(slot);

  // Merge runtime fields + adapter args (for worker auto-fill)
  if (body.sessionStarted !== undefined) data.sessionStarted = String(body.sessionStarted);
  if (body.liveness !== undefined) data.liveness = String(body.liveness);
  if (body.adapterArgs !== undefined) data.adapterArgs = String(body.adapterArgs);

  // Merge sections (Terminals, Runtime, Git)
  if (typeof body.terminals === "string") data.terminals = body.terminals;
  if (typeof body.runtime === "string") data.runtime = body.runtime;
  if (typeof body.git === "string") data.git = body.git;

  writeSlotJson(slot, data);
  return jsonResponse(200, { ok: true });
}

// --- Helpers ---

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
