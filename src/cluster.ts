// Cluster — static controller role for multi-machine coordination

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { harnessDir, loadConfigSync, stateRepoDir } from "./config.ts";
import { safeSyncOutput } from "./spawn.ts";
import { hostnameTailscale } from "./network.ts";
import { journalAppend } from "./journal.ts";
import { emitEvent } from "./events.ts";
// State imports removed — cluster tick no longer calls statePull/statePush.
// Git sync happens only at health-check periodicity.

const HEARTBEAT_TIMEOUT = parseInt(process.env.LUDICS_HEARTBEAT_TIMEOUT ?? "900", 10);

// --- Cluster machine config ---

export interface ClusterMachine {
  name: string;
  host: string;
  os: string;
  role: string;       // "leader" | "console" | "worker"
  always_on: boolean;
  gpu: string;
  ludics_path?: string;
  dashboard_port?: number;
}

interface ClusterConfig {
  transport: string;
  domain: string;
  machines: ClusterMachine[];
}

export function clusterConfig(): ClusterConfig {
  try {
    const config = loadConfigSync();
    const raw = config as unknown as Record<string, unknown>;
    const fed = raw.cluster as Record<string, unknown> | undefined;

    const rawMachines = (fed?.machines as Array<Record<string, unknown>> | undefined) ?? [];
    let machines: ClusterMachine[] = rawMachines
      .filter((m) => m && m.name && m.host)
      .map((m) => ({
        name: String(m.name),
        host: String(m.host),
        os: String(m.os ?? "linux"),
        role: String(m.role ?? "worker"),
        always_on: Boolean(m.always_on),
        gpu: String(m.gpu ?? ""),
        ludics_path: m.ludics_path ? String(m.ludics_path) : undefined,
        dashboard_port: m.dashboard_port ? Number(m.dashboard_port) : undefined,
      }));

    const transport = String(fed?.transport ?? "local");
    // Compat: derive transport from legacy network.mode if not set
    let effectiveTransport = transport;
    if (transport === "local" && machines.length > 0) {
      const net = raw.network as Record<string, unknown> | undefined;
      const legacyMode = net?.mode as string | undefined;
      if (legacyMode && legacyMode !== "localhost") effectiveTransport = legacyMode;
    }

    return {
      transport: effectiveTransport,
      domain: String(fed?.domain ?? ""),
      machines,
    };
  } catch {
    return { transport: "local", domain: "", machines: [] };
  }
}

export function clusterEnabled(): boolean {
  const cfg = clusterConfig();
  return cfg.transport !== "local" && cfg.machines.length > 0;
}

export function clusterMachines(): ClusterMachine[] {
  return clusterConfig().machines;
}

export function clusterMachine(name: string): ClusterMachine | undefined {
  return clusterMachines().find((m) => m.name === name);
}

export function clusterCurrentMachine(): ClusterMachine | undefined {
  if (!clusterEnabled()) return undefined;

  const machines = clusterMachines();

  // Collect candidate hostnames: Tailscale DNS, system hostname, OS hostname
  const candidates: string[] = [];
  const tsHost = hostnameTailscale();
  if (tsHost) candidates.push(tsHost);

  // Fallback: system hostname (works for ssh transport or when Tailscale is down)
  const sysResult = safeSyncOutput(["hostname"]);
  if (sysResult.ok && sysResult.stdout) candidates.push(sysResult.stdout);

  for (const host of candidates) {
    const normalized = host.replace(/\.$/, "").toLowerCase();
    const match = machines.find((m) => {
      const mHost = m.host.replace(/\.$/, "").toLowerCase();
      // Match full host or just the hostname prefix (before first dot)
      return mHost === normalized || mHost.split(".")[0] === normalized;
    });
    if (match) return match;
  }

  // Also try matching by machine name directly (e.g., name: "desktop" matches hostname "desktop")
  for (const host of candidates) {
    const normalized = host.replace(/\.$/, "").toLowerCase();
    const prefix = normalized.split(".")[0];
    const nameMatch = machines.find((m) => {
      const mName = m.name.toLowerCase();
      // Exact match, or machine name appears in hostname prefix
      // (e.g., name "mac-studio" matches hostname "lukaszs-mac-studio.fritz.box")
      return mName === normalized || mName === prefix || prefix.includes(mName);
    });
    if (nameMatch) return nameMatch;
  }

  return undefined;
}

export function clusterCurrentMachineName(): string | null {
  return clusterCurrentMachine()?.name ?? null;
}

function clusterDir(): string {
  return join(harnessDir(), "cluster");
}

export function heartbeatsDir(): string {
  // Runtime dir outside harness — never committed to git
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(stateRepoDir());
  const suffix = hasher.digest("hex").slice(0, 8);
  return join(process.env.HOME ?? "/tmp", `.ludics-heartbeats-${suffix}`);
}

function leaderFile(): string {
  return join(clusterDir(), "leader.json");
}

// --- Heartbeat functions ---

