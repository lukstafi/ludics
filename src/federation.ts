// Federation — role-aware controller election for multi-machine coordination

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { harnessDir, loadConfigSync } from "./config.ts";
import { networkNodes, networkCurrentNode, hostnameTailscale } from "./network.ts";
import { journalAppend } from "./journal.ts";
import { emitEvent } from "./events.ts";
import { stateCommit, stateCheckpoint, stateCommitImmediate, statePull, statePush } from "./state.ts";

const HEARTBEAT_TIMEOUT = parseInt(process.env.LUDICS_HEARTBEAT_TIMEOUT ?? "900", 10);

// --- Federation machine config ---

export interface FederationMachine {
  name: string;
  host: string;
  os: string;
  role: string;       // "leader" | "console" | "worker"
  always_on: boolean;
  gpu: string;
  ludics_path?: string;
}

interface FederationConfig {
  transport: string;
  domain: string;
  machines: FederationMachine[];
}

export function federationConfig(): FederationConfig {
  try {
    const config = loadConfigSync();
    const raw = config as unknown as Record<string, unknown>;
    const fed = raw.federation as Record<string, unknown> | undefined;
    if (!fed) return { transport: "local", domain: "", machines: [] };

    const rawMachines = fed.machines as Array<Record<string, unknown>> | undefined;
    const machines: FederationMachine[] = (rawMachines ?? [])
      .filter((m) => m && m.name && m.host)
      .map((m) => ({
        name: String(m.name),
        host: String(m.host),
        os: String(m.os ?? "linux"),
        role: String(m.role ?? "worker"),
        always_on: Boolean(m.always_on),
        gpu: String(m.gpu ?? ""),
        ludics_path: m.ludics_path ? String(m.ludics_path) : undefined,
      }));

    return {
      transport: String(fed.transport ?? "local"),
      domain: String(fed.domain ?? ""),
      machines,
    };
  } catch {
    return { transport: "local", domain: "", machines: [] };
  }
}

export function federationEnabled(): boolean {
  const cfg = federationConfig();
  return cfg.transport !== "local" && cfg.machines.length > 0;
}

export function federationMachines(): FederationMachine[] {
  return federationConfig().machines;
}

export function federationMachine(name: string): FederationMachine | undefined {
  return federationMachines().find((m) => m.name === name);
}

export function federationCurrentMachine(): FederationMachine | undefined {
  if (!federationEnabled()) return undefined;

  const tsHost = hostnameTailscale();
  if (!tsHost) return undefined;

  const normalized = tsHost.replace(/\.$/, "").toLowerCase();
  return federationMachines().find((m) => {
    const mHost = m.host.replace(/\.$/, "").toLowerCase();
    return mHost === normalized;
  });
}

export function federationCurrentMachineName(): string | null {
  return federationCurrentMachine()?.name ?? null;
}

function federationDir(): string {
  return join(harnessDir(), "federation");
}

function heartbeatsDir(): string {
  return join(federationDir(), "heartbeats");
}

function leaderFile(): string {
  return join(federationDir(), "leader.json");
}

// --- Heartbeat functions ---

export function heartbeatPublish(): boolean {
  // Prefer federation machine name, fall back to legacy network node name
  const machine = federationCurrentMachine();
  const nodeName = machine?.name ?? networkCurrentNode();

  if (!nodeName) {
    console.error("ludics: federation: cannot determine current node name");
    return false;
  }

  const dir = heartbeatsDir();
  mkdirSync(dir, { recursive: true });

  const magSession = process.env.LUDICS_MAG_SESSION ?? "ludics-mag";
  let magRunning = false;
  const tmuxResult = Bun.spawnSync(["tmux", "has-session", "-t", magSession], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tmuxResult.exitCode === 0) magRunning = true;

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const epoch = Math.floor(Date.now() / 1000);

  const heartbeat = JSON.stringify({
    node: nodeName,
    role: machine?.role ?? "",
    timestamp,
    epoch,
    mag_running: magRunning,
    controller_running: federationIsController(),
  });

  writeFileSync(join(dir, `${nodeName}.json`), heartbeat + "\n");
  emitEvent({ event_type: "federation_heartbeat", source: "federation", scope: "federation", message: nodeName });
  console.error(`ludics: federation: published heartbeat for ${nodeName}`);
  return true;
}

function heartbeatIsFresh(nodeName: string): boolean {
  const file = join(heartbeatsDir(), `${nodeName}.json`);
  if (!existsSync(file)) return false;

  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const heartbeatEpoch = Number(data.epoch ?? 0);
    const nowEpoch = Math.floor(Date.now() / 1000);
    return (nowEpoch - heartbeatEpoch) < HEARTBEAT_TIMEOUT;
  } catch {
    return false;
  }
}

