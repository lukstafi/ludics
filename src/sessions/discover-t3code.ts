// t3code thread discovery
// Queries the t3code server snapshot for active threads and maps them to DiscoveredSession records.
// Falls back gracefully (returns []) if the t3code server is not running.

import type { DiscoveredSession } from "../types.ts";
import { serverStatus } from "../t3code/server.ts";
import { threadModel, type T3Project, type T3Snapshot, type T3Thread } from "../t3code/types.ts";

function normalizeCwd(cwd: string): string {
  return cwd !== "/" ? cwd.replace(/\/+$/, "") : cwd;
}

function threadCwd(thread: T3Thread, projectMap: Map<string, T3Project>): string {
  if (thread.worktreePath) return thread.worktreePath;
  const project = projectMap.get(thread.projectId);
  return project?.workspaceRoot ?? "unknown";
}

function threadActivityEpoch(thread: T3Thread): number {
  // Prefer session.updatedAt, then latestTurn timestamps, then thread.updatedAt
  const candidates: string[] = [];
  if (thread.session?.updatedAt) candidates.push(thread.session.updatedAt);
  if (thread.latestTurn?.completedAt) candidates.push(thread.latestTurn.completedAt);
  if (thread.latestTurn?.startedAt) candidates.push(thread.latestTurn.startedAt);
  if (thread.latestTurn?.requestedAt) candidates.push(thread.latestTurn.requestedAt);
  candidates.push(thread.updatedAt);

  let latest = 0;
  for (const iso of candidates) {
    const epoch = Math.floor(new Date(iso).getTime() / 1000);
    if (epoch > latest) latest = epoch;
  }
  return latest || Math.floor(Date.now() / 1000);
}

function mapThreadToSession(
  thread: T3Thread,
  projectMap: Map<string, T3Project>,
): DiscoveredSession {
  const cwd = threadCwd(thread, projectMap);
  return {
    agentType: "t3code",
    cwd: normalizeCwd(cwd),
    cwdNormalized: normalizeCwd(cwd),
    sessionId: `t3code:${thread.id}`,
    source: "appServer",
    lastActivityEpoch: threadActivityEpoch(thread),
    meta: {
      threadId: thread.id,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath ?? null,
      branch: thread.branch ?? null,
      model: threadModel(thread),
      sessionStatus: thread.session?.status ?? null,
      turnState: thread.latestTurn?.state ?? null,
      providerName: thread.session?.providerName ?? null,
      runtimeMode: thread.runtimeMode,
      title: thread.title,
    },
  };
}

function snapshotToSessions(snapshot: T3Snapshot): DiscoveredSession[] {
  const projectMap = new Map<string, T3Project>();
  for (const project of snapshot.projects) {
    projectMap.set(project.id, project);
  }

  const sessions: DiscoveredSession[] = [];
  for (const thread of snapshot.threads) {
    // Skip deleted threads
    if (thread.deletedAt) continue;
    sessions.push(mapThreadToSession(thread, projectMap));
  }
  return sessions;
}

/**
 * Discover active sessions from the t3code server.
 * Returns an empty array with a console warning if the server is not running.
 */
export async function discoverT3code(): Promise<DiscoveredSession[]> {
  try {
    const status = await serverStatus();
    if (!status.running || !status.snapshot) {
      if (status.reason && status.reason !== "not started") {
        console.error(`ludics: t3code discovery: server not available (${status.reason})`);
      }
      return [];
    }
    return snapshotToSessions(status.snapshot);
  } catch (error) {
    console.error(
      `ludics: t3code discovery failed: ${error instanceof Error ? error.message : String(error)} (run \`ludics t3code doctor\` for diagnostics)`,
    );
    return [];
  }
}
