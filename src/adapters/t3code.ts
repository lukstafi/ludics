import { existsSync, readFileSync } from "fs";
import { parseTaskFrontmatter } from "../tasks/markdown.ts";
import { basename, join, resolve } from "path";
import {
  getGitBranch,
  getMainRepoFromWorktree,
  isGitWorktree,
  latestMtime,
  resolveProjectDir,
  slotSessionName,
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
import { globalAdapter, loadConfigSync, t3codeIntegrationEnabled, type LudicsFullConfig } from "../config.ts";
import {
  toWireProvider,
  type T3CodeServerRecord,
  type T3CodeThreadRecord,
  type T3InteractionMode,
  type T3ModelSelection,
  type T3ProviderKind,
  type T3RuntimeMode,
  type T3Snapshot,
  type T3Thread,
} from "../t3code/types.ts";
import { runOrchestrationForSlot } from "../orchestration/runner.ts";
import {
  defaultOrchestrationConfig,
  DEFAULT_SUBSTANTIVE_STALL_CONFIG,
  parseSubstantiveStallOverrides,
  initAgentRuntimeState,
  persistState,
  readOrchestrationState,
  removeOrchestrationState,
  stateFilePath,
  type AgentConfig,
  type OrchestrationConfig,
  type OrchestrationState,
} from "../orchestration/state.ts";
import { initPeerSync, writeAgentMarkerFiles } from "../orchestration/peer-sync.ts";
import { createWorktrees, symlinkPeerSync } from "../orchestration/worktrees.ts";
import { recordDeferredCleanup, buildCleanupEntry } from "../orchestration/deferred-cleanup.ts";
import { isoNow, makeId, nowEpoch } from "../orchestration/util.ts";
import {
  classForProvider,
  dispatchWithFableContext,
  normalizeHighEndClass,
  resolveModelClass,
  type ModelClass,
} from "../orchestration/model-defaults.ts";

interface ParsedAgentToken {
  name: string;
  provider: T3ProviderKind;
  model: string;
  /** True when the model was explicitly set in the token (not just a provider default). */
  modelExplicit: boolean;
  role?: "coder" | "reviewer";
}

interface ParsedOrchestrationArgs {
  mode: "duo" | "pair" | "solo" | "pilot";
  config: Partial<OrchestrationConfig>;
  agents: ParsedAgentToken[];
  /** Explicit coder model override from --coder-model flag. */
  coderModelOverride?: string;
  /** Explicit reviewer model override from --reviewer-model flag. */
  reviewerModelOverride?: string;
  /** Thinking effort for the coder agent. */
  coderThinkingEffort?: string;
  /** Thinking effort for the reviewer agent. */
  reviewerThinkingEffort?: string;
  /** For hierarchical-duo: the peer slot number. Set via --duo-peer-slot=N. */
  duoPeerSlot?: number;
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
  /** Orchestration role, threaded through so a Fable-model launch failure can
   *  name the exact config key (`coder_class`/`reviewer_class`) in its hard error
   *  (task-13dee93b AC9). Transient dispatch field — not persisted state. */
  role?: "coder" | "reviewer";
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
  branch?: string | null;
}

/**
 * Resolve a model class from a parsed `mag.orchestration` config block. The
 * literal `orchCfg?.model_classes` read lives here (in an adapter file) so the
 * config-reference lint's adapter-read scan (Direction 4) sees `model_classes`
 * as covered; the throw-on-unset logic is centralized in `resolveModelClass`.
 */
export function classModel(cls: ModelClass, orchCfg: Record<string, unknown> | undefined): string {
  return resolveModelClass(orchCfg?.model_classes as Record<string, unknown> | undefined, cls);
}

/** Latest-within-class default model for a provider when no explicit model was
 *  given (codex → codex class; claude-code → claude-sonnet). Throws when the
 *  resolved class has no entry in the config table. */
export function providerDefaultModel(provider: string, orchCfg: Record<string, unknown> | undefined): string {
  return classModel(classForProvider(provider), orchCfg);
}

/**
 * Codex-class default for the NON-orchestration single-thread t3code path.
 * Unlike `classModel()`, this never throws: a plain `slot start` against a
 * minimal/legacy config that lacks the orchestration-only `model_classes`
 * table must still open (it previously used a built-in codex default), so an
 * absent table degrades to "" — letting the provider/codex CLI pick its own
 * default rather than failing the start. The loud missing-table throw is
 * reserved for orchestration default resolution (`resolveAgentModel` /
 * `selectOrchestrationFlags`), where the table is the documented source of
 * truth. Exported as a test seam.
 */
export function singleThreadCodexModel(orchCfg: Record<string, unknown> | undefined): string {
  const table = orchCfg?.model_classes as Record<string, unknown> | undefined;
  const v = table?.codex;
  return typeof v === "string" && v.trim() ? v.trim() : "";
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

/** Build orchestrated thread title — delegates to shared slotSessionName convention */
/**
 * Build the {@link DesiredThreadConfig} dispatched to the t3code server for a
 * single orchestration agent. Extracted as a named export so a regression
 * test can pin the cold-start invariant — the `worktreePath` field on the
 * payload MUST equal the agent's per-agent worktree path returned by
 * `createWorktrees` — without standing up a t3code-server fixture.
 *
 * Pinned by `proposal-commit-on-main-and-worktree-resume` scope (3a):
 * the t3code-side handling of `worktreePath` (project resolution, thread
 * creation, CWD enforcement) is out of scope; the boundary asserted here
 * is the value the runner constructs and dispatches.
 */
export function buildOrchestratedDesiredThreadConfig(
  agent: { name: string; role?: string | null; model: string; provider?: T3ProviderKind; branch: string; worktreePath: string },
  slot: number,
  taskId: string | undefined,
  options: { runtimeMode: T3RuntimeMode; interactionMode: T3InteractionMode },
): DesiredThreadConfig {
  return {
    worktreePath: agent.worktreePath,
    title: orchestratedThreadTitle(slot, agent.role ?? agent.name, taskId),
    model: agent.model,
    provider: agent.provider,
    role: agent.role === "coder" || agent.role === "reviewer" ? agent.role : undefined,
    runtimeMode: options.runtimeMode,
    interactionMode: options.interactionMode,
    branch: agent.branch,
  };
}

export function orchestratedThreadTitle(slot: number, role: string, taskId?: string): string {
  return slotSessionName(slot, role, taskId);
}

function defaultTitle(ctx: AdapterContext, workspacePath: string): string {
  const fallback = (ctx.process && ctx.process !== "(empty)") ? ctx.process : (basename(workspacePath) || "thread");
  return slotSessionName(ctx.slot, undefined, ctx.taskId, fallback);
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
  if (inSingle || inDouble) throw new Error("unterminated quote in orchestration adapter args");
  pushCurrent();
  return args;
}

function parseProviderToken(raw: string, defaultName: string, defaultModel: string): {
  name: string;
  provider: T3ProviderKind;
  model: string;
  modelExplicit: boolean;
} {
  const parts = raw.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("orchestration adapter args: empty provider token");
  }

  if (parts.length === 1) {
    const provider = parts[0];
    if (provider !== "codex" && provider !== "claude-code") {
      throw new Error(`orchestration adapter args: unsupported provider ${provider}`);
    }
    // No concrete default baked here — bare provider tokens carry an empty
    // model and resolve through the latest-within-class table later, in
    // resolveAgentModel (task-c48b7beb). `defaultModel` (now "" by default) is
    // honoured if a caller passes an explicit one.
    return { name: defaultName, provider, model: defaultModel, modelExplicit: false };
  }

  if (parts.length === 2) {
    const [provider, model] = parts;
    if (provider !== "codex" && provider !== "claude-code") {
      throw new Error(`orchestration adapter args: unsupported provider ${provider}`);
    }
    return { name: defaultName, provider, model, modelExplicit: true };
  }

  const [name, provider, model] = parts;
  if (provider !== "codex" && provider !== "claude-code") {
    throw new Error(`orchestration adapter args: unsupported provider ${provider}`);
  }
  return { name, provider, model: model ?? defaultModel, modelExplicit: !!model };
}

export function parseOrchestrationAdapterArgs(raw: string): ParsedAdapterArgs {
  const args = parseArgs(raw);
  const parsed: ParsedAdapterArgs = {
    model: "",
    runtimeMode: "full-access",
    interactionMode: "default",
    orchestration: null,
  };

  const orchestrationConfig: Partial<OrchestrationConfig> = {};
  let mode: ParsedOrchestrationArgs["mode"] | null = null;
  let coderToken: string | null = null;
  let reviewerToken: string | null = null;
  let coderModelOverride: string | undefined;
  let reviewerModelOverride: string | undefined;
  let coderThinkingEffort: string | undefined;
  let reviewerThinkingEffort: string | undefined;
  let duoPeerSlot: number | undefined;
  // Anti-pattern being prevented: "recorded but discarded" — accepting
  // --reviewer-* flags into a target variable that a later mode branch
  // (here, --solo) silently overwrites or ignores, so the flag parses
  // successfully but has no effect. The fix is to key rejection on the
  // flag NAME recorded during parsing, not on whether the target variable
  // is set afterwards: shared flags like --effort assign the same target
  // as role-specific flags like --reviewer-effort, so post-parse variable
  // state cannot distinguish the two cases.
  //
  // See docs/orchestration-patterns.md#flag-name-keyed-rejection for the
  // full pattern entry and the reusable recipe for future adapter parsers
  // that gain role-specific flags.
  //
  // reviewerOnlyFlag records the first --reviewer-* flag seen (excluding
  // the shared --effort / --thinking-effort flags). Checked at the --solo
  // mode gate below to throw with a specific error naming the offending flag.
  let reviewerOnlyFlag: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case "--model":
        if (!next) throw new Error("orchestration adapter args: --model requires a value");
        parsed.model = next;
        i++;
        break;
      case "--title":
        if (!next) throw new Error("orchestration adapter args: --title requires a value");
        parsed.title = next;
        i++;
        break;
      case "--runtime-mode":
        if (next !== "approval-required" && next !== "full-access") {
          throw new Error("orchestration adapter args: --runtime-mode must be approval-required or full-access");
        }
        parsed.runtimeMode = next;
        i++;
        break;
      case "--interaction-mode":
        if (next !== "default" && next !== "plan") {
          throw new Error("orchestration adapter args: --interaction-mode must be default or plan");
        }
        parsed.interactionMode = next;
        i++;
        break;
      case "--duo":
        // Hierarchical duo: --duo is now treated as --pair at the adapter level.
        // The two-slot expansion happens in maybeFillEmptySlots / slot CLI, not here.
        console.error("ludics: --duo is now hierarchical duo (two pair slots) — treating as --pair");
        mode = "pair";
        break;
      case "--pair":
        mode = "pair";
        break;
      case "--solo":
        mode = "solo";
        break;
      case "--pilot":
        // User-piloted solo: identical single-coder/no-reviewer shape as --solo;
        // differs only in the work-phase prompt and idle-wait behavior.
        mode = "pilot";
        break;
      case "--agent":
        // Legacy duo --agent flag is no longer supported; use --coder/--reviewer instead.
        throw new Error("orchestration adapter args: --agent is no longer supported (duo mode now uses --coder/--reviewer). Use --coder and --reviewer instead.");
      case "--coder":
        if (!next) throw new Error("orchestration adapter args: --coder requires provider[:model[:name]]");
        coderToken = next;
        i++;
        break;
      case "--reviewer":
        if (!next) throw new Error("orchestration adapter args: --reviewer requires provider[:model[:name]]");
        reviewerToken = next;
        i++;
        break;
      case "--coder-model":
        if (!next) throw new Error("orchestration adapter args: --coder-model requires a model ID");
        coderModelOverride = next;
        i++;
        break;
      case "--reviewer-model":
        if (!next) throw new Error("orchestration adapter args: --reviewer-model requires a model ID");
        reviewerModelOverride = next;
        if (!reviewerOnlyFlag) reviewerOnlyFlag = arg;
        i++;
        break;
      case "--coder-effort":
      case "--coder-thinking-effort":
        if (!next) throw new Error(`orchestration adapter args: ${arg} requires low|medium|high|max`);
        coderThinkingEffort = next;
        i++;
        break;
      case "--reviewer-effort":
      case "--reviewer-thinking-effort":
        if (!next) throw new Error(`orchestration adapter args: ${arg} requires low|medium|high|max`);
        reviewerThinkingEffort = next;
        if (!reviewerOnlyFlag) reviewerOnlyFlag = arg;
        i++;
        break;
      case "--effort":
      case "--thinking-effort":
        if (!next) throw new Error(`orchestration adapter args: ${arg} requires low|medium|high|max`);
        coderThinkingEffort = next;
        reviewerThinkingEffort = next;
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
      case "--auto-recover-wrong-filename":
        orchestrationConfig.autoRecoverWrongFilename = true;
        break;
      case "--no-auto-recover-wrong-filename":
        orchestrationConfig.autoRecoverWrongFilename = false;
        break;
      case "--mag-tailoring":
        orchestrationConfig.useMagTailoring = true;
        break;
      case "--poll-interval":
        if (!next) throw new Error("orchestration adapter args: --poll-interval requires seconds");
        orchestrationConfig.pollInterval = parseInt(next, 10);
        i++;
        break;
      case "--learning-interval":
        if (!next) throw new Error("orchestration adapter args: --learning-interval requires seconds");
        orchestrationConfig.learningInterval = parseInt(next, 10);
        i++;
        break;
      case "--learning-gap":
        if (!next) throw new Error("orchestration adapter args: --learning-gap requires rounds");
        orchestrationConfig.learningProductiveRoundsGap = parseInt(next, 10);
        i++;
        break;
      case "--work-timeout": {
        if (!next) throw new Error("orchestration adapter args: --work-timeout requires seconds");
        const workSecs = parseInt(next, 10);
        if (isNaN(workSecs)) throw new Error(`orchestration adapter args: --work-timeout requires a valid number, got "${next}"`);
        orchestrationConfig.timeouts = { ...orchestrationConfig.timeouts, work: workSecs };
        i++;
        break;
      }
      case "--review-timeout": {
        if (!next) throw new Error("orchestration adapter args: --review-timeout requires seconds");
        const reviewSecs = parseInt(next, 10);
        if (isNaN(reviewSecs)) throw new Error(`orchestration adapter args: --review-timeout requires a valid number, got "${next}"`);
        orchestrationConfig.timeouts = { ...orchestrationConfig.timeouts, review: reviewSecs };
        i++;
        break;
      }
      case "--phase-timeout": {
        if (!next) throw new Error("orchestration adapter args: --phase-timeout requires phase:seconds");
        const sep = next.indexOf(":");
        if (sep < 1) throw new Error("orchestration adapter args: --phase-timeout format is phase:seconds");
        const phase = next.slice(0, sep);
        const secs = parseInt(next.slice(sep + 1), 10);
        if (isNaN(secs)) throw new Error(`orchestration adapter args: --phase-timeout invalid seconds in "${next}"`);
        orchestrationConfig.timeouts = { ...orchestrationConfig.timeouts, [phase]: secs };
        i++;
        break;
      }
      default:
        // Handle --duo-peer-slot=N (= syntax)
        if (arg.startsWith("--duo-peer-slot=")) {
          const val = arg.slice("--duo-peer-slot=".length);
          const n = parseInt(val, 10);
          if (isNaN(n) || n < 1) throw new Error(`orchestration adapter args: --duo-peer-slot requires a positive integer, got "${val}"`);
          duoPeerSlot = n;
          break;
        }
        throw new Error(`orchestration adapter args: unsupported flag ${arg}`);
    }
  }

  if (!mode) return parsed;

  if (mode === "solo" || mode === "pilot") {
    // Pilot shares solo's single-coder/no-reviewer invariants verbatim; the
    // flag name in error messages tracks the mode the user actually passed.
    const flag = mode === "pilot" ? "--pilot" : "--solo";
    if (!coderToken) {
      throw new Error(`orchestration adapter args: ${flag} requires --coder provider[:model[:name]]`);
    }
    if (reviewerToken) {
      throw new Error(`orchestration adapter args: ${flag} is incompatible with --reviewer`);
    }
    if (duoPeerSlot != null) {
      throw new Error(`orchestration adapter args: ${flag} is incompatible with --duo-peer-slot`);
    }
    if (reviewerOnlyFlag) {
      throw new Error(`orchestration adapter args: ${flag} is incompatible with ${reviewerOnlyFlag} (no reviewer exists in ${mode} mode)`);
    }
    const coderParsed = parseProviderToken(coderToken, "coder", parsed.model);
    parsed.orchestration = {
      mode,
      config: orchestrationConfig,
      agents: [
        { ...coderParsed, role: "coder", modelExplicit: coderParsed.modelExplicit },
      ],
      coderModelOverride,
      reviewerModelOverride: undefined,
      coderThinkingEffort,
      reviewerThinkingEffort: undefined,
      duoPeerSlot: undefined,
    };
    return parsed;
  }

  // For pair mode: modelExplicit is only true when the user explicitly provided the token
  // (i.e. --coder/--reviewer flag was given) AND that token included an explicit model.
  // When a role token is absent, the default agent is codex with an empty model
  // (resolved through the latest-within-class table in resolveAgentModel) — no
  // concrete version is baked into the fallback (task-c48b7beb).
  const coderParsed = coderToken
    ? parseProviderToken(coderToken, "coder", parsed.model)
    : { name: "coder", provider: "codex" as T3ProviderKind, model: "", modelExplicit: false };
  const reviewerParsed = reviewerToken
    ? parseProviderToken(reviewerToken, "reviewer", parsed.model)
    : { name: "reviewer", provider: "codex" as T3ProviderKind, model: "", modelExplicit: false };
  parsed.orchestration = {
    mode,
    config: orchestrationConfig,
    agents: [
      { ...coderParsed, role: "coder", modelExplicit: coderToken !== null && coderParsed.modelExplicit },
      { ...reviewerParsed, role: "reviewer", modelExplicit: reviewerToken !== null && reviewerParsed.modelExplicit },
    ],
    coderModelOverride,
    reviewerModelOverride,
    coderThinkingEffort,
    reviewerThinkingEffort,
    duoPeerSlot,
  };
  return parsed;
}