function nodeHasMag(nodeName: string): boolean {
  const file = join(heartbeatsDir(), `${nodeName}.json`);
  if (!existsSync(file)) return false;

  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    return data.mag_running === true;
  } catch {
    return false;
  }
}

// --- Controller election ---

/**
 * Role-aware controller selection:
 * 1. Online leader machine → controller
 * 2. Else online console machine → controller (failover)
 * 3. Else no controller
 *
 * Falls back to legacy seniority-based election when federation.machines is not configured.
 */
function computeController(): string | null {
  const machines = federationMachines();

  if (machines.length > 0) {
    // Prefer online leader
    const leaders = machines.filter((m) => m.role === "leader");
    for (const m of leaders) {
      if (heartbeatIsFresh(m.name)) return m.name;
    }
    // Failover to online console
    const consoles = machines.filter((m) => m.role === "console");
    for (const m of consoles) {
      if (heartbeatIsFresh(m.name)) return m.name;
    }
    return null;
  }

  // Legacy fallback: first online node by seniority
  const nodes = networkNodes();
  for (const node of nodes) {
    if (heartbeatIsFresh(node.name)) return node.name;
  }
  return null;
}

function currentLeader(): string | null {
  const file = leaderFile();
  if (!existsSync(file)) return null;

  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    return (data.node as string) ?? null;
  } catch {
    return null;
  }
}

function currentTerm(): number {
  const file = leaderFile();
  if (!existsSync(file)) return 0;

  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    return Number(data.term ?? 0);
  } catch {
    return 0;
  }
}

function updateLeader(newLeader: string): boolean {
  const file = leaderFile();
  mkdirSync(dirname(file), { recursive: true });

  const current = currentLeader();
  if (current === newLeader) return false; // no change

  const term = currentTerm() + 1;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  writeFileSync(
    file,
    JSON.stringify({ node: newLeader, elected: timestamp, term }) + "\n",
  );

  console.error(`ludics: federation: controller changed to ${newLeader} (term ${term})`);
  try {
    journalAppend("federation", `controller changed to ${newLeader} (term ${term})`);
  } catch {
    // journal may not be available
  }
  emitEvent({ event_type: "federation_leader_change", source: "federation", scope: "federation", message: `controller changed to ${newLeader} (term ${term})` });

  return true;
}

export function federationElect(): string | null {
  const controller = computeController();
  if (controller) {
    updateLeader(controller);
    return controller;
  }
  console.error("ludics: federation: no online nodes available for controller election");
  return null;
}

/** Returns the machine name that should be controller right now. */
export function federationCurrentController(): string | null {
  return currentLeader();
}

export function federationIsLeader(): boolean {
  const currentNode = federationCurrentMachineName() ?? networkCurrentNode();
  if (!currentNode) return false;
  return currentNode === currentLeader();
}

/**
 * Determine this machine's federation role:
 * - "standalone" — no federation configured, everything runs locally
 * - "controller" — this machine is the active controller (leader or console in failover)
 * - "worker" — this machine is a worker, defer controller duties
 */
export function federationRole(): "controller" | "worker" | "standalone" {
  if (!federationEnabled()) {
    // Legacy: check network.nodes for backward compat
    const nodes = networkNodes();
    if (nodes.length === 0) return "standalone";
    return federationIsLeader() ? "controller" : "worker";
  }

  const machine = federationCurrentMachine();
  if (!machine) return "standalone"; // can't determine which machine we are

  if (machine.role === "leader") return "controller";

  if (machine.role === "console") {
    // Failover: check if any leader is online
    const leaders = federationMachines().filter((m) => m.role === "leader");
    const leaderOnline = leaders.some((m) => heartbeatIsFresh(m.name));
    return leaderOnline ? "worker" : "controller";
  }

  return "worker";
}

export function federationIsController(): boolean {
  return federationRole() !== "worker";
}

export function federationShouldRunMag(): boolean {
  return federationIsController();
}

// --- Federation tick ---

export function federationTick(): void {
  console.error("ludics: federation: running tick...");

  try { statePull(); } catch { /* ignore */ }

  const prevController = currentLeader();
  const currentNodeName = federationCurrentMachineName() ?? networkCurrentNode();

  heartbeatPublish();

  const controller = federationElect();
  if (controller) {
    console.error(`ludics: federation: current controller is ${controller}`);
  }

  // Detect role transitions
  if (currentNodeName && prevController !== controller) {
    if (controller === currentNodeName && prevController !== currentNodeName) {
      // This machine just became controller (failover)
      console.error("ludics: federation: THIS MACHINE IS NOW CONTROLLER (failover)");
      emitEvent({ event_type: "federation_failover", source: "federation", scope: "federation", message: `${currentNodeName} became controller (was: ${prevController ?? "none"})` });
    } else if (prevController === currentNodeName && controller !== currentNodeName) {
      // This machine yielded controller role (failback)
      console.error("ludics: federation: yielding controller role (failback)");
      emitEvent({ event_type: "federation_failback", source: "federation", scope: "federation", message: `${currentNodeName} yielded controller to ${controller ?? "none"}` });
    }
  }

  try { stateCheckpoint("federation tick"); } catch { /* ignore */ }

  console.error("ludics: federation: tick complete");
}

