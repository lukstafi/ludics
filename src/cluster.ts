// Cluster — static controller role for multi-machine coordination

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { loadConfigSync, stateRepoDir } from "./config.ts";
import { clusterSecret } from "./cluster-http.ts";
import { safeSyncOutput } from "./spawn.ts";
import { hostnameTailscale } from "./network.ts";
import { emitEvent } from "./events.ts";
import { writeJsonFileCompact } from "./json.ts";

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
  // When true, machines with role "console" are never selected to run worker
  // slots and are never auto-started by the keepalive — frees the console box
  // for interactive/SSH use. Maps from YAML `cluster.disable_console_workers`.
  // Defaults to false for back-compat.
  disableConsoleWorkers: boolean;
}

export function clusterConfig(): ClusterConfig {
  try {
    const config = loadConfigSync();
    const raw = config as unknown as Record<string, unknown>;
    const fed = raw.cluster as Record<string, unknown> | undefined;

    const rawMachines = (fed?.machines as Array<Record<string, unknown>> | undefined) ?? [];
    const machines: ClusterMachine[] = rawMachines
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

    return {
      transport,
      domain: String(fed?.domain ?? ""),
      machines,
      disableConsoleWorkers: Boolean(fed?.disable_console_workers ?? false),
    };
  } catch {
    return { transport: "local", domain: "", machines: [], disableConsoleWorkers: false };
  }
}

/**
 * Whether console-role machines are barred from running worker slots.
 * Reads `cluster.disable_console_workers` (default false). Used by
 * `selectMachineForSlot` (excludes console from the candidate set) and the
 * keepalive auto-start path (skips slots assigned to a console machine).
 */