function findThread(snapshot: T3Snapshot, threadId: string): T3Thread | null {
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
}

function findProject(snapshot: T3Snapshot, workspaceRoot: string): { id: string; defaultModelSelection?: T3ModelSelection | null } | null {
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
  defaultModelSelection: T3ModelSelection,
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
    defaultModelSelection,
    createdAt: isoNow(),
  });
  return projectId;
}

/** Exported as a test seam (mirrors `resolveAgentModel`): lets a regression test
 *  drive a mocked `dispatchCommand` failure and assert the task-13dee93b AC9
 *  Fable-unavailable rethrow without standing up a real t3code server. */
export async function ensureThread(
  client: T3CodeClient,
  snapshot: T3Snapshot,
  slot: number,
  projectId: string,
  desired: DesiredThreadConfig,
  existingRecord: T3CodeThreadRecord | null | undefined,
): Promise<T3CodeThreadRecord> {
  const model = desired.model || singleThreadCodexModel(loadConfigOrchestration());
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
  const wireProvider = desired.provider ? toWireProvider(desired.provider) : "codex";
  const modelSelection: T3ModelSelection = { provider: wireProvider, model };
  // task-13dee93b AC9: a claude-fable thread.create that fails (model unreachable
  // on the active plan) is rethrown with the actionable config-key remediation;
  // non-Fable failures pass through unchanged. No silent fallback.
  await dispatchWithFableContext(
    () =>
      client.dispatchCommand({
        type: "thread.create",
        commandId: makeId("cmd"),
        threadId,
        projectId,
        title: desired.title,
        modelSelection,
        runtimeMode: desired.runtimeMode,
        interactionMode: desired.interactionMode,
        branch: desired.branch ?? null,
        worktreePath: desired.worktreePath,
        createdAt,
      }),
    model,
    desired.role,
    loadConfigOrchestration(),
  );

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

function orchestrationProjectDir(workspaceRoot: string): string {
  return getMainRepoFromWorktree(workspaceRoot) ?? workspaceRoot;
}

// Import from shared module; re-export for backward compat
import { startOrchestrationProcess } from "../orchestration/process.ts";
export { startOrchestrationProcess };

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
    const defaultModelSelection: T3ModelSelection = { provider: "codex", model: options.model || singleThreadCodexModel(loadConfigOrchestration()) };
    const projectId = await ensureProject(client, snapshot, workspaceRoot, defaultModelSelection);
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

/** Load orchestration-specific settings from config.yaml's mag.orchestration section. */
function loadConfigOrchestration(config?: LudicsFullConfig): Record<string, unknown> | undefined {
  try {
    const cfg = config ?? loadConfigSync();
    const mag = cfg.mag as Record<string, unknown> | undefined;
    return mag?.orchestration as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Thrown by `selectOrchestrationFlags()` when the t3code integration is paused
 * (`mag.t3code_integration_enabled` is false) and the resolved orchestration
 * adapter would be `t3code`. Callers that auto-fill slots
 * (`autoFillAdapterArgs`, `maybeFillEmptySlots`) catch this and skip the slot
 * with a clear log rather than silently falling back to a stale default.
 * See docs/proposals/t3code-integration-feature-flag.md (gh-ludics-539).
 */
export class T3codeIntegrationPausedError extends Error {
  constructor() {
    super("t3code integration is paused (mag.t3code_integration_enabled)");
    this.name = "T3codeIntegrationPausedError";
  }
}

/** Type guard for {@link T3codeIntegrationPausedError} — lets catch sites
 *  distinguish the paused signal from other thrown errors and rethrow the rest. */
export function isT3codeIntegrationPausedError(e: unknown): e is T3codeIntegrationPausedError {
  return e instanceof T3codeIntegrationPausedError;
}

/**
 * Auto-select orchestration flags for the t3code adapter based on task effort.
 *
 * Gated by the t3code integration feature flag (gh-ludics-539): when
 * `mag.t3code_integration_enabled` is off AND the resolved adapter
 * (`globalAdapter()`) is `t3code`, this throws {@link T3codeIntegrationPausedError}
 * instead of returning a selection. When `globalAdapter()` is `tmux`, the flag
 * has no effect — tmux orchestration auto-fill is unaffected.
 *
 * Effort-based selection (when coder is claude-code):
 * - tiny:   solo mode, no pre-work phases, Claude coder model = Sonnet (no reviewer). skip_plan is ignored.
 * - small:  pair mode, no pre-work phases, Claude coder model = Sonnet. skip_plan is ignored (already skipped).
 * - medium: pair mode, --plan unless skip_plan: true in frontmatter, Claude coder model = Opus.
 * - large:  pair mode, --plan --gather (skip_plan is ignored), Claude coder model = Opus.
 *
 * Small/tiny effort auto-skips the plan phase regardless of skip_plan; the flag
 * is a manual override that only applies to medium effort.
 *
 * For non-Claude coder providers (e.g. codex), no model suffix is emitted so the
 * provider's own default applies (and coder_model config fallback remains active).
 *
 * `tiny` effort implies `--solo` unconditionally, bypassing `orchCfg.default_mode`
 * (resolved during task-da8b6dff elaboration).
 *
 * Config keys (mag.orchestration): default_mode, default_coder, default_reviewer
 * These can be overridden by explicit -A adapter args at assign time.
 *
 * Duo mode uses --agent tokens (name:provider[:model]); pair mode uses --coder/--reviewer.
 *
 * @returns An object with the recommended adapter name ("t3code") and args string.
 */
export function selectOrchestrationFlags(
  effort: string,
  config?: LudicsFullConfig,
  options?: { skipPlan?: boolean },
): { adapter: string; args: string; isDuo: boolean } {
  // gh-ludics-539: refuse a t3code adapter selection while the integration is
  // paused. Resolved once here so both the `tiny` early-return and the main
  // return use the same value; the gate fires only when the selection would
  // be `t3code` (tmux orchestration is unaffected).
  const resolvedAdapter = globalAdapter();
  if (resolvedAdapter === "t3code" && !t3codeIntegrationEnabled()) {
    throw new T3codeIntegrationPausedError();
  }

  const orchCfg = loadConfigOrchestration(config);
  const mode = (orchCfg?.default_mode as string | undefined)?.trim() || "pair";
  const coder = (orchCfg?.default_coder as string | undefined)?.trim() || "claude-code";
  const reviewer = (orchCfg?.default_reviewer as string | undefined)?.trim() || "codex";
  const isDuo = mode === "duo";

  const norm = (effort ?? "").toLowerCase().trim();

  // `tiny` effort implies solo mode unconditionally (ignores orchCfg.default_mode).
  // Single coder, no pre-work phases, Sonnet for claude-code providers.
  if (norm === "tiny") {
    const modelSuffix = coder === "claude-code" ? `:${classModel("claude-sonnet", orchCfg)}` : "";
    const args = `--solo --coder ${coder}${modelSuffix}`;
    return { adapter: resolvedAdapter, args, isDuo: false };
  }

  const phaseFlags: string[] = [];

  // Only apply effort-based model selection for Claude providers; other providers
  // (codex) carry no suffix and resolve their latest-within-class default later
  // in resolveAgentModel. claude-code coders resolve to their per-role high-end
  // class (claude-opus by default, claude-fable when selected — task-13dee93b) for
  // medium/large effort, the sonnet class otherwise (task-c48b7beb). The literal
  // `orchCfg?.coder_class` / `orchCfg?.reviewer_class` reads below also satisfy the
  // config-reference lint's Direction-4 adapter-read scan for those keys.
  let coderModelSuffix = "";
  if (coder === "claude-code") {
    if (norm === "large" || norm === "medium") {
      coderModelSuffix = `:${classModel(normalizeHighEndClass(orchCfg?.coder_class), orchCfg)}`;
    } else {
      coderModelSuffix = `:${classModel("claude-sonnet", orchCfg)}`;
    }
  }

  // Reviewer high-end class: today a claude-code reviewer carries no model suffix
  // (resolving to the Sonnet generic default). To make `reviewer_class` meaningful
  // (AC3/AC5), emit the per-role high-end class suffix for medium/large effort
  // claude-code reviewers; tiny/small reviewers (if any) and codex stay unchanged.
  let reviewerModelSuffix = "";
  if (reviewer === "claude-code" && (norm === "large" || norm === "medium")) {
    reviewerModelSuffix = `:${classModel(normalizeHighEndClass(orchCfg?.reviewer_class), orchCfg)}`;
  }

  // Small / tiny / unknown effort: never run pre-work phases.
  // `skip_plan` is only consulted for medium effort (manual override for
  // exhaustive proposals). Large always runs --plan --gather.
  if (norm === "large") {
    phaseFlags.push("--plan", "--gather");
  } else if (norm === "medium") {
    if (!options?.skipPlan) phaseFlags.push("--plan");
  }
  // else: small / tiny / unknown → no pre-work phases (no --plan, no --gather)

  // Hierarchical duo: both duo and pair produce pair-mode args.
  // For duo, the actual two-slot expansion with swapped roles is done by callers
  // (maybeFillEmptySlots / slot assign CLI) using expandDuoSlots().
  const modeArgs = [
    "--pair",
    `--coder ${coder}${coderModelSuffix}`,
    `--reviewer ${reviewer}${reviewerModelSuffix}`,
  ];

  const args = [...modeArgs, ...phaseFlags].join(" ");
  // Use the global adapter setting so orchestration flags work with either backend
  return { adapter: resolvedAdapter, args, isDuo };
}

/**
 * Convenience wrapper: reads skip_plan from task file content and
 * delegates to selectOrchestrationFlags(). Used by both slotStart()
 * auto-fill and maybeFillEmptySlots() keepalive assignment.
 *
 * Inherits the gh-ludics-539 gate: throws {@link T3codeIntegrationPausedError}
 * when the t3code integration is paused and the resolved adapter is `t3code`.
 */
export function selectOrchestrationFlagsForTask(
  taskContent: string,
  effort: string,
  config?: LudicsFullConfig,
): { adapter: string; args: string; isDuo: boolean } {
  const fm = parseTaskFrontmatter(taskContent);

  // Explicit pilot override: `orchestration_mode: pilot` forces a user-piloted
  // solo session regardless of effort. Single coder, no reviewer, no pre-work
  // phases (no --plan/--gather) — modeled on the tiny/solo branch but emitting
  // --pilot instead of --solo. The work phase waits for the user.
  if ((fm.orchestration_mode ?? "").toString().trim() === "pilot") {
    const resolvedAdapter = globalAdapter();
    if (resolvedAdapter === "t3code" && !t3codeIntegrationEnabled()) {
      throw new T3codeIntegrationPausedError();
    }
    const orchCfg = loadConfigOrchestration(config);
    const coder = (orchCfg?.default_coder as string | undefined)?.trim() || "claude-code";
    const modelSuffix = coder === "claude-code" ? `:${classModel("claude-sonnet", orchCfg)}` : "";
    const args = `--pilot --coder ${coder}${modelSuffix}`;
    return { adapter: resolvedAdapter, args, isDuo: false };
  }

  const skipPlan = fm.skip_plan === true;
  return selectOrchestrationFlags(effort, config, { skipPlan });
}

/** Resolve the final model for an agent, applying config and adapter arg overrides.
 *  Exported as a test seam: the latest-within-class fallback tier is the runtime
 *  path that must throw loudly when the config table is missing a tracked class. */
export function resolveAgentModel(
  agent: ParsedAgentToken,
  index: number,
  orchCfg: Record<string, unknown> | undefined,
  coderOverride: string | undefined,
  reviewerOverride: string | undefined,
): string {
  const isCoderSlot = agent.role === "coder" || (!agent.role && index === 0);
  const isReviewerSlot = agent.role === "reviewer" || (!agent.role && index === 1);

  // Highest priority: explicit --coder-model / --reviewer-model flag
  if (isCoderSlot && coderOverride) return coderOverride;
  if (isReviewerSlot && reviewerOverride) return reviewerOverride;

  // Next: explicit model in --coder provider:model token
  if (agent.modelExplicit) return agent.model;

  // Next: config.yaml mag.orchestration defaults
  if (isCoderSlot) {
    const cfgModel = orchCfg?.coder_model as string | undefined;
    if (cfgModel?.trim()) return cfgModel.trim();
  }
  if (isReviewerSlot) {
    const cfgModel = orchCfg?.reviewer_model as string | undefined;
    if (cfgModel?.trim()) return cfgModel.trim();
  }

  // Explicit-but-unflagged token model (e.g. `--coder claude-code:some-model`
  // already handled above via modelExplicit; this guards any non-empty model).
  if (agent.model.trim()) return agent.model;

  // Lowest tier: latest-within-class default from the config table. Throws
  // loudly when the resolved class is unset (task-c48b7beb) — replaces the
  // pinned per-class default constants removed in this task.
  return providerDefaultModel(agent.provider, orchCfg);
}

/** Resolve effort level for an agent, applying config and adapter arg overrides. Defaults to "high". */
function resolveAgentThinkingEffort(
  agent: ParsedAgentToken,
  index: number,
  orchCfg: Record<string, unknown> | undefined,
  coderEffort: string | undefined,
  reviewerEffort: string | undefined,
): string {
  const isCoderSlot = agent.role === "coder" || (!agent.role && index === 0);
  const isReviewerSlot = agent.role === "reviewer" || (!agent.role && index === 1);

  // Highest priority: adapter arg flags
  if (isCoderSlot && coderEffort) return coderEffort;
  if (isReviewerSlot && reviewerEffort) return reviewerEffort;

  // Fallback: config.yaml defaults (support both coder_effort and legacy coder_thinking_effort)
  if (isCoderSlot) {
    const cfgEffort = (orchCfg?.coder_effort ?? orchCfg?.coder_thinking_effort) as string | undefined;
    if (cfgEffort?.trim()) return cfgEffort.trim();
  }
  if (isReviewerSlot) {
    const cfgEffort = (orchCfg?.reviewer_effort ?? orchCfg?.reviewer_thinking_effort) as string | undefined;
    if (cfgEffort?.trim()) return cfgEffort.trim();
  }

  // Default: high effort for both coder and reviewer
  return "high";
}

async function startOrchestratedThreads(
  ctx: AdapterContext,
  record: T3CodeServerRecord,
  options: ParsedAdapterArgs,
  workspaceRoot: string,
): Promise<string> {
  const orchestration = options.orchestration!;
  const taskId = ctx.taskId;
  if (!taskId) {
    throw new Error(`slot ${ctx.slot}: taskId is required for orchestration. Assign a task first.`);
  }
  const title = options.title ?? defaultTitle(ctx, workspaceRoot);
  const projectDir = orchestrationProjectDir(workspaceRoot);
  const existing = readSlotState(ctx.slot, ctx.harnessDir);

  if (existing?.orchestration?.pid) killPid(existing.orchestration.pid);

  // Load config once and thread through all helpers.
  const config = loadConfigSync();
  const orchCfg = loadConfigOrchestration(config);

  // Merge phase_timeouts from config.yaml into orchestration config (adapter args have higher priority).
  const configPhaseTimeouts = orchCfg?.phase_timeouts as Record<string, number> | undefined;
  if (configPhaseTimeouts && typeof configPhaseTimeouts === "object") {
    orchestration.config.timeouts = { ...configPhaseTimeouts, ...(orchestration.config.timeouts ?? {}) };
  }

  // task-a670cdbf: wire mag.orchestration.substantive_stall.* YAML keys
  // into the persisted state.config.substantiveStall so the runtime
  // detector reads YAML overrides. defaultOrchestrationConfig fills any
  // missing leaves; migrateState backfills legacy slot JSON on read.
  const substantiveStallOverrides = parseSubstantiveStallOverrides(orchCfg?.substantive_stall);
  if (Object.keys(substantiveStallOverrides).length > 0) {
    orchestration.config.substantiveStall = {
      ...DEFAULT_SUBSTANTIVE_STALL_CONFIG,
      ...(orchestration.config.substantiveStall ?? {}),
      ...substantiveStallOverrides,
    };
  }

  // Resolve models up-front, BEFORE createWorktrees, so a missing/blank
  // model_classes entry throws loudly before any worktree / thread / runner
  // side effect is created (task-c48b7beb).
  const resolvedModels = orchestration.agents.map((agent, index) =>
    resolveAgentModel(
      agent,
      index,
      orchCfg,
      orchestration.coderModelOverride,
      orchestration.reviewerModelOverride,
    ),
  );

  // Read proposal path for the reachability guard (AC1–AC5).
  const taskFilePath_ = join(ctx.harnessDir, "tasks", `${taskId}.md`);
  const taskContent_ = existsSync(taskFilePath_) ? readFileSync(taskFilePath_, "utf-8") : null;
  const proposalPath_ = taskContent_ ? (parseTaskFrontmatter(taskContent_).proposal ?? "") : "";

  const setup = createWorktrees(projectDir, taskId, orchestration.agents, undefined, ctx.slot, orchestration.mode, proposalPath_);
  symlinkPeerSync(setup.peerSyncDir, setup.agentWorktrees);

  const agents: AgentConfig[] = orchestration.agents.map((agent, index) => ({
    name: agent.name,
    provider: agent.provider,
    role: agent.role,
    model: resolvedModels[index]!,
    thinkingEffort: resolveAgentThinkingEffort(
      agent,
      index,
      orchCfg,
      orchestration.coderThinkingEffort,
      orchestration.reviewerThinkingEffort,
    ),
    branch: setup.branches[agent.name]!,
    worktreePath: setup.agentWorktrees[agent.name]!,
  }));

  initPeerSync(
    setup.peerSyncDir,
    taskId,
    orchestration.mode,
    projectDir,
    agents,
    { root: setup.rootWorktree, ...setup.agentWorktrees },
    ctx.slot,
  );
  writeAgentMarkerFiles(setup.peerSyncDir, setup.agentWorktrees);

  const existingThreadMap = new Map(
    (existing?.threads ?? []).map((thread) => [thread.worktreePath, thread]),
  );

  const slotThreads = await withClient(record, async (client) => {
    const snapshot = await client.getSnapshot();
    const firstAgent = agents[0];
    const defaultModelSelection: T3ModelSelection = {
      provider: firstAgent?.provider ? toWireProvider(firstAgent.provider) : "codex",
      model: firstAgent?.model ?? options.model ?? classModel("codex", orchCfg),
    };
    const projectId = await ensureProject(client, snapshot, projectDir, defaultModelSelection);
    const created: T3CodeThreadRecord[] = [];
    for (const agent of agents) {
      const desired = buildOrchestratedDesiredThreadConfig(
        agent,
        ctx.slot,
        ctx.taskId,
        { runtimeMode: options.runtimeMode, interactionMode: options.interactionMode },
      );
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
    taskId,
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
    backend: "t3code",
    branches: setup.branches,
    slotTitle: title,
    duoPeerSlot: orchestration.duoPeerSlot ?? null,
    harnessDir: ctx.harnessDir,
  };
  persistState(state, ctx.harnessDir);

  const pid = await startOrchestrationProcess(ctx.slot, ctx.harnessDir, taskId);
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
  const options = parseOrchestrationAdapterArgs(ctx.adapterArgs);

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
    md.bullet(`Task: ${orchestration.taskId}`);
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

async function stop(ctx: AdapterContext, options?: { preserveState?: boolean }): Promise<string> {
  const slotState = readSlotState(ctx.slot, ctx.harnessDir);
  if (!slotState || slotState.threads.length === 0) {
    return `t3code slot ${ctx.slot} already stopped`;
  }

  if (slotState.orchestration?.pid) killPid(slotState.orchestration.pid);

  const orchestrationState = slotState.orchestration
    ? readOrchestrationState(ctx.slot, ctx.harnessDir)
    : null;

  // Stop agent sessions immediately (but defer thread deletion for post-mortem)
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
      }
    });
  }

  // Defer artifact cleanup for post-mortem window
  if (!options?.preserveState) {
    const threadIds = slotState.threads.map((t) => t.threadId);
    if (orchestrationState) {
      recordDeferredCleanup(buildCleanupEntry(orchestrationState, ctx.slot, {
        t3codeThreadIds: threadIds,
      }), ctx.harnessDir);
      removeOrchestrationState(ctx.slot, ctx.harnessDir);
    } else if (threadIds.length > 0) {
      // Non-orchestrated single-thread sessions: defer thread deletion only.
      // `mode` is a placeholder here (no orchestration state exists); value is never
      // consulted for mode dispatch because the cleanup entry has no agents.
      recordDeferredCleanup({
        timestamp: new Date().toISOString(),
        projectDir: "",
        taskId: "",
        slot: ctx.slot,
        agents: [],
        mode: "pair",
        branches: [],
        worktreePaths: [],
        tmuxSessionNames: [],
        peerSyncLink: null,
        t3codeThreadIds: threadIds,
      }, ctx.harnessDir);
    }
    removeSlotState(ctx.slot, ctx.harnessDir);
  }
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
