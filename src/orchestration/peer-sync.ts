import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { OrchestrationState } from "./state.ts";
import { makeId } from "./util.ts";

export interface AgentStatusSnapshot {
  status: string;
  epoch: number;
  message: string;
}

function writeFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

export function initPeerSync(
  peerSyncDir: string,
  feature: string,
  mode: "duo" | "pair",
  projectDir: string,
  agents: OrchestrationState["agents"],
  worktrees: Record<string, string>,
): void {
  mkdirSync(peerSyncDir, { recursive: true });
  mkdirSync(join(peerSyncDir, "reviews"), { recursive: true });
  mkdirSync(join(peerSyncDir, "plans"), { recursive: true });
  mkdirSync(join(peerSyncDir, "merge-votes"), { recursive: true });
  writeFile(join(peerSyncDir, "feature"), feature);
  writeFile(join(peerSyncDir, "mode"), mode);
  writeFile(join(peerSyncDir, "phase"), "setup");
  writeFile(join(peerSyncDir, "phase-token"), makeId("phase"));
  writeFile(join(peerSyncDir, "round"), "1");
  writeFile(join(peerSyncDir, "session"), feature);
  writeFile(join(peerSyncDir, "state.json"), JSON.stringify({
    feature,
    mode,
    phase: "setup",
    round: 1,
    session: feature,
  }, null, 2));
  writeFile(join(peerSyncDir, "worktrees.json"), JSON.stringify(worktrees, null, 2));

  const coder = agents.find((agent) => agent.role === "coder");
  const reviewer = agents.find((agent) => agent.role === "reviewer");
  if (coder) writeFile(join(peerSyncDir, "coder-agent"), coder.provider);
  if (reviewer) writeFile(join(peerSyncDir, "reviewer-agent"), reviewer.provider);

  for (const agent of agents) {
    writeFile(join(peerSyncDir, `${agent.name}.status`), `idle|0|awaiting-${agent.name}\n`);
  }

  const sessionsDir = join(projectDir, ".agent-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionLink = join(sessionsDir, `${feature}.session`);
  try {
    if (existsSync(sessionLink)) unlinkSync(sessionLink);
  } catch {
    // ignore
  }
  symlinkSync(peerSyncDir, sessionLink);
}

export function removePeerSyncSession(projectDir: string, feature: string): void {
  const sessionLink = join(projectDir, ".agent-sessions", `${feature}.session`);
  try {
    if (existsSync(sessionLink)) unlinkSync(sessionLink);
  } catch {
    // ignore
  }
}

export function writePeerSync(state: OrchestrationState): void {
  const dir = state.peerSyncDir;
  mkdirSync(dir, { recursive: true });
  writeFile(join(dir, "phase"), state.phase);
  writeFile(join(dir, "phase-token"), makeId("phase"));
  writeFile(join(dir, "round"), String(state.round));
  writeFile(join(dir, "feature"), state.feature);
  writeFile(join(dir, "mode"), state.mode);
  writeFile(join(dir, "state.json"), JSON.stringify({
    feature: state.feature,
    mode: state.mode,
    phase: state.phase,
    round: state.round,
    session: state.feature,
  }, null, 2));
}

export function readAgentStatus(dir: string, agent: string): AgentStatusSnapshot {
  const path = join(dir, `${agent}.status`);
  if (!existsSync(path)) {
    return { status: "unknown", epoch: 0, message: "" };
  }
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return { status: "unknown", epoch: 0, message: "" };
  const [status, epochStr, ...messageParts] = content.split("|");
  return {
    status: status ?? "unknown",
    epoch: parseInt(epochStr ?? "0", 10) || 0,
    message: messageParts.join("|"),
  };
}

export function writeInterrupt(dir: string, agent: string): void {
  writeFile(join(dir, `${agent}.interrupt`), "");
}

export function clearInterrupt(dir: string, agent: string): void {
  const path = join(dir, `${agent}.interrupt`);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function readPrUrl(dir: string, agent: string): string | null {
  const path = join(dir, `${agent}.pr`);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return value || null;
}

export function readMarker(dir: string, name: string): string | null {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf-8").trim();
  return value || null;
}

export function cleanupPeerSyncDir(dir: string): void {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}
