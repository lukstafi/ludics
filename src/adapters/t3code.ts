import { existsSync, openSync, readFileSync } from "fs";
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
import {
  toWireProvider,
  type T3CodeServerRecord,
  type T3CodeThreadRecord,
  type T3InteractionMode,
  type T3ProviderKind,
  type T3RuntimeMode,
  type T3Snapshot,
  type T3Thread,
} from "../t3code/types.ts";
import { runOrchestrationForSlot } from "../orchestration/runner.ts";
import {
  defaultOrchestrationConfig,
  initAgentRuntimeState,
  persistState,
  readOrchestrationState,
  removeOrchestrationState,
  stateFilePath,
  type AgentConfig,
  type OrchestrationConfig,
  type OrchestrationState,
} from "../orchestration/state.ts";
import { initPeerSync, removePeerSyncSession } from "../orchestration/peer-sync.ts";
import { createWorktrees, cleanupWorktrees, symlinkPeerSync } from "../orchestration/worktrees.ts";
import { isoNow, ludicsSelfCommand, makeId, nowEpoch, slugify } from "../orchestration/util.ts";

interface ParsedOrchestrationArgs {
  mode: "duo" | "pair";
  feature?: string;
  config: Partial<OrchestrationConfig>;
  agents: Array<{
    name: string;
    provider: T3ProviderKind;
    model: string;
    role?: "coder" | "reviewer";
  }>;
}

interface ParsedAdapterArgs {
  model: string;
  title?: string;
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
  orchestration: ParsedOrchestrationArgs | null;
}

export interface DesiredThreadConfig {
  worktreePath: string;
  title: string;
  model: string;
  provider?: T3ProviderKind;
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
  branch?: string | null;
}

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

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

function parseProviderToken(raw: string, defaultName: string, defaultModel: string): {
  name: string;
  provider: T3ProviderKind;
  model: string;
} {
  const parts = raw.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("t3code adapter args: empty provider token");
  }

  if (parts.length === 1) {
    const provider = parts[0];
    if (provider !== "codex" && provider !== "claude-code") {
      throw new Error(`t3code adapter args: unsupported provider ${provider}`);
    }
    const model = provider === "claude-code" ? DEFAULT_CLAUDE_MODEL : defaultModel;
    return { name: defaultName, provider, model };
  }

  if (parts.length === 2) {
    const [provider, model] = parts;
    if (provider !== "codex" && provider !== "claude-code") {
      throw new Error(`t3code adapter args: unsupported provider ${provider}`);
    }
    return { name: defaultName, provider, model };
  }

  const [name, provider, model] = parts;
  if (provider !== "codex" && provider !== "claude-code") {
    throw new Error(`t3code adapter args: unsupported provider ${provider}`);
  }
  return { name, provider, model: model ?? defaultModel };
}

