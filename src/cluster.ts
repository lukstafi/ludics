// Cluster — static controller role for multi-machine coordination

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { harnessDir, loadConfigSync, stateRepoDir } from "./config.ts";
import { safeSyncOutput } from "./spawn.ts";
import { hostnameTailscale } from "./network.ts";
import { emitEvent } from "./events.ts";

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

export function heartbeatsDir(): string {
  // Runtime dir outside harness — never committed to git
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(stateRepoDir());
  const suffix = hasher.digest("hex").slice(0, 8);
  return join(process.env.HOME ?? "/tmp", `.ludics-heartbeats-${suffix}`);
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
  if (!clusterIsController()) {
    const controller = resolveController();
    if (controller) {
      import("./cluster-http.ts").then(async ({ clusterHttpPost }) => {
        await clusterHttpPost(controller, "/cluster/heartbeat", heartbeatData);
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

// --- Controller resolution ---

/**
 * Resolve the controller machine from config.
 * Returns the single machine with role "leader", or null if none configured.
 */
export function resolveController(): ClusterMachine | null {
  const machines = clusterMachines();
  return machines.find(m => m.role === "leader") ?? null;
}

/**
 * Determine this machine's cluster role:
 * - "standalone" — no cluster configured, everything runs locally
 * - "controller" — this machine has role "leader" in config
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

  return machine.role === "leader" ? "controller" : "worker";
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
  heartbeatPublish();
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
  const leaderMachine = resolveController();
  const controllerName = leaderMachine?.name ?? "none";

  switch (role) {
    case "controller":
      console.log("Role: controller (leader)");
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
      const nodeStatus = formatNodeStatus(m.name, controllerName);
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
    if (!hasLeader) {
      console.log("");
      console.log("WARNING: no machine with role 'leader' configured");
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
    case "heartbeat":
      heartbeatPublish();
      break;
    case "ping": {
      const target = args[1];
      if (!target) throw new Error("usage: ludics cluster ping <machine-name>");
      const targetMachine = clusterMachine(target);
      if (!targetMachine) throw new Error(`unknown machine: ${target}`);
      const { clusterHttpGet } = await import("./cluster-http.ts");
      const result = await clusterHttpGet(targetMachine, "/api/cluster/slots");
      console.log(`${target}: ${result.ok ? "reachable" : "unreachable"}`);
      break;
    }
    default:
      throw new Error(`unknown cluster command: ${sub} (use: status, tick, heartbeat, ping)`);
  }
}
