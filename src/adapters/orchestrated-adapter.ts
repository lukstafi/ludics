// Shared logic for orchestrated adapters (agent-duo + agent-pair variants).
//
// Both adapters share ~80% structure. The differences are parameterized
// via OrchestratedConfig.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import YAML from "yaml";
import {
  listSessions,
  type SessionInfo,
  readBasicState,
  readPorts,
  readWorktrees,
} from "./peer-sync.ts";
import {
  readStatusFile,
  formatAgentStatus,
  readSingleFile,
  resolveProjectDir,
  latestMtime,
  isGitWorktree,
  getMainRepoFromWorktree,
} from "./base.ts";
import { getUrl } from "../network.ts";
import { loadConfigSync, type LudicsFullConfig, type ProjectConfig } from "../config.ts";
import { MarkdownBuilder } from "./markdown.ts";
import type { AdapterContext, Adapter } from "./types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OrchestratedStatusFile {
  label: string;    // "Claude" | "Codex" | "Coder" | "Reviewer"
  fileName: string; // "claude.status" | "codex.status" | "coder.status" | "reviewer.status"
}

export interface OrchestratedConfig {
  modeLabel: string;                     // e.g. "agent-duo" | "agent-pair-codex"
  modeFilter?: string;                   // optional filter against .peer-sync/mode (e.g. "duo", "pair")
  statusSectionLabel: string;            // "Agents" | "Roles"
  statusFiles: OrchestratedStatusFile[]; // which status files to check
  portLabels: Record<string, string>;    // PORT_KEY → display label
  worktreeKeys: string[];                // which worktree keys to display
  cliCommand: string;                    // e.g. "agent-duo" | "agent-pair"
  cliStartArgs?: string;                 // e.g. "--codex" for pair-codex
  cliStartHint?: string;                 // extra guidance for start command options
  cliStopArgs?: string;                  // optional extra args for stop commands
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesMode(peerSyncPath: string, modeFilter?: string): boolean {
  if (!modeFilter) return true;
  const mode = readSingleFile(join(peerSyncPath, "mode"));
  return mode === modeFilter;
}

function parseArgs(raw?: string, sourceLabel: string = "arguments"): string[] {
  if (!raw) return [];
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

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

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
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\") {
        escaping = true;
      } else {
        current += ch;
      }
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
  if (inSingle || inDouble) {
    throw new Error(`unterminated quote in ${sourceLabel}`);
  }
  pushCurrent();

  return args;
}

function parseArgSpec(value: unknown, sourceLabel: string): string[] | null {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    return parseArgs(value, sourceLabel);
  }

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item !== "string") {
        throw new Error(`${sourceLabel}[${i}] must be a string`);
      }
      if (item.length > 0) out.push(item);
    }
    return out;
  }

  if (typeof value === "object") {
    const data = value as Record<string, unknown>;
    if ("args" in data) {
      return parseArgSpec(data.args, `${sourceLabel}.args`);
    }
  }

  throw new Error(`${sourceLabel} must be a shell-style string or string array`);
}

function parseModeAwareArgSpec(
  value: unknown,
  modeKeys: string[],
  sourceLabel: string,
): string[] {
  if (value === undefined || value === null) return [];

  if (typeof value === "string" || Array.isArray(value)) {
    return parseArgSpec(value, sourceLabel) ?? [];
  }

  if (typeof value !== "object") {
    throw new Error(`${sourceLabel} has invalid type`);
  }

  const data = value as Record<string, unknown>;
  for (const mode of modeKeys) {
    if (!(mode in data)) continue;
    return parseArgSpec(data[mode], `${sourceLabel}.${mode}`) ?? [];
  }

  const defaultArgs = parseArgSpec(data.default, `${sourceLabel}.default`);
  if (defaultArgs !== null) return defaultArgs;

  const directArgs = parseArgSpec(data.args, `${sourceLabel}.args`);
  if (directArgs !== null) return directArgs;

  return [];
}