export function parseT3CodeAdapterArgs(raw: string): ParsedAdapterArgs {
  const args = parseArgs(raw);
  const parsed: ParsedAdapterArgs = {
    model: DEFAULT_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    orchestration: null,
  };

  const orchestrationConfig: Partial<OrchestrationConfig> = {};
  let mode: ParsedOrchestrationArgs["mode"] | null = null;
  const duoAgents: ParsedOrchestrationArgs["agents"] = [];
  let coderToken: string | null = null;
  let reviewerToken: string | null = null;
  let feature: string | undefined;

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
      case "--duo":
        mode = "duo";
        break;
      case "--pair":
        mode = "pair";
        break;
      case "--agent":
        if (!next) throw new Error("t3code adapter args: --agent requires name:provider:model");
        duoAgents.push(parseProviderToken(next, `agent${duoAgents.length + 1}`, parsed.model));
        i++;
        break;
      case "--coder":
        if (!next) throw new Error("t3code adapter args: --coder requires provider[:model[:name]]");
        coderToken = next;
        i++;
        break;
      case "--reviewer":
        if (!next) throw new Error("t3code adapter args: --reviewer requires provider[:model[:name]]");
        reviewerToken = next;
        i++;
        break;
      case "--feature":
        if (!next) throw new Error("t3code adapter args: --feature requires a value");
        feature = next;
        i++;
        break;
      case "--clarify":
        orchestrationConfig.enableClarify = true;
        break;
      case "--pushback":
        orchestrationConfig.enablePushback = true;
        break;
      case "--plan":
        orchestrationConfig.enablePlan = true;
        break;
      case "--gather":
        orchestrationConfig.enableGather = true;
        break;
      case "--auto-finish":
        orchestrationConfig.autoFinish = true;
        break;
      case "--mag-tailoring":
        orchestrationConfig.useMagTailoring = true;
        break;
      case "--poll-interval":
        if (!next) throw new Error("t3code adapter args: --poll-interval requires seconds");
        orchestrationConfig.pollInterval = parseInt(next, 10);
        i++;
        break;
      case "--learning-interval":
        if (!next) throw new Error("t3code adapter args: --learning-interval requires seconds");
        orchestrationConfig.learningInterval = parseInt(next, 10);
        i++;
        break;
      case "--learning-gap":
        if (!next) throw new Error("t3code adapter args: --learning-gap requires rounds");
        orchestrationConfig.learningProductiveRoundsGap = parseInt(next, 10);
        i++;
        break;
      default:
        throw new Error(`t3code adapter args: unsupported flag ${arg}`);
    }
  }

  if (!mode) return parsed;

  if (mode === "duo") {
    const agents = duoAgents.length > 0
      ? duoAgents
      : [
        parseProviderToken("agent1:codex:gpt-5.4", "agent1", parsed.model),
        parseProviderToken("agent2:codex:gpt-5.4", "agent2", parsed.model),
      ];
    parsed.orchestration = {
      mode,
      feature,
      config: orchestrationConfig,
      agents,
    };
    return parsed;
  }

  const coder = parseProviderToken(coderToken ?? "coder:codex:gpt-5.4", "coder", parsed.model);
  const reviewer = parseProviderToken(reviewerToken ?? "reviewer:codex:gpt-5.4", "reviewer", parsed.model);
  parsed.orchestration = {
    mode,
    feature,
    config: orchestrationConfig,
    agents: [
      { ...coder, role: "coder" },
      { ...reviewer, role: "reviewer" },
    ],
  };
  return parsed;
}

function findThread(snapshot: T3Snapshot, threadId: string): T3Thread | null {
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
}

function findProject(snapshot: T3Snapshot, workspaceRoot: string): { id: string; defaultModel?: string | null } | null {
  return snapshot.projects.find((project) => project.workspaceRoot === workspaceRoot) ?? null;
}

