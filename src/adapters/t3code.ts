import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import {
  getGitBranch,
  getMainRepoFromWorktree,
  isGitWorktree,
  latestMtime,
  resolveProjectDir,
} from "./base.ts";
import { MarkdownBuilder } from "./markdown.ts";
import type { Adapter, AdapterContext } from "./types.ts";
import { T3CodeClient } from "../t3code/client.ts";
import {
  ensureServer,
  readSlotState,
  removeSlotState,
  serverStatus,
  writeSlotState,
} from "../t3code/server.ts";
import type {
  T3CodeServerRecord,
  T3CodeThreadRecord,
  T3InteractionMode,
  T3RuntimeMode,
  T3Snapshot,
  T3Thread,
} from "../t3code/types.ts";

interface ParsedAdapterArgs {
  model: string;
  title?: string;
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
}

const DEFAULT_MODEL = "gpt-5.4";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeWorkspacePath(ctx: AdapterContext): string {
  const raw = ctx.path && ctx.path !== "null"
    ? ctx.path
    : resolveProjectDir(ctx.session);
  if (raw.startsWith("~/")) {
    return resolve(process.env.HOME ?? "~", raw.slice(2));
  }
  return resolve(raw);
}

function defaultTitle(ctx: AdapterContext, workspacePath: string): string {
  if (ctx.taskId && ctx.taskId !== "null") return ctx.taskId;
  if (ctx.process && ctx.process !== "(empty)") return ctx.process;
  return basename(workspacePath) || `slot-${ctx.slot}`;
}

function parseArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaping = false;

  const pushCurrent = () => {
    if (!current) return;
    args.push(current);
    current = "";
  };

  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\") escaping = true;
      else current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    current += ch;
  }

  if (escaping) current += "\\";
  if (inSingle || inDouble) throw new Error("unterminated quote in t3code adapter args");
  pushCurrent();
  return args;
}

function parseAdapterArgs(raw: string): ParsedAdapterArgs {
  const args = parseArgs(raw);
  const parsed: ParsedAdapterArgs = {
    model: DEFAULT_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case "--model":
        if (!next) throw new Error("t3code adapter args: --model requires a value");
        parsed.model = next;
        i++;
        break;
      case "--title":
        if (!next) throw new Error("t3code adapter args: --title requires a value");
        parsed.title = next;
        i++;
        break;
      case "--runtime-mode":
        if (next !== "approval-required" && next !== "full-access") {
          throw new Error("t3code adapter args: --runtime-mode must be approval-required or full-access");
        }
        parsed.runtimeMode = next;
        i++;
        break;
      case "--interaction-mode":
        if (next !== "default" && next !== "plan") {
          throw new Error("t3code adapter args: --interaction-mode must be default or plan");
        }
        parsed.interactionMode = next;
        i++;
        break;
      default:
        throw new Error(`t3code adapter args: unsupported flag ${arg}`);
    }
  }

  return parsed;
}

function findThread(snapshot: T3Snapshot, threadId: string): T3Thread | null {
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
}

function findProject(snapshot: T3Snapshot, workspaceRoot: string): { id: string; defaultModel?: string | null } | null {
  const exact = snapshot.projects.find((project) => project.workspaceRoot === workspaceRoot);
  if (exact) return exact;
  return null;
}

function threadUrl(record: T3CodeServerRecord, threadId: string): string {
  return `${record.webUrl}/${encodeURIComponent(threadId)}`;
}