export function heartbeatPublish(): boolean {
  const machine = clusterCurrentMachine();
  const nodeName = machine?.name ?? null;

  if (!nodeName) {
    console.error("ludics: cluster: cannot determine current node name");
    return false;
  }

  const dir = heartbeatsDir();
  mkdirSync(dir, { recursive: true });

  const magSession = process.env.LUDICS_MAG_SESSION ?? "ludics-mag";
  const magRunning = safeSyncOutput(["tmux", "has-session", "-t", magSession]).ok;

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const epoch = Math.floor(Date.now() / 1000);

  const heartbeatData = {
    node: nodeName,
    role: machine?.role ?? "",
    timestamp,
    epoch,
    mag_running: magRunning,
    controller_running: clusterIsController(),
  };

  // Write local heartbeat file
  writeFileSync(join(dir, `${nodeName}.json`), JSON.stringify(heartbeatData) + "\n");
  emitEvent({ event_type: "cluster_heartbeat", source: "cluster", scope: "cluster", message: nodeName });
  console.error(`ludics: cluster: published heartbeat for ${nodeName}`);

  // POST heartbeat to controller via HTTP (workers only — controller's own heartbeat is already local).
  // Uses resolveControllerCandidates() instead of currentLeader() to avoid stale leader.json.
  if (!clusterIsController()) {
    const candidates = resolveControllerCandidates();
    if (candidates.length > 0) {
      // Fire-and-forget — try candidates in priority order until one accepts
      import("./cluster-http.ts").then(async ({ clusterHttpPost }) => {
        for (const candidate of candidates) {
          const result = await clusterHttpPost(candidate, "/cluster/heartbeat", heartbeatData);
          if (result.ok) break; // delivered to controller
        }
      }).catch(() => {});
    }
  }

  return true;
}