export function canReuseSlotThread(
  existing: T3CodeThreadRecord | null | undefined,
  desired: DesiredThreadConfig,
): boolean {
  if (!existing) return false;
  return existing.worktreePath === desired.worktreePath
    && existing.title === desired.title
    && existing.model === desired.model
    && existing.runtimeMode === desired.runtimeMode
    && existing.interactionMode === desired.interactionMode
    && (existing.branch ?? null) === (desired.branch ?? null);
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

/** Find or create a t3code project for the given workspace root. Returns the projectId. */
async function ensureProject(
  client: T3CodeClient,
  snapshot: T3Snapshot,
  workspaceRoot: string,
  defaultModel: string,
): Promise<string> {
  const project = findProject(snapshot, workspaceRoot);
  if (project) return project.id;

  const projectId = makeId("project");
  await client.dispatchCommand({
    type: "project.create",
    commandId: makeId("cmd"),
    projectId,
    title: basename(workspaceRoot) || "project",
    workspaceRoot,
    defaultModel,
    createdAt: isoNow(),
  });
  return projectId;
}

async function ensureThread(
  client: T3CodeClient,
  snapshot: T3Snapshot,
  slot: number,
  projectId: string,
  desired: DesiredThreadConfig,
  existingRecord: T3CodeThreadRecord | null | undefined,
): Promise<T3CodeThreadRecord> {
  const model = desired.model || DEFAULT_MODEL;
  const createdAt = isoNow();

  const existingThread = existingRecord ? findThread(snapshot, existingRecord.threadId) : null;
  if (existingThread && canReuseSlotThread(existingRecord, { ...desired, model })) {
    const reusedRecord = existingRecord!;
    return {
      threadId: reusedRecord.threadId,
      projectId: reusedRecord.projectId,
      worktreePath: reusedRecord.worktreePath,
      title: reusedRecord.title,
      model,
      runtimeMode: reusedRecord.runtimeMode,
      interactionMode: reusedRecord.interactionMode,
      branch: reusedRecord.branch ?? null,
      createdAt: reusedRecord.createdAt,
      updatedAt: existingThread.updatedAt,
    };
  }

  if (existingThread) {
    try {
      await client.dispatchCommand({
        type: "thread.session.stop",
        commandId: makeId("cmd"),
        threadId: existingThread.id,
        createdAt,
      });
    } catch {
      // ignore
    }
    try {
      await client.dispatchCommand({
        type: "thread.delete",
        commandId: makeId("cmd"),
        threadId: existingThread.id,
      });
    } catch {
      // ignore
    }
  }

  const threadId = makeId(`thread-slot-${slot}`);
  const provider = desired.provider ? toWireProvider(desired.provider) : undefined;
  await client.dispatchCommand({
    type: "thread.create",
    commandId: makeId("cmd"),
    threadId,
    projectId,
    title: desired.title,
    model,
    ...(provider ? { provider } : {}),
    runtimeMode: desired.runtimeMode,
    interactionMode: desired.interactionMode,
    branch: desired.branch ?? null,
    worktreePath: desired.worktreePath,
    createdAt,
  });

  return {
    threadId,
    projectId,
    worktreePath: desired.worktreePath,
    title: desired.title,
    model,
    runtimeMode: desired.runtimeMode,
    interactionMode: desired.interactionMode,
    branch: desired.branch ?? null,
    createdAt,
    updatedAt: createdAt,
  };
}

async function cleanupStaleThreads(
  client: T3CodeClient,
  snapshot: T3Snapshot,
  existingThreads: T3CodeThreadRecord[],
  keepThreadIds: Set<string>,
): Promise<void> {
  for (const record of existingThreads) {
    if (keepThreadIds.has(record.threadId)) continue;
    const thread = findThread(snapshot, record.threadId);
    if (!thread) continue;
    try {
      await client.dispatchCommand({
        type: "thread.session.stop",
        commandId: makeId("cmd"),
        threadId: thread.id,
        createdAt: isoNow(),
      });
    } catch {
      // ignore
    }
    try {
      await client.dispatchCommand({
        type: "thread.delete",
        commandId: makeId("cmd"),
        threadId: thread.id,
      });
    } catch {
      // ignore
    }
  }
}

function makeOrchestrationFeature(ctx: AdapterContext, requested?: string): string {
  if (requested?.trim()) return slugify(requested);
  if (ctx.taskId?.trim()) return slugify(ctx.taskId);
  if (ctx.process?.trim()) return slugify(ctx.process);
  return `slot-${ctx.slot}`;
}

function orchestrationProjectDir(workspaceRoot: string): string {
  return getMainRepoFromWorktree(workspaceRoot) ?? workspaceRoot;
}

async function startOrchestrationProcess(slot: number, harnessDir: string, feature: string): Promise<number> {
  const logPath = join(harnessDir, "orchestration", `slot-${slot}-${feature}.log`);
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(ludicsSelfCommand(["orch", "run-internal", String(slot)]), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: logFd,
    env: {
      ...(process.env as Record<string, string>),
      LUDICS_HARNESS_DIR: harnessDir,
    },
  });
  if (typeof (proc as { unref?: () => void }).unref === "function") {
    (proc as { unref: () => void }).unref();
  }

  await Bun.sleep(500);
  if (proc.exitCode !== null) {
    const log = readFileSync(logPath, "utf-8").slice(-2000);
    throw new Error(`Orchestration runner exited immediately (code ${proc.exitCode}):\n${log}`);
  }

  return proc.pid;
}