export function disableConsoleWorkers(): boolean {
  return clusterConfig().disableConsoleWorkers;
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

/**
 * Whether a system hostname prefix (the part before the first dot, lowercased)
 * should be considered to identify a configured machine `machineName`.
 *
 * Boundaried match — return true only when the machine name equals the host
 * prefix, OR is a boundaried suffix of it (separated by `-` or `.`). This
 * preserves the legitimate case `lukaszs-mac-studio` ↔ `mac-studio` while
 * rejecting an unbounded substring false-match such as a short name `mac`
 * matching host prefix `mac-studio`. Both args are expected already
 * lowercased/normalized by the caller; we normalize defensively (it's cheap).
 */
export function hostPrefixMatchesMachineName(hostPrefix: string, machineName: string): boolean {
  const hp = hostPrefix.replace(/\.$/, "").toLowerCase();
  const mn = machineName.replace(/\.$/, "").toLowerCase();
  if (!hp || !mn) return false;
  return hp === mn || hp.endsWith("-" + mn) || hp.endsWith("." + mn);
}

export function clusterCurrentMachine(): ClusterMachine | undefined {
  if (!clusterEnabled()) return undefined;

  const machines = clusterMachines();

  // Explicit override (used by tests and any deployment where hostname matching is
  // unreliable): resolve the current machine directly by name.
  const override = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  if (override) return machines.find((m) => m.name === override);

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
      // Exact (full-host) match, or boundaried prefix/suffix match
      // (e.g., name "mac-studio" matches hostname "lukaszs-mac-studio.fritz.box")
      return mName === normalized || hostPrefixMatchesMachineName(prefix, mName);
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
  writeJsonFileCompact(join(dir, `${nodeName}.json`), heartbeatData);
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

  // Self-heal: on a confidently-identified leader (the 300s `com.ludics.cluster`
  // trigger carries the plist `LUDICS_CLUSTER_MACHINE_NAME` override, so this
  // path KNOWS it is the leader), re-enable any controller unit launchd has been
  // left in its persistent `disabled` state (gh-ludics-587). Workers must never
  // run this. Dynamic import avoids a module-load cycle (triggers.ts imports
  // cluster.ts), mirroring the cluster-http.ts dynamic-import pattern above.
  // Best-effort: next tick retries.
  if (clusterRole() === "controller") {
    await import("./triggers.ts")
      .then(({ reconcileControllerUnits }) => reconcileControllerUnits())
      .catch(() => {});
  }

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

  // gh-ludics-602 predicate — a ludics SELF-modifying task. Hoisted so the
  // disable_console_workers block below can preserve gh-602's controller-
  // exclusion half while the console-preference branch further down keeps using
  // the same set. Matches gh-602 exactly (project name == "ludics", case-insensitive).
  const isLudicsSelfTask = (_task.project ?? "").toLowerCase() === "ludics";

  // disable_console_workers: a faithful 180° of gh-ludics-602's console-routing
  // half. gh-602 has two halves — (1) keep ludics self-modifying tasks OFF the
  // controller/leader (self-orchestration there repoints the global `ludics`
  // symlink + boots the dashboard), and (2) PREFER/route them to the console as
  // the escape hatch. This flag reverses ONLY half (2): the console flips from
  // preferred to FORBIDDEN for ALL worker slots (frees the console box for
  // interactive/SSH use). Half (1) stays. Net for a ludics self-task with the
  // flag on: console AND controller/leader are both forbidden, so if no other
  // eligible worker exists the candidate set empties and we BLOCK (return null)
  // rather than ever falling back to the controller. Applied AFTER the
  // requirement filter so a requirement-driven empty set keeps its specific
  // message.
  if (clusterConfig().disableConsoleWorkers) {
    // Half (2) reversed: console is forbidden for every task.
    eligible = eligible.filter((m) => m.role !== "console");
    // Half (1) preserved: ludics self-tasks additionally stay off the
    // controller/leader — never let them fall back onto it.
    if (isLudicsSelfTask) {
      eligible = eligible.filter((m) => m.role !== "leader");
    }
    if (eligible.length === 0) {
      console.error(`ludics: disable_console_workers is set — no eligible machine for ${isLudicsSelfTask ? "ludics self-task (console + controller forbidden)" : "task (console forbidden)"} — blocking assignment`);
      return null;
    }
  }

  // Among eligible, prefer online machines
  const online = eligible.filter((m) => heartbeatIsFresh(m.name));

  // AC10: for tasks with explicit requirements (cross-machine routing), require a
  // fresh-heartbeat (online) eligible machine. If none is online, block assignment
  // (return null) rather than stamping a slot that idles waiting for an offline
  // worker to wake. Tasks without requirements keep the prior fallback below.
  const hasReqs = !!(reqs && (reqs.os || reqs.gpu));
  if (hasReqs && online.length === 0) {
    console.error(`ludics: no ONLINE cluster machine meets requirements (os=${reqs!.os ?? "any"}, gpu=${reqs!.gpu ?? "any"}) — blocking assignment, will retry`);
    return null;
  }

  // Pick from online if available, otherwise from all eligible (task will wait for machine to come online)
  const pool = online.length > 0 ? online : eligible;

  // gh-ludics-602: keep ludics SELF-tasks off the watched controller. When a
  // live (fresh-heartbeat) console node exists, route there so a per-worktree
  // `ludics init` can't bootout the controller's dashboard / repoint its global
  // binary. Restrict to `online` (NOT `pool`, which may have fallen back to
  // offline `eligible`): only route off the controller when a worker is truly
  // up; otherwise fall through to the controller fallback below. Applied AFTER
  // the requirement filter + online gate, so it composes with — never overrides
  // — hard requirements: a console node that fails the requirement filter is
  // absent from `online` and cannot be resurrected here.
  //
  // When disable_console_workers is on, the console was already removed from
  // `eligible`/`online` above, so this branch is inert for that case (the
  // controller-exclusion half is enforced upstream); it remains the active
  // gh-602 path only with the flag OFF (default, full back-compat).
  if (isLudicsSelfTask) {
    const consolePref = online.filter((m) => m.role !== "leader" && m.role === "console");
    if (consolePref.length > 0) return consolePref[0]!.name;
    // else: fall through to the always_on ranking below → controller fallback.
  }

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

/**
 * Capability + online filter shared with test-health routing (gh-ludics-578).
 * Mirrors `selectMachineForSlot`'s per-key exact-equality requirement filter
 * (above) plus its `heartbeatIsFresh` online gate, but returns the full
 * `ClusterMachine` (routing needs `.host` for SSH) and *any* fresh-heartbeat
 * capable machine — no load-balancing tiebreak is needed for a health probe.
 *
 * The current (requirement-unmet) host cannot pass the capability filter, so it
 * is excluded by construction — no non-current special-casing is required.
 * Returns null when the cluster is disabled, no machine is capable, or no
 * capable machine is online. If `selectMachineForSlot`'s filter changes, mirror
 * it here.
 */
export function selectOnlineCapableMachine(
  reqs: { os?: string; gpu?: string },
): ClusterMachine | null {
  if (!clusterEnabled()) return null;
  let eligible = clusterMachines();
  if (reqs.os) eligible = eligible.filter((m) => m.os === reqs.os);
  if (reqs.gpu) eligible = eligible.filter((m) => m.gpu === reqs.gpu);
  const online = eligible.filter((m) => heartbeatIsFresh(m.name));
  return online[0] ?? null;
}

// --- WSL2 / systemd-user persistence (AC 8) ---

/**
 * Detect a WSL2 environment. `osrelease`/`distroEnv` overrides are for tests.
 */
export function isWsl(opts?: { osrelease?: string; distroEnv?: string }): boolean {
  const distroEnv = opts?.distroEnv ?? process.env.WSL_DISTRO_NAME ?? process.env.WSL_INTEROP ?? "";
  if (distroEnv) return true;
  let osrelease = opts?.osrelease;
  if (osrelease === undefined) {
    try { osrelease = readFileSync("/proc/sys/kernel/osrelease", "utf-8"); }
    catch { osrelease = ""; }
  }
  return /microsoft|wsl/i.test(osrelease);
}

/**
 * WSL2 persistence preconditions for the systemd-user keepalive timer to fire
 * (AC 8): systemd must be PID 1 (`/etc/wsl.conf` `[boot] systemd=true`) and the
 * user session must linger so `systemctl --user` timers survive logout. Probes are
 * injectable for tests; `lingerEnabled` returns null when `loginctl` is unavailable.
 */
export function wslPersistenceStatus(opts?: {
  isWslOverride?: boolean;
  systemdIsPid1?: () => boolean;
  lingerEnabled?: () => boolean | null;
}): { applicable: boolean; ok: boolean; lines: string[] } {
  const applicable = opts?.isWslOverride ?? isWsl();
  if (!applicable) return { applicable: false, ok: true, lines: [] };

  const lines: string[] = [];
  let ok = true;

  const systemdPid1 = opts?.systemdIsPid1
    ? opts.systemdIsPid1()
    : safeSyncOutput(["ps", "-p", "1", "-o", "comm="]).stdout.trim() === "systemd";
  if (systemdPid1) {
    lines.push("WSL2 systemd: PID 1 ✓");
  } else {
    ok = false;
    lines.push("WSL2 systemd: NOT PID 1 — set /etc/wsl.conf [boot] systemd=true, then `wsl --shutdown` from Windows and reopen");
  }

  const linger = opts?.lingerEnabled
    ? opts.lingerEnabled()
    : defaultLingerEnabled();
  if (linger === true) {
    lines.push("WSL2 user linger: enabled ✓");
  } else if (linger === null) {
    // AC 8 is "detect or fail loud": an *undetermined* linger precondition must
    // not silently pass — a keepalive timer that may never survive logout leaves
    // the node "declared but dead". Treat undeterminable as a failure with
    // remediation rather than a soft warning.
    ok = false;
    lines.push("WSL2 user linger: cannot determine (loginctl unavailable) — install systemd/loginctl, then run `loginctl enable-linger \"$USER\"` to persist the keepalive timer");
  } else {
    ok = false;
    lines.push("WSL2 user linger: disabled — run `loginctl enable-linger \"$USER\"` so the keepalive timer survives logout");
  }

  return { applicable, ok, lines };
}

function defaultLingerEnabled(): boolean | null {
  if (!safeSyncOutput(["which", "loginctl"]).ok) return null;
  const user = process.env.USER ?? "";
  const res = safeSyncOutput(["loginctl", "show-user", user, "--property=Linger"]);
  if (!res.ok) return null;
  return res.stdout.trim() === "Linger=yes";
}

// --- Cluster / worker onboarding doctor checks (AC 9) ---

export interface ClusterDoctorResult { ok: boolean; lines: string[]; }

/**
 * Onboarding-legibility checks for a node that resolves to a cluster machine
 * (AC 9): self-identification, resolved role, controller HTTP reachability (worker),
 * and keepalive-timer installed/active (worker, Linux). Active probes
 * (`probeController`, `timerActive`, `timerEnabled`) are injectable for tests.
 */
export function clusterDoctor(opts?: {
  probeController?: (m: ClusterMachine) => boolean;
  timerActive?: () => boolean;
  timerEnabled?: () => boolean;
}): ClusterDoctorResult {
  const lines: string[] = [];
  let ok = true;

  if (!clusterEnabled()) {
    return { ok: true, lines: ["Cluster: not configured (standalone)"] };
  }

  // (a) self-identify
  const current = clusterCurrentMachineName();
  if (!current) {
    ok = false;
    lines.push("Self-identify: FAILED — this host is not in cluster.machines (check hostnameTailscale() / add the machine entry)");
    // Without identity the remaining role/worker checks are meaningless.
    return { ok, lines };
  }
  lines.push(`Self-identify: ${current} ✓`);

  // (b) role
  const role = clusterRole();
  lines.push(`Role: ${role}`);

  if (role === "worker") {
    // (c) controller reachability
    const controller = resolveController();
    if (!controller) {
      ok = false;
      lines.push("Controller: none resolved — no machine with role 'leader' in cluster.machines");
    } else {
      const probe = opts?.probeController ?? defaultProbeController;
      const reachable = probe(controller);
      const port = controller.dashboard_port ?? (loadConfigSync().dashboard?.port ?? 7678);
      if (reachable) {
        lines.push(`Controller reachable: ${controller.host}:${port} ✓`);
      } else {
        ok = false;
        lines.push(`Controller unreachable: ${controller.host}:${port} — is 'ludics dashboard serve' up on the controller and Tailscale connected?`);
      }
    }

    // (d) keepalive timer (Linux only — launchd handles this on macOS)
    if (process.platform === "linux") {
      const enabled = opts?.timerEnabled ? opts.timerEnabled() : defaultTimerEnabled();
      const active = opts?.timerActive ? opts.timerActive() : defaultTimerActive();
      if (enabled && active) {
        lines.push("Keepalive timer: enabled + active ✓");
      } else {
        ok = false;
        lines.push(`Keepalive timer: ${enabled ? "enabled" : "NOT enabled"}, ${active ? "active" : "NOT active"} — run 'ludics triggers install'; on WSL2 see the systemd persistence check`);
      }
    }
  }

  return { ok, lines };
}

/**
 * curl args for the controller reachability probe. When a `cluster.secret` is
 * configured the controller enforces Bearer auth (`handleClusterRequest`), so the
 * probe MUST send the header too — otherwise a correctly-configured worker gets
 * 401 and falsely reports "Controller unreachable". Mirrors the authenticated
 * client path in cluster-http.ts (`if (secret) headers.Authorization = …`).
 */
export function controllerProbeCurlArgs(host: string, port: number, secret: string): string[] {
  const args = ["curl", "-fsS", "-m", "3", "-o", "/dev/null"];
  if (secret) args.push("-H", `Authorization: Bearer ${secret}`);
  args.push(`http://${host}:${port}/api/cluster/slots`);
  return args;
}

function defaultProbeController(controller: ClusterMachine): boolean {
  if (!safeSyncOutput(["which", "curl"]).ok) return false;
  const port = controller.dashboard_port ?? (loadConfigSync().dashboard?.port ?? 7678);
  return safeSyncOutput(controllerProbeCurlArgs(controller.host, port, clusterSecret())).ok;
}

function defaultTimerActive(): boolean {
  return safeSyncOutput(["systemctl", "--user", "is-active", "ludics-mag.timer"]).stdout.trim() === "active";
}

function defaultTimerEnabled(): boolean {
  return safeSyncOutput(["systemctl", "--user", "is-enabled", "ludics-mag.timer"]).stdout.trim() === "enabled";
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
    case "doctor": {
      // Onboarding-legibility checks (AC 9) plus WSL2 persistence preconditions
      // (AC 8). Exits non-zero when any check fails so onboarding flows
      // (setup.sh) can gate "onboarding complete" on a green result — i.e. detect
      // or fail loud, never declare a worker ready while its keepalive can't run.
      const cd = clusterDoctor();
      for (const line of cd.lines) console.log(line);
      const wsl = wslPersistenceStatus();
      if (wsl.applicable) for (const line of wsl.lines) console.log(line);
      const allOk = cd.ok && (!wsl.applicable || wsl.ok);
      if (!allOk) process.exitCode = 1;
      break;
    }
    default:
      throw new Error(`unknown cluster command: ${sub} (use: status, tick, heartbeat, ping, doctor)`);
  }
}
