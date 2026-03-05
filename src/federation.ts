// Federation — seniority-based leader election for multi-machine Mag coordination

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { harnessDir } from "./config.ts";
import { networkNodes, networkCurrentNode } from "./network.ts";
import { journalAppend } from "./journal.ts";
import { emitEvent } from "./events.ts";
import { stateCommit, statePull, statePush } from "./state.ts";

const HEARTBEAT_TIMEOUT = parseInt(process.env.LUDICS_HEARTBEAT_TIMEOUT ?? "900", 10);

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
  const nodeName = networkCurrentNode();

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
    timestamp,
    epoch,
    mag_running: magRunning,
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

// --- Leader election ---

function computeLeader(): string | null {
  const nodes = networkNodes();
  if (nodes.length === 0) return null;

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

  console.error(`ludics: federation: new leader elected: ${newLeader} (term ${term})`);
  try {
    journalAppend("federation", `leader changed to ${newLeader} (term ${term})`);
  } catch {
    // journal may not be available
  }
  emitEvent({ event_type: "federation_leader_change", source: "federation", scope: "federation", message: `leader changed to ${newLeader} (term ${term})` });

  return true;
}

export function federationElect(): string | null {
  const leader = computeLeader();
  if (leader) {
    updateLeader(leader);
    return leader;
  }
  console.error("ludics: federation: no online nodes available for leader election");
  return null;
}

export function federationIsLeader(): boolean {
  const currentNode = networkCurrentNode();
  if (!currentNode) return false;
  const leader = currentLeader();
  return currentNode === leader;
}

export function federationShouldRunMag(): boolean {
  const nodes = networkNodes();
  if (nodes.length === 0) return true; // no federation = always allow
  return federationIsLeader();
}

// --- Federation tick ---

export function federationTick(): void {
  console.error("ludics: federation: running tick...");

  try { statePull(); } catch { /* ignore */ }
  heartbeatPublish();

  const leader = federationElect();
  if (leader) {
    console.error(`ludics: federation: current leader is ${leader}`);
  }

  try { stateCommit("federation heartbeat"); } catch { /* ignore */ }
  try { statePush(); } catch { /* ignore */ }

  console.error("ludics: federation: tick complete");
}

// --- Status display ---

export function federationStatus(): void {
  console.log("=== Federation Status ===");
  console.log("");

  const currentNode = networkCurrentNode() ?? "unknown";
  console.log(`Current node: ${currentNode}`);

  const leader = currentLeader() ?? "none";
  const term = currentTerm();
  console.log(`Current leader: ${leader} (term ${term})`);

  if (federationIsLeader()) {
    console.log("Leadership: THIS NODE IS LEADER");
  } else {
    console.log("Leadership: follower");
  }

  console.log("");
  console.log("Configured nodes (by seniority):");

  const nodes = networkNodes();
  if (nodes.length === 0) {
    console.log("  (no nodes configured in network.nodes)");
    console.log("");
    console.log("Federation is disabled - Mag will run on any machine.");
  } else {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      let status = "offline";
      let heartbeatAge = "";

      const heartbeatFile = join(heartbeatsDir(), `${node.name}.json`);
      if (existsSync(heartbeatFile)) {
        try {
          const data = JSON.parse(readFileSync(heartbeatFile, "utf-8")) as Record<string, unknown>;
          const hbEpoch = Number(data.epoch ?? 0);
          const age = Math.floor(Date.now() / 1000) - hbEpoch;
          const mins = Math.floor(age / 60);

          if (heartbeatIsFresh(node.name)) {
            status = "online";
            if (nodeHasMag(node.name)) status = "online (mag running)";
            heartbeatAge = ` [${mins}m ago]`;
          } else {
            status = `stale [${mins}m ago]`;
          }
        } catch {
          // ignore
        }
      }

      const leaderMarker = node.name === leader ? " *LEADER*" : "";
      console.log(`  ${i + 1}. ${node.name} - ${status}${heartbeatAge}${leaderMarker}`);
    }
  }

  console.log("");
  if (federationShouldRunMag()) {
    console.log("Mag permission: ALLOWED (this node should run Mag)");
  } else {
    console.log("Mag permission: BLOCKED (defer to leader)");
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
    default:
      throw new Error(`unknown federation command: ${sub} (use: status, tick, elect, heartbeat)`);
  }
}