export function heartbeatIsFresh(nodeName: string): boolean {
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

 */
function computeController(): string | null {
  const machines = clusterMachines();

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

  console.error(`ludics: cluster: controller changed to ${newLeader} (term ${term})`);
  try {
    journalAppend("cluster", `controller changed to ${newLeader} (term ${term})`);
  } catch {
    // journal may not be available
  }
  emitEvent({ event_type: "cluster_leader_change", source: "cluster", scope: "cluster", message: `controller changed to ${newLeader} (term ${term})` });

  return true;
}

export function clusterElect(): string | null {
  const controller = computeController();
  if (controller) {
    updateLeader(controller);
    return controller;
  }
  console.error("ludics: cluster: no online nodes available for controller election");
  return null;
}

/** Returns the machine name that should be controller right now (from local leader.json). */
export function clusterCurrentController(): string | null {
  return currentLeader();
}

/**
 * Resolve the controller machine for worker-side HTTP delivery.
 * Does NOT depend on leader.json (which may be stale on workers).
 * Returns machines in role priority: leader first, then consoles.
 * Caller should try them in order until one responds.
 */
export function resolveControllerCandidates(): ClusterMachine[] {
  const machines = clusterMachines();
  const leaders = machines.filter((m) => m.role === "leader");
  const consoles = machines.filter((m) => m.role === "console");
  return [...leaders, ...consoles];
}

export function clusterIsLeader(): boolean {
  const currentNode = clusterCurrentMachineName();
  if (!currentNode) return false;
  return currentNode === currentLeader();
}

/**
 * Determine this machine's cluster role:
 * - "standalone" — no cluster configured, everything runs locally
 * - "controller" — this machine is the active controller (leader or console in failover)
 * - "worker" — this machine is a worker, defer controller duties
 */
export function clusterRole(): "controller" | "worker" | "standalone" {
  if (!clusterEnabled()) return "standalone";

  const machine = clusterCurrentMachine();
  if (!machine) {
    // Cluster is enabled but this host doesn't match any configured machine.
    // Safe default: treat as worker (don't run controller duties) to avoid split-brain.
    console.error("ludics: cluster: WARNING — this host not found in cluster.machines; defaulting to worker role");
    return "worker";
  }

  if (machine.role === "leader") return "controller";

  if (machine.role === "console") {
    // Failover: check if any leader is online
    const leaders = clusterMachines().filter((m) => m.role === "leader");
    const leaderOnline = leaders.some((m) => heartbeatIsFresh(m.name));
    if (leaderOnline) return "worker";
    // Among consoles, only the first online (by config order) becomes controller.
    // This preserves seniority-based failover and prevents split-brain with
    // multiple consoles (including legacy network.nodes converted to consoles).
    // Treat the current machine as implicitly online — it's running this code.
    const currentName = machine.name;
    const consoles = clusterMachines().filter((m) => m.role === "console");
    const firstOnlineConsole = consoles.find((m) => m.name === currentName || heartbeatIsFresh(m.name));
    return firstOnlineConsole?.name === currentName ? "controller" : "worker";
  }

  return "worker";
}

export function clusterIsController(): boolean {
  return clusterRole() !== "worker";
}

export function clusterShouldRunMag(): boolean {
  return clusterIsController();
}

// --- Cluster tick ---

export async function clusterTick(): Promise<void> {
  console.error("ludics: cluster: running tick...");

  // No statePull() here — heartbeats arrive via HTTP, signals arrive via HTTP,
  // intents are delivered via HTTP. Git sync only happens at health-check periodicity.

  const prevController = currentLeader();
  const currentNodeName = clusterCurrentMachineName();

  heartbeatPublish();

  const controller = clusterElect();
  if (controller) {
    console.error(`ludics: cluster: current controller is ${controller}`);
  }

  // Detect role transitions
  if (currentNodeName && prevController !== controller) {
    if (controller === currentNodeName && prevController !== currentNodeName) {
      // This machine just became controller (failover)
      console.error("ludics: cluster: THIS MACHINE IS NOW CONTROLLER (failover)");
      emitEvent({ event_type: "cluster_failover", source: "cluster", scope: "cluster", message: `${currentNodeName} became controller (was: ${prevController ?? "none"})` });
    } else if (prevController === currentNodeName && controller !== currentNodeName) {
      // This machine yielded controller role (failback)
      console.error("ludics: cluster: yielding controller role (failback)");
      emitEvent({ event_type: "cluster_failback", source: "cluster", scope: "cluster", message: `${currentNodeName} yielded controller to ${controller ?? "none"}` });
    }
  }

  // State is written to disk but NOT committed — periodic health-check
  // handles git commits at lower frequency. All coordination (intents,
  // heartbeats, signals) now uses HTTP, not git.

  console.error("ludics: cluster: tick complete");
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

export function clusterStatus(): void {
  console.log("=== Cluster Status ===");
  console.log("");

  const machine = clusterCurrentMachine();
  const currentNode = machine?.name ?? "unknown";
  console.log(`Current node: ${currentNode}`);

  const role = clusterRole();
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
      console.log("Role: standalone (no cluster)");
      break;
  }

  // Show cluster machines if configured
  const machines = clusterMachines();
  if (machines.length > 0) {
    console.log("");
    console.log("Cluster machines:");
    for (let i = 0; i < machines.length; i++) {
      const m = machines[i]!;
      const nodeStatus = formatNodeStatus(m.name, controller);
      const gpu = m.gpu ? ` gpu=${m.gpu}` : "";
      console.log(`  ${i + 1}. ${m.name} (${m.role}${gpu}) - ${nodeStatus}`);
    }
  }

  if (machines.length === 0) {
    console.log("");
    console.log("No cluster machines configured — Mag will run on any machine.");
    console.log("Configure cluster.machines in config.yaml for multi-machine coordination.");
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
  if (clusterIsController()) {
    console.log("Mag permission: ALLOWED (this node is controller)");
  } else {
    console.log("Mag permission: BLOCKED (defer to controller)");
  }
}

// --- Machine selection for slot assignment ---

/**
 * Select which machine should run a task.
 * Returns current machine name if no cluster or no suitable remote workers.
 */
export function selectMachineForSlot(
  _task: { project: string; effort: string; requirements?: { os?: string; gpu?: string } },
): string | null {
  if (!clusterEnabled()) return "";

  const current = clusterCurrentMachineName();
  if (!current) return "";

  const machines = clusterMachines();

  // Filter by task requirements first (all machines, not just online)
  let eligible = [...machines];
  const reqs = _task.requirements;
  if (reqs) {
    if (reqs.os) eligible = eligible.filter((m) => m.os === reqs.os);
    if (reqs.gpu) eligible = eligible.filter((m) => m.gpu === reqs.gpu);
    if (eligible.length === 0) {
      console.error(`ludics: no cluster machine meets requirements (os=${reqs.os ?? "any"}, gpu=${reqs.gpu ?? "any"}) — ${machines.length} machines checked`);
      return null;
    }
  }

  // Among eligible, prefer online machines
  const online = eligible.filter((m) => heartbeatIsFresh(m.name));

  // Pick from online if available, otherwise from all eligible (task will wait for machine to come online)
  const pool = online.length > 0 ? online : eligible;

  // Primary signal: prefer always_on machines; tiebreak: prefer non-current for load balance
  const alwaysOn = pool.filter((m) => m.always_on);
  if (alwaysOn.length > 0) {
    const remote = alwaysOn.find((m) => m.name !== current);
    return remote ? remote.name : alwaysOn[0]!.name;
  }

  // No always_on machines eligible — prefer non-current for load balance
  const other = pool.filter((m) => m.name !== current);
  if (other.length > 0) return other[0]!.name;

  return pool[0]?.name ?? current;
}

export async function runCluster(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "status":
    case "":
      clusterStatus();
      break;
    case "tick":
      await clusterTick();
      break;
    case "elect":
      clusterElect();
      break;
    case "heartbeat":
      heartbeatPublish();
      break;
    case "ping": {
      const target = args[1];
      if (!target) throw new Error("usage: ludics cluster ping <machine-name>");
      const targetMachine = clusterMachine(target);
      if (!targetMachine) throw new Error(`unknown machine: ${target}`);
      const { clusterHttpGet } = await import("./cluster-http.ts");
      const result = await clusterHttpGet(targetMachine, "/api/cluster/leader");
      console.log(`${target}: ${result.ok ? "reachable" : "unreachable"}`);
      break;
    }
    default:
      throw new Error(`unknown cluster command: ${sub} (use: status, tick, elect, heartbeat, ping)`);
  }
}