// --- Status display ---

function formatNodeStatus(name: string, controller: string): string {
  let status = "offline";
  let heartbeatAge = "";

  const heartbeatFile = join(heartbeatsDir(), `${name}.json`);
  if (existsSync(heartbeatFile)) {
    try {
      const data = JSON.parse(readFileSync(heartbeatFile, "utf-8")) as Record<string, unknown>;
      const hbEpoch = Number(data.epoch ?? 0);
      const age = Math.floor(Date.now() / 1000) - hbEpoch;
      const mins = Math.floor(age / 60);

      if (heartbeatIsFresh(name)) {
        status = "online";
        if (nodeHasMag(name)) status = "online (mag running)";
        heartbeatAge = ` [${mins}m ago]`;
      } else {
        status = `stale [${mins}m ago]`;
      }
    } catch {
      // ignore
    }
  }

  const controllerMarker = name === controller ? " *CONTROLLER*" : "";
  return `${status}${heartbeatAge}${controllerMarker}`;
}

export function federationStatus(): void {
  console.log("=== Federation Status ===");
  console.log("");

  const machine = federationCurrentMachine();
  const currentNode = machine?.name ?? networkCurrentNode() ?? "unknown";
  console.log(`Current node: ${currentNode}`);

  const role = federationRole();
  const controller = currentLeader() ?? "none";
  const term = currentTerm();
  console.log(`Current controller: ${controller} (term ${term})`);

  switch (role) {
    case "controller":
      if (machine?.role === "leader") {
        console.log("Role: controller (leader)");
      } else if (machine?.role === "console") {
        console.log("Role: controller (failover from console)");
      } else {
        console.log("Role: controller");
      }
      break;
    case "worker":
      console.log("Role: worker");
      break;
    case "standalone":
      console.log("Role: standalone (no federation)");
      break;
  }

  // Show federation machines if configured
  const machines = federationMachines();
  if (machines.length > 0) {
    console.log("");
    console.log("Federation machines:");
    for (let i = 0; i < machines.length; i++) {
      const m = machines[i]!;
      const nodeStatus = formatNodeStatus(m.name, controller);
      const gpu = m.gpu ? ` gpu=${m.gpu}` : "";
      console.log(`  ${i + 1}. ${m.name} (${m.role}${gpu}) - ${nodeStatus}`);
    }
  }

  // Show legacy nodes if configured and no federation machines
  if (machines.length === 0) {
    console.log("");
    console.log("Configured nodes (by seniority):");
    const nodes = networkNodes();
    if (nodes.length === 0) {
      console.log("  (no nodes configured)");
      console.log("");
      console.log("Federation is disabled - Mag will run on any machine.");
    } else {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const nodeStatus = formatNodeStatus(node.name, controller);
        console.log(`  ${i + 1}. ${node.name} - ${nodeStatus}`);
      }
    }
  }

  // Check for missing roles
  if (machines.length > 0) {
    const hasLeader = machines.some((m) => m.role === "leader");
    const hasConsole = machines.some((m) => m.role === "console");
    if (!hasLeader) {
      console.log("");
      console.log("WARNING: no machine with role 'leader' configured");
    }
    if (!hasConsole) {
      console.log("");
      console.log("NOTE: no console machine configured — no failover possible if leader goes offline");
    }
  }

  console.log("");
  if (federationIsController()) {
    console.log("Mag permission: ALLOWED (this node is controller)");
  } else {
    console.log("Mag permission: BLOCKED (defer to controller)");
  }
}

export async function runFederation(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "status":
    case "":
      federationStatus();
      break;
    case "tick":
      federationTick();
      break;
    case "elect":
      federationElect();
      break;
    case "heartbeat":
      heartbeatPublish();
      break;
    case "ping": {
      const target = args[1];
      if (!target) throw new Error("usage: ludics federation ping <machine-name>");
      const { remotePing } = await import("./remote.ts");
      const ok = remotePing(target);
      console.log(`${target}: ${ok ? "reachable" : "unreachable"}`);
      break;
    }
    default:
      throw new Error(`unknown federation command: ${sub} (use: status, tick, elect, heartbeat, ping)`);
  }
}