async function withClient<T>(
  record: T3CodeServerRecord,
  fn: (client: T3CodeClient) => Promise<T>,
): Promise<T> {
  const client = new T3CodeClient({
    url: record.wsUrl,
    token: record.authToken,
  });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function start(ctx: AdapterContext): Promise<string> {
  const record = await ensureServer({ harnessDir: ctx.harnessDir });
  const workspaceRoot = normalizeWorkspacePath(ctx);
  const options = parseAdapterArgs(ctx.adapterArgs);
  const title = options.title ?? defaultTitle(ctx, workspaceRoot);
  const existingState = readSlotState(ctx.slot, ctx.harnessDir);

  return await withClient(record, async (client) => {
    const snapshot = await client.getSnapshot();

    const existingThread = existingState?.threads[0]
      ? findThread(snapshot, existingState.threads[0].threadId)
      : null;
    if (existingThread) {
      return threadUrl(record, existingThread.id);
    }

    const project = findProject(snapshot, workspaceRoot);
    const projectId = project?.id ?? makeId("project");
    const model = options.model || project?.defaultModel || DEFAULT_MODEL;
    const createdAt = isoNow();

    if (!project) {
      await client.dispatchCommand({
        type: "project.create",
        commandId: makeId("cmd"),
        projectId,
        title: basename(workspaceRoot) || title,
        workspaceRoot,
        defaultModel: model,
        createdAt,
      });
    }

    const threadId = makeId(`thread-slot-${ctx.slot}`);
    await client.dispatchCommand({
      type: "thread.create",
      commandId: makeId("cmd"),
      threadId,
      projectId,
      title,
      model,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      branch: null,
      worktreePath: workspaceRoot,
      createdAt,
    });

    const slotThread: T3CodeThreadRecord = {
      threadId,
      projectId,
      workspaceRoot,
      title,
      model,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      createdAt,
      updatedAt: createdAt,
    };
    writeSlotState({ slot: ctx.slot, threads: [slotThread] }, ctx.harnessDir);
    return threadUrl(record, threadId);
  });
}

async function readState(ctx: AdapterContext): Promise<string | null> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) return null;

  const status = await serverStatus({ harnessDir: ctx.harnessDir });
  const md = new MarkdownBuilder();
  md.keyValue("Mode", "t3code");

  if (!status.record) {
    md.section("Runtime");
    md.bullet("Server: not started");
    return md.toString();
  }

  md.section("Terminals");
  md.bullet(`Web: ${threadUrl(status.record, slotState.threads[0]!.threadId)}`);
  md.detail(`Server: ${status.record.webUrl} (pid ${status.record.pid})`);

  const threadRecord = slotState.threads[0]!;
  const workspaceRoot = threadRecord.workspaceRoot;
  md.section("Git");
  if (isGitWorktree(workspaceRoot)) {
    md.bullet(`Working directory: ${workspaceRoot} (worktree)`);
    const mainRepo = getMainRepoFromWorktree(workspaceRoot);
    if (mainRepo) md.bullet(`Main repository: ${mainRepo}`);
  } else {
    md.bullet(`Working directory: ${workspaceRoot}`);
  }
  const branch = getGitBranch(workspaceRoot);
  if (branch) md.bullet(`Branch: ${branch}`);

  md.section("Runtime");
  if (!status.running || !status.snapshot) {
    md.bullet(`Server status: unavailable${status.reason ? ` (${status.reason})` : ""}`);
    md.bullet(`Thread: ${threadRecord.title} (${threadRecord.threadId})`);
    return md.toString();
  }

  const thread = findThread(status.snapshot, threadRecord.threadId);
  if (!thread) {
    md.bullet("Thread: missing from snapshot");
    return md.toString();
  }

  const project = status.snapshot.projects.find((entry) => entry.id === thread.projectId) ?? null;
  md.bullet(`Project: ${project?.title ?? thread.projectId}`);
  md.bullet(`Thread: ${thread.title} (${thread.id})`);
  md.bullet(`Model: ${thread.model}`);
  md.bullet(`Runtime mode: ${thread.runtimeMode}`);
  md.bullet(`Interaction mode: ${thread.interactionMode ?? "default"}`);
  md.bullet(`Updated: ${thread.updatedAt}`);
  if (thread.latestTurn) {
    md.bullet(`Latest turn: ${thread.latestTurn.state}`);
    if (thread.latestTurn.completedAt) {
      md.detail(`Completed: ${thread.latestTurn.completedAt}`);
    }
  }
  if (thread.session) {
    md.bullet(`Session: ${thread.session.status}`);
    if (thread.session.providerName) md.detail(`Provider: ${thread.session.providerName}`);
    if (thread.session.lastError) md.detail(`Last error: ${thread.session.lastError}`);
  }

  return md.toString();
}

async function stop(ctx: AdapterContext): Promise<string> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) {
    return `t3code slot ${ctx.slot} already stopped`;
  }

  const status = await serverStatus({ harnessDir: ctx.harnessDir });
  if (status.running && status.record) {
    await withClient(status.record, async (client) => {
      for (const thread of slotState.threads) {
        try {
          await client.dispatchCommand({
            type: "thread.session.stop",
            commandId: makeId("cmd"),
            threadId: thread.threadId,
            createdAt: isoNow(),
          });
        } catch {
          // ignore already-stopped sessions
        }
        try {
          await client.dispatchCommand({
            type: "thread.delete",
            commandId: makeId("cmd"),
            threadId: thread.threadId,
          });
        } catch {
          // ignore missing threads
        }
      }
    });
  }

  removeSlotState(ctx.slot, ctx.harnessDir);
  return `t3code slot ${ctx.slot} stopped`;
}

async function lastActivity(ctx: AdapterContext): Promise<string | null> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) return null;

  const status = await serverStatus({ harnessDir: ctx.harnessDir });
  if (status.running && status.snapshot) {
    const thread = findThread(status.snapshot, slotState.threads[0]!.threadId);
    if (thread?.updatedAt) return thread.updatedAt;
  }

  const workspaceRoot = slotState.threads[0]!.workspaceRoot;
  const peerSyncPath = join(workspaceRoot, ".peer-sync");
  if (existsSync(peerSyncPath)) {
    return latestMtime([peerSyncPath]);
  }

  return slotState.threads[0]!.updatedAt ?? null;
}

const adapter = { readState, start, stop, lastActivity } satisfies Adapter;

export { readState, start, stop, lastActivity };
export default adapter;