function killPid(pid?: number): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore missing process
  }
}

async function startSingleThread(
  ctx: AdapterContext,
  record: T3CodeServerRecord,
  options: ParsedAdapterArgs,
  workspaceRoot: string,
): Promise<string> {
  const title = options.title ?? defaultTitle(ctx, workspaceRoot);
  const desired: DesiredThreadConfig = {
    worktreePath: workspaceRoot,
    title,
    model: options.model,
    runtimeMode: options.runtimeMode,
    interactionMode: options.interactionMode,
    branch: null,
  };
  const existingState = readSlotState(ctx.slot, ctx.harnessDir);

  return await withClient(record, async (client) => {
    const snapshot = await client.getSnapshot();
    const projectId = await ensureProject(client, snapshot, workspaceRoot, options.model);
    const threadRecord = await ensureThread(
      client,
      snapshot,
      ctx.slot,
      projectId,
      desired,
      existingState?.threads[0] ?? null,
    );
    await cleanupStaleThreads(
      client,
      snapshot,
      existingState?.threads ?? [],
      new Set([threadRecord.threadId]),
    );
    writeSlotState({ slot: ctx.slot, threads: [threadRecord] }, ctx.harnessDir);
    return threadUrl(record, threadRecord.threadId);
  });
}

async function startOrchestratedThreads(
  ctx: AdapterContext,
  record: T3CodeServerRecord,
  options: ParsedAdapterArgs,
  workspaceRoot: string,
): Promise<string> {
  const orchestration = options.orchestration!;
  const feature = makeOrchestrationFeature(ctx, orchestration.feature);
  const title = options.title ?? defaultTitle(ctx, workspaceRoot);
  const projectDir = orchestrationProjectDir(workspaceRoot);
  const existing = readSlotState(ctx.slot, ctx.harnessDir);

  if (existing?.orchestration?.pid) killPid(existing.orchestration.pid);

  const setup = createWorktrees(projectDir, feature, orchestration.agents, undefined, ctx.slot, orchestration.mode);
  symlinkPeerSync(setup.peerSyncDir, setup.agentWorktrees);

  const agents: AgentConfig[] = orchestration.agents.map((agent) => ({
    name: agent.name,
    provider: agent.provider,
    role: agent.role,
    model: agent.model,
    branch: setup.branches[agent.name]!,
    worktreePath: setup.agentWorktrees[agent.name]!,
  }));

  initPeerSync(
    setup.peerSyncDir,
    feature,
    orchestration.mode,
    projectDir,
    agents,
    { root: setup.rootWorktree, ...setup.agentWorktrees },
  );

  const existingThreadMap = new Map(
    (existing?.threads ?? []).map((thread) => [thread.worktreePath, thread]),
  );

  const slotThreads = await withClient(record, async (client) => {
    const snapshot = await client.getSnapshot();
    const projectId = await ensureProject(client, snapshot, projectDir, orchestration.agents[0]?.model ?? options.model);
    const created: T3CodeThreadRecord[] = [];
    for (const agent of agents) {
      const desired: DesiredThreadConfig = {
        worktreePath: agent.worktreePath,
        title: `${title}:${agent.name}`,
        model: agent.model,
        provider: agent.provider,
        runtimeMode: options.runtimeMode,
        interactionMode: options.interactionMode,
        branch: agent.branch,
      };
      created.push(
        await ensureThread(
          client,
          snapshot,
          ctx.slot,
          projectId,
          desired,
          existingThreadMap.get(agent.worktreePath),
        ),
      );
    }
    await cleanupStaleThreads(
      client,
      snapshot,
      existing?.threads ?? [],
      new Set(created.map((thread) => thread.threadId)),
    );
    return created;
  });

  const state: OrchestrationState = {
    slot: ctx.slot,
    feature,
    mode: orchestration.mode,
    phase: "setup",
    round: 1,
    mergeRound: 0,
    agents,
    agentStates: initAgentRuntimeState(agents.map((agent) => agent.name)),
    config: defaultOrchestrationConfig(orchestration.config),
    phaseStartedAt: nowEpoch(),
    startedAt: isoNow(),
    projectDir,
    rootWorktree: setup.rootWorktree,
    peerSyncDir: setup.peerSyncDir,
    threadIds: Object.fromEntries(slotThreads.map((thread, index) => [agents[index]!.name, thread.threadId])),
    taskId: ctx.taskId || undefined,
    slotTitle: title,
  };
  persistState(state, ctx.harnessDir);

  const pid = await startOrchestrationProcess(ctx.slot, ctx.harnessDir, feature);
  writeSlotState({
    slot: ctx.slot,
    threads: slotThreads,
    orchestration: {
      stateFile: stateFilePath(ctx.slot, ctx.harnessDir),
      mode: orchestration.mode,
      pid,
    },
  }, ctx.harnessDir);

  return threadUrl(record, slotThreads[0]!.threadId);
}