function parseTaskFrontmatter(content: string): Record<string, unknown> | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  try {
    const parsed = YAML.parse(fmMatch[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function adapterModeKeys(ctxMode: string, modeLabel: string): string[] {
  return Array.from(new Set([ctxMode, modeLabel].filter(Boolean)));
}

function projectMatchesName(project: ProjectConfig, taskProject: string): boolean {
  if (project.name === taskProject) return true;
  const repoTail = project.repo.split("/").pop() ?? "";
  return repoTail === taskProject;
}

function resolveAdapterDefaultArgs(config: LudicsFullConfig, modeKeys: string[]): string[] {
  const adapters = config.adapters as Record<string, unknown> | undefined;
  if (!adapters) return [];

  for (const mode of modeKeys) {
    const entry = adapters[mode];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry as Record<string, unknown>;
    const parsed = parseArgSpec(data.default_args, `config adapters.${mode}.default_args`);
    if (parsed !== null) return parsed;
  }
  return [];
}

function resolveProjectProfileArgs(
  config: LudicsFullConfig,
  taskProject: string,
  modeKeys: string[],
): string[] {
  if (!taskProject) return [];
  const project = (config.projects ?? []).find((p) => projectMatchesName(p, taskProject));
  if (!project || !project.adapter_profiles) return [];

  const profiles = project.adapter_profiles as Record<string, unknown>;
  for (const mode of modeKeys) {
    if (!(mode in profiles)) continue;
    return parseModeAwareArgSpec(
      profiles[mode],
      modeKeys,
      `project "${project.name}" adapter_profiles.${mode}`,
    );
  }

  return parseModeAwareArgSpec(
    profiles.default,
    modeKeys,
    `project "${project.name}" adapter_profiles.default`,
  );
}

interface TaskRuntimeMetadata {
  projectName: string;
  taskArgs: string[];
}

function readTaskRuntimeMetadata(
  ctx: AdapterContext,
  modeKeys: string[],
): TaskRuntimeMetadata {
  if (!ctx.taskId) return { projectName: "", taskArgs: [] };

  const taskFile = join(ctx.harnessDir, "tasks", `${ctx.taskId}.md`);
  if (!existsSync(taskFile)) return { projectName: "", taskArgs: [] };

  const content = readFileSync(taskFile, "utf-8");
  const frontmatter = parseTaskFrontmatter(content);
  if (!frontmatter) return { projectName: "", taskArgs: [] };

  const projectName = typeof frontmatter.project === "string"
    ? frontmatter.project.trim()
    : "";
  const rawTaskArgs = frontmatter.adapter_args ?? frontmatter.adapterArgs;
  const taskArgs = parseModeAwareArgSpec(rawTaskArgs, modeKeys, `task ${ctx.taskId} adapter_args`);

  return { projectName, taskArgs };
}

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readFrontmatterField(content: string, field: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fmMatch[1]!.match(new RegExp(`^\\s*${escapedField}:\\s*(.+)$`, "m"));
  if (!match) return null;

  const value = normalizeYamlScalar(match[1]!);
  if (!value || value.toLowerCase() === "null") return null;
  return value;
}

function resolveTaskRelativePath(projectDir: string, rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return resolve(process.env.HOME ?? "~", rawPath.slice(2));
  }
  if (rawPath.startsWith("/")) return resolve(rawPath);
  return resolve(projectDir, rawPath);
}

function proposalFeatureName(proposalPath: string): string {
  const trimmed = proposalPath.trim();
  const base = trimmed.split("/").pop() ?? "";
  const name = base.replace(/\.md$/i, "").trim();
  if (!name) throw new Error(`invalid proposal path "${proposalPath}"`);
  return name;
}

interface TaskLaunchMetadata {
  launchFeature: string;
}

function readTaskLaunchMetadata(
  cfg: OrchestratedConfig,
  ctx: AdapterContext,
  projectDir: string,
): TaskLaunchMetadata {
  if (!ctx.taskId) {
    throw new Error(`${cfg.cliCommand} start blocked: missing task id for orchestrated launch`);
  }

  const taskFile = join(ctx.harnessDir, "tasks", `${ctx.taskId}.md`);
  if (!existsSync(taskFile)) {
    throw new Error(
      `${cfg.cliCommand} start blocked: missing task metadata file for ${ctx.taskId} (${taskFile})`,
    );
  }

  const taskContent = readFileSync(taskFile, "utf-8");
  const proposalValue = readFrontmatterField(taskContent, "proposal");
  if (!proposalValue) {
    throw new Error(
      `${cfg.cliCommand} start blocked: task ${ctx.taskId} has no proposal metadata. Refusing ambiguous launch.`,
    );
  }

  const proposalFile = resolveTaskRelativePath(projectDir, proposalValue);
  if (!existsSync(proposalFile)) {
    throw new Error(
      `${cfg.cliCommand} start blocked: proposal for ${ctx.taskId} not found at ${proposalFile}`,
    );
  }

  return {
    launchFeature: proposalFeatureName(proposalValue),
  };
}

function selectSessionForTask(
  sessions: SessionInfo[],
  taskId: string,
  featureAliases: string[] = [],
): SessionInfo | null {
  if (sessions.length === 0) return null;
  if (!taskId && featureAliases.length === 0) return sessions.length === 1 ? sessions[0]! : null;

  const candidates = [taskId, ...featureAliases].filter(Boolean);
  if (candidates.length === 0) return sessions.length === 1 ? sessions[0]! : null;

  for (const candidate of candidates) {
    const exact = sessions.find((s) => s.feature === candidate);
    if (exact) return exact;
  }

  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundaryPattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
    const boundaryMatch = sessions.find((s) => boundaryPattern.test(s.feature));
    if (boundaryMatch) return boundaryMatch;
  }

  return sessions.length === 1 ? sessions[0]! : null;
}

function collectPrLinks(peerSyncPath: string): string[] {
  const links = new Set<string>();
  try {
    const files = readdirSync(peerSyncPath).filter((f) => f.endsWith(".pr"));
    for (const fileName of files) {
      const content = readFileSync(join(peerSyncPath, fileName), "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const url = line.trim();
        if (/^https?:\/\/\S+$/i.test(url)) links.add(url);
      }
    }
  } catch {
    // ignore read failures
  }
  return Array.from(links);
}

function parsePrNumberFromLink(link: string): string | null {
  const match = link.match(/\/pull\/(\d+)(?:[/?#]|$)/i);
  return match ? match[1]! : null;
}

interface GhPrState {
  number: string;
  mergedAt: string;
}

function readMergedPrViaGh(projectDir: string, prRef: string): GhPrState | null {
  try {
    const result = Bun.spawnSync(
      ["gh", "pr", "view", prRef, "--json", "number,mergedAt"],
      {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );
    if (result.exitCode !== 0) return null;

    const parsed = JSON.parse(result.stdout.toString().trim()) as {
      number?: number | string;
      mergedAt?: string | null;
    };
    if (!parsed.mergedAt || parsed.number === undefined || parsed.number === null) return null;
    return {
      number: String(parsed.number),
      mergedAt: parsed.mergedAt,
    };
  } catch {
    return null;
  }
}

function resolveFollowupPrNumber(
  projectDir: string,
  modeFilter: string | undefined,
  taskId: string,
  featureAliases: string[] = [],
): string | null {
  const sessions = listSessions(projectDir).filter((s) => matchesMode(s.peerSyncPath, modeFilter));
  const session = selectSessionForTask(sessions, taskId, featureAliases);
  if (!session) return null;

  const prLinks = collectPrLinks(session.peerSyncPath);
  if (prLinks.length === 0) return null;

  // agent-pair typically has one PR, so parse the single URL directly.
  if (modeFilter === "pair") {
    for (const link of prLinks) {
      const number = parsePrNumberFromLink(link);
      if (number) return number;
    }
    return null;
  }

  // agent-duo can have multiple PRs; prefer whichever GitHub reports as merged.
  if (modeFilter === "duo") {
    const merged: GhPrState[] = [];
    for (const link of prLinks) {
      const state = readMergedPrViaGh(projectDir, link);
      if (state) merged.push(state);
    }
    if (merged.length > 0) {
      merged.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
      return merged[0]!.number;
    }
  }

  for (const link of prLinks) {
    const number = parsePrNumberFromLink(link);
    if (number) return number;
  }
  return null;
}

function injectFollowupPrNumber(
  adapterArgs: string[],
  prNumber: string | null,
): string[] {
  const output: string[] = [];

  for (let i = 0; i < adapterArgs.length; i++) {
    const arg = adapterArgs[i]!;
    output.push(arg);
    if (arg !== "--followup") continue;

    const next = adapterArgs[i + 1];
    if (next && !next.startsWith("-")) {
      output.push(parsePrNumberFromLink(next) ?? next);
      i++;
      continue;
    }
    if (prNumber) output.push(prNumber);
  }

  return output;
}

function hasBareFollowupFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--followup") continue;
    const next = args[i + 1];
    if (!next || next.startsWith("-")) return true;
    i++;
  }
  return false;
}

function normalizeProjectDirCandidate(raw: string): string {
  const expanded = raw.startsWith("~/")
    ? join(process.env.HOME ?? "~", raw.slice(2))
    : raw;
  const abs = resolve(expanded);
  if (isGitWorktree(abs)) {
    const mainRepo = getMainRepoFromWorktree(abs);
    if (mainRepo) return mainRepo;
  }
  return abs;
}

function resolveAdapterProjectDir(ctx: AdapterContext): string {
  const candidates: string[] = [];
  if (ctx.path && ctx.path !== "null") candidates.push(ctx.path);
  candidates.push(resolveProjectDir(ctx.session, true));

  const normalized = Array.from(new Set(candidates.map(normalizeProjectDirCandidate)));

  for (const dir of normalized) {
    if (existsSync(join(dir, ".agent-sessions"))) return dir;
  }
  for (const dir of normalized) {
    if (existsSync(dir)) return dir;
  }
  return normalized[0] ?? process.cwd();
}

function appendSessionState(
  md: MarkdownBuilder,
  cfg: OrchestratedConfig,
  syncDir: string,
  feature: string,
): void {
  if (!existsSync(syncDir)) return;

  const state = readBasicState(syncDir);

  // Header
  if (state.session) md.keyValue("Session", state.session);
  if (feature) md.keyValue("Feature", feature);

  // Status files (agents/roles)
  const hasAnyStatus = cfg.statusFiles.some((sf) =>
    existsSync(join(syncDir, sf.fileName)),
  );
  if (hasAnyStatus) {
    md.section(cfg.statusSectionLabel);
    for (const sf of cfg.statusFiles) {
      const status = readStatusFile(join(syncDir, sf.fileName));
      if (status?.status) md.bullet(`${sf.label}: ${formatAgentStatus(status)}`);
    }
  }

  // Terminals from ports file
  const ports = readPorts(syncDir);
  if (ports.size > 0) {
    md.section("Terminals");
    for (const [key, port] of ports) {
      const label = cfg.portLabels[key];
      if (label) md.bullet(`${label}: ${getUrl(port)}`);
    }
  }

  // Runtime
  if (state.phase || state.round) {
    md.section("Runtime");
    if (state.phase) md.bullet(`Phase: ${state.phase}`);
    if (state.round) md.bullet(`Round: ${state.round}`);
  }

  // Worktrees
  const worktrees = readWorktrees(syncDir);
  const wtEntries = Object.entries(worktrees).filter(([k]) =>
    cfg.worktreeKeys.includes(k),
  );
  if (wtEntries.length > 0) {
    md.section("Git");
    for (const [agent, path] of wtEntries) {
      md.bullet(`${agent} worktree: ${path}`);
    }
  }

  // Error warning
  const errorLog = join(syncDir, "error.log");
  if (existsSync(errorLog)) {
    const content = readSingleFile(errorLog);
    if (content) {
      const errorCount = content.split("\n").filter(Boolean).length;
      if (errorCount > 0) {
        md.section("Warnings");
        md.bullet(`Error log has ${errorCount} entries`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createOrchestratedAdapter(cfg: OrchestratedConfig): Adapter {
  const startArgs = parseArgs(cfg.cliStartArgs);
  const stopArgs = parseArgs(cfg.cliStopArgs);

  function readState(ctx: AdapterContext): string | null {
    const projectDir = resolveAdapterProjectDir(ctx);
    const sessions = listSessions(projectDir);
    const filtered = sessions.filter((s) => matchesMode(s.peerSyncPath, cfg.modeFilter));
    const count = filtered.length;
    if (count === 0) return null;

    const md = new MarkdownBuilder();
    md.keyValue("Mode", `${cfg.modeLabel} (${count} sessions)`);
    md.separator();

    let first = true;
    for (const session of filtered) {
      if (!first) md.rule();
      first = false;

      md.heading(3, `Task: ${session.feature}`);
      md.keyValue("Root", session.rootWorktree);
      appendSessionState(md, cfg, session.peerSyncPath, session.feature);
    }

    return md.toString();
  }

  function start(ctx: AdapterContext): string {
    const projectDir = resolveAdapterProjectDir(ctx);
    const modeKeys = adapterModeKeys(ctx.mode, cfg.modeLabel);
    const config = loadConfigSync();
    const taskRuntime = readTaskRuntimeMetadata(ctx, modeKeys);
    const adapterDefaults = resolveAdapterDefaultArgs(config, modeKeys);
    const projectProfileArgs = resolveProjectProfileArgs(config, taskRuntime.projectName, modeKeys);
    const slotArgs = parseArgs(ctx.adapterArgs, `slot ${ctx.slot} Adapter Args`);
    const parsedAdapterArgs = [
      ...adapterDefaults,
      ...projectProfileArgs,
      ...slotArgs,
      ...taskRuntime.taskArgs,
    ];
    const wantsFollowup = parsedAdapterArgs.includes("--followup");
    const taskMeta = ctx.taskId
      ? (() => {
        try {
          return readTaskLaunchMetadata(cfg, ctx, projectDir);
        } catch (err) {
          if (!wantsFollowup) throw err;
          return null;
        }
      })()
      : null;
    const feature = taskMeta?.launchFeature || ctx.taskId || ctx.process || `slot-${ctx.slot}`;
    const followupPr = wantsFollowup && ctx.taskId
      ? resolveFollowupPrNumber(
        projectDir,
        cfg.modeFilter,
        ctx.taskId,
        taskMeta ? [taskMeta.launchFeature] : [],
      )
      : null;
    const adapterArgs = injectFollowupPrNumber(parsedAdapterArgs, followupPr);
    if (wantsFollowup && hasBareFollowupFlag(adapterArgs)) {
      throw new Error(`could not resolve merged PR number for ${cfg.modeLabel} followup (${ctx.taskId || feature})`);
    }
    const args = wantsFollowup
      ? [cfg.cliCommand, "start", ...startArgs, ...adapterArgs]
      : [cfg.cliCommand, "start", feature, ...startArgs, ...adapterArgs];

    const result = Bun.spawnSync(args, {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      const stdout = result.stdout.toString().trim();
      const detail = stderr || stdout || `exit ${result.exitCode}`;
      throw new Error(`${cfg.cliCommand} start failed: ${detail}`);
    }

    return result.stdout.toString().trim() || `${cfg.cliCommand} start ${feature} (cwd=${projectDir})`;
  }

  function stop(ctx: AdapterContext): string {
    const projectDir = resolveAdapterProjectDir(ctx);
    const args = [cfg.cliCommand, "stop", ...stopArgs];
    if (ctx.taskId) {
      const sessions = listSessions(projectDir).filter((s) => matchesMode(s.peerSyncPath, cfg.modeFilter));
      let aliases: string[] = [];
      try {
        aliases = [readTaskLaunchMetadata(cfg, ctx, projectDir).launchFeature];
      } catch {
        aliases = [];
      }
      const selected = selectSessionForTask(sessions, ctx.taskId, aliases);
      args.push("--feature", selected?.feature ?? aliases[0] ?? ctx.taskId);
    }

    const result = Bun.spawnSync(args, {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      const stdout = result.stdout.toString().trim();
      const detail = stderr || stdout || `exit ${result.exitCode}`;
      throw new Error(`${cfg.cliCommand} stop failed: ${detail}`);
    }

    return result.stdout.toString().trim() || `${cfg.cliCommand} stop (cwd=${projectDir})`;
  }

  function lastActivity(ctx: AdapterContext): string | null {
    const projectDir = resolveAdapterProjectDir(ctx);
    const sessions = listSessions(projectDir);
    const filtered = sessions.filter((s) => matchesMode(s.peerSyncPath, cfg.modeFilter));
    if (filtered.length === 0) return null;

    // Collect status file paths across all sessions
    const paths: string[] = [];
    for (const session of filtered) {
      for (const sf of cfg.statusFiles) {
        paths.push(join(session.peerSyncPath, sf.fileName));
      }
      // Also check phase file — updates on orchestrator state changes
      paths.push(join(session.peerSyncPath, "phase"));
    }
    return latestMtime(paths);
  }

  return { readState, start, stop, lastActivity };
}