async function start(ctx: AdapterContext): Promise<string> {
  const record = await ensureServer({ harnessDir: ctx.harnessDir });
  const workspaceRoot = normalizeWorkspacePath(ctx);
  const options = parseT3CodeAdapterArgs(ctx.adapterArgs);

  if (!options.orchestration) {
    return await startSingleThread(ctx, record, options, workspaceRoot);
  }

  return await startOrchestratedThreads(ctx, record, options, workspaceRoot);
}

function addThreadDetails(
  md: MarkdownBuilder,
  threadRecord: T3CodeThreadRecord,
  snapshot: T3Snapshot | null,
): void {
  const thread = snapshot ? findThread(snapshot, threadRecord.threadId) : null;
  md.bullet(`Thread: ${threadRecord.title} (${threadRecord.threadId})`);
  md.detail(`Workspace: ${threadRecord.worktreePath}`);
  if (threadRecord.branch) md.detail(`Branch: ${threadRecord.branch}`);
  md.detail(`Model: ${threadRecord.model}`);
  if (thread) {
    md.detail(`Turn: ${thread.latestTurn?.state ?? "none"}`);
    md.detail(`Updated: ${thread.updatedAt}`);
  }
}

async function readState(ctx: AdapterContext): Promise<string | null> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) return null;

  const status = await serverStatus({ harnessDir: ctx.harnessDir });
  const md = new MarkdownBuilder();
  const orchestration = slotState.orchestration
    ? readOrchestrationState(ctx.slot, ctx.harnessDir)
    : null;
  md.keyValue("Mode", orchestration ? `t3code ${orchestration.mode}` : "t3code");
  md.keyValue("Session", slotState.threads[0]!.threadId);

  if (!status.record) {
    md.section("Runtime");
    md.bullet("Server: not started");
    return md.toString();
  }

  md.section("Terminals");
  for (const thread of slotState.threads) {
    md.bullet(`Web: ${threadUrl(status.record, thread.threadId)}`);
    md.detail(thread.title);
  }
  md.detail(`Server: ${status.record.webUrl} (pid ${status.record.pid})`);

  if (orchestration) {
    md.section("Orchestration");
    md.bullet(`Feature: ${orchestration.feature}`);
    md.bullet(`Phase: ${orchestration.phase}`);
    md.bullet(`Round: ${orchestration.round}`);
    md.bullet(`Peer sync: ${orchestration.peerSyncDir}`);
    if (slotState.orchestration?.pid) {
      let alive = false;
      try {
        process.kill(slotState.orchestration.pid, 0);
        alive = true;
      } catch {
        // process not found
      }
      md.detail(`Runner pid: ${slotState.orchestration.pid} (${alive ? "running" : "crashed"})`);
    }
    for (const agent of orchestration.agents) {
      const runtime = orchestration.agentStates[agent.name];
      md.bullet(`${agent.name}: ${runtime?.status ?? "unknown"}`);
      if (runtime?.prUrl) md.detail(`PR: ${runtime.prUrl}`);
      md.detail(`Worktree: ${agent.worktreePath}`);
      if (agent.branch) md.detail(`Branch: ${agent.branch}`);
    }
  }

  md.section("Git");
  const primaryWorkspace = slotState.threads[0]!.worktreePath;
  if (isGitWorktree(primaryWorkspace)) {
    md.bullet(`Working directory: ${primaryWorkspace} (worktree)`);
    const mainRepo = getMainRepoFromWorktree(primaryWorkspace);
    if (mainRepo) md.bullet(`Main repository: ${mainRepo}`);
  } else {
    md.bullet(`Working directory: ${primaryWorkspace}`);
  }
  const branch = getGitBranch(primaryWorkspace);
  if (branch) md.bullet(`Branch: ${branch}`);

  md.section("Runtime");
  if (!status.running || !status.snapshot) {
    md.bullet(`Server status: unavailable${status.reason ? ` (${status.reason})` : ""}`);
    for (const thread of slotState.threads) addThreadDetails(md, thread, null);
    return md.toString();
  }

  for (const thread of slotState.threads) addThreadDetails(md, thread, status.snapshot);
  return md.toString();
}

async function stop(ctx: AdapterContext): Promise<string> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) {
    return `t3code slot ${ctx.slot} already stopped`;
  }

  if (slotState.orchestration?.pid) killPid(slotState.orchestration.pid);

  const orchestrationState = slotState.orchestration
    ? readOrchestrationState(ctx.slot, ctx.harnessDir)
    : null;

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
          // ignore
        }
        try {
          await client.dispatchCommand({
            type: "thread.delete",
            commandId: makeId("cmd"),
            threadId: thread.threadId,
          });
        } catch {
          // ignore
        }
      }
    });
  }

  if (orchestrationState) {
    removePeerSyncSession(orchestrationState.projectDir, orchestrationState.feature);
    cleanupWorktrees(orchestrationState.projectDir, orchestrationState.feature, orchestrationState.agents, ctx.slot, orchestrationState.mode);
    removeOrchestrationState(ctx.slot, ctx.harnessDir);
  }

  removeSlotState(ctx.slot, ctx.harnessDir);
  return `t3code slot ${ctx.slot} stopped`;
}

async function lastActivity(ctx: AdapterContext): Promise<string | null> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) return null;

  let latest: string | null = null;
  const status = await serverStatus({ harnessDir: ctx.harnessDir });
  if (status.running && status.snapshot) {
    for (const threadRecord of slotState.threads) {
      const thread = findThread(status.snapshot, threadRecord.threadId);
      if (thread?.updatedAt && (!latest || thread.updatedAt > latest)) latest = thread.updatedAt;
    }
  }

  const orchestrationState = slotState.orchestration
    ? readOrchestrationState(ctx.slot, ctx.harnessDir)
    : null;
  if (orchestrationState && existsSync(orchestrationState.peerSyncDir)) {
    const peerSyncTime = latestMtime([orchestrationState.peerSyncDir]);
    if (peerSyncTime && (!latest || peerSyncTime > latest)) latest = peerSyncTime;
  }

  for (const thread of slotState.threads) {
    if (!latest || thread.updatedAt > latest) latest = thread.updatedAt;
  }
  return latest;
}

const adapter = { readState, start, stop, lastActivity } satisfies Adapter;

export { readState, start, stop, lastActivity, runOrchestrationForSlot };
export default adapter;
