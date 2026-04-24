// Task frontmatter parsing and writing

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { atomicWriteFileSync } from "../json.ts";
import type { TaskFrontmatter } from "./types.ts";

/** Regex for valid task IDs — used across all task-related endpoints. */
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;

export const PRIORITY_INCREASE: Record<string, string> = { D: "C", C: "B", B: "A", A: "S" };
export const PRIORITY_DECREASE: Record<string, string> = { S: "A", A: "B", B: "C", C: "D" };

/** Numeric sort key for priority levels. S < A < B < C < D < anything else. */
export function priorityValue(p: string): number {
  switch (p) {
    case "S": return 0;
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
    case "D": return 4;
    default: return 9;
  }
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

export type ParsedTaskFrontmatter = Partial<TaskFrontmatter>;

const PARSE_CACHE = new Map<string, ParsedTaskFrontmatter>();
const PARSE_CACHE_MAX = 512;

/** Test-only: reset the module-level cache. Not exported via index. */
export function _resetParseTaskFrontmatterCache(): void {
  PARSE_CACHE.clear();
}

/** Test-only: peek cache size. */
export function _parseTaskFrontmatterCacheSize(): number {
  return PARSE_CACHE.size;
}

export function parseTaskFrontmatter(content: string): ParsedTaskFrontmatter {
  const hit = PARSE_CACHE.get(content);
  if (hit) return hit;
  const parsed = parseTaskFrontmatterUncached(content);
  deepFreezeParsed(parsed);
  if (PARSE_CACHE.size >= PARSE_CACHE_MAX) {
    const firstKey = PARSE_CACHE.keys().next().value;
    if (firstKey !== undefined) PARSE_CACHE.delete(firstKey);
  }
  PARSE_CACHE.set(content, parsed);
  return parsed;
}

/**
 * Freeze the parsed object and every nested container it owns so cached
 * reads cannot be mutated through `.dependencies.blocks.push(...)` or
 * similar nested paths. Shallow freeze alone leaves those arrays writable.
 */
function deepFreezeParsed(parsed: ParsedTaskFrontmatter): void {
  if (parsed.dependencies) {
    Object.freeze(parsed.dependencies.blocks);
    Object.freeze(parsed.dependencies.blocked_by);
    Object.freeze(parsed.dependencies.relates_to);
    Object.freeze(parsed.dependencies);
  }
  if (parsed.merged_from) Object.freeze(parsed.merged_from);
  if (parsed.t3code_threads) Object.freeze(parsed.t3code_threads);
  if (parsed.requirements) Object.freeze(parsed.requirements);
  Object.freeze(parsed);
}

function parseTaskFrontmatterUncached(content: string): ParsedTaskFrontmatter {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const fmBlock = fmMatch[1]!;

  let data: unknown;
  try {
    data = YAML.parse(fmBlock, { uniqueKeys: false });
  } catch {
    return parseTaskFrontmatterLineFallback(fmBlock);
  }
  if (typeof data !== "object" || data == null) {
    return parseTaskFrontmatterLineFallback(fmBlock);
  }

  const d = data as Record<string, unknown>;
  const deps = (d.dependencies as Record<string, unknown>) ?? {};
  return {
    id: String(d.id ?? ""),
    title: String(d.title ?? ""),
    project: String(d.project ?? ""),
    status: String(d.status ?? "ready"),
    priority: String(d.priority ?? "B"),
    deadline: d.deadline ? String(d.deadline) : null,
    dependencies: {
      blocks: Array.isArray(deps.blocks) ? (deps.blocks as string[]) : [],
      blocked_by: Array.isArray(deps.blocked_by) ? (deps.blocked_by as string[]) : [],
      relates_to: Array.isArray(deps.relates_to) ? (deps.relates_to as string[]) : [],
      subtask_of: deps.subtask_of ? String(deps.subtask_of) : null,
    },
    effort: String(d.effort ?? "medium"),
    skip_plan: asBoolean(d.skip_plan),
    requirements: d.requirements ? d.requirements as { os?: string; gpu?: string } : undefined,
    context: String(d.context ?? ""),
    uses_browser: asBoolean(d.uses_browser),
    slot: d.slot ? String(d.slot) : null,
    adapter: d.adapter ? String(d.adapter) : null,
    created: String(d.created ?? ""),
    started: d.started ? String(d.started) : null,
    completed: d.completed ? String(d.completed) : null,
    modified: d.modified ? String(d.modified) : null,
    source: String(d.source ?? ""),
    url: d.url ? String(d.url) : undefined,
    github_issue: d.github_issue ? Number(d.github_issue) : undefined,
    github_title: d.github_title ? String(d.github_title) : undefined,
    github_repo: d.github_repo ? String(d.github_repo) : undefined,
    github_labels: d.github_labels ? String(d.github_labels) : undefined,
    github_state: d.github_state ? String(d.github_state) : undefined,
    github_state_reason: d.github_state !== undefined && d.github_state_reason === null
      ? null
      : (d.github_state_reason ? String(d.github_state_reason) : undefined),
    github_updated_at: d.github_updated_at !== undefined && d.github_updated_at === null
      ? null
      : (d.github_updated_at ? String(d.github_updated_at) : undefined),
    github_closed_at: d.github_closed_at !== undefined && d.github_closed_at === null
      ? null
      : (d.github_closed_at ? String(d.github_closed_at) : undefined),
    milestone: d.milestone ? String(d.milestone) : undefined,
    elaborated: d.elaborated ? String(d.elaborated) : undefined,
    merged_into: d.merged_into ? String(d.merged_into) : undefined,
    merged_from: Array.isArray(d.merged_from) ? (d.merged_from as string[]) : undefined,
    t3code_threads: Array.isArray(d.t3code_threads) ? (d.t3code_threads as string[]) : undefined,
    proposal: normalizeOptionalString(d.proposal),
    deferred_launch: normalizeOptionalString(d.deferred_launch),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value);
  if (!s || s.toLowerCase() === "null") return undefined;
  return s;
}

/**
 * Malformed-YAML fallback: parse individual `field: value` lines from the
 * frontmatter block with a line regex. Populates only the string-shaped fields
 * we can recognize — arrays / nested blocks stay undefined. Mirrors the
 * null-literal and surrounding-quote handling of the old readFrontmatterField
 * line fallback (task-485dcb6a round 2).
 */
function parseTaskFrontmatterLineFallback(fmBlock: string): ParsedTaskFrontmatter {
  const out: Record<string, string> = {};
  const lineRe = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/gm;
  for (const m of fmBlock.matchAll(lineRe)) {
    const key = m[1]!;
    const raw = m[2]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (!raw || raw.toLowerCase() === "null") continue;
    out[key] = raw;
  }
  const fm: ParsedTaskFrontmatter = {};
  if (out.id !== undefined) fm.id = out.id;
  if (out.title !== undefined) fm.title = out.title;
  if (out.project !== undefined) fm.project = out.project;
  if (out.status !== undefined) fm.status = out.status;
  if (out.priority !== undefined) fm.priority = out.priority;
  if (out.effort !== undefined) fm.effort = out.effort;
  if (out.context !== undefined) fm.context = out.context;
  if (out.created !== undefined) fm.created = out.created;
  if (out.source !== undefined) fm.source = out.source;
  if (out.proposal !== undefined) fm.proposal = out.proposal;
  if (out.deferred_launch !== undefined) fm.deferred_launch = out.deferred_launch;
  if (out.url !== undefined) fm.url = out.url;
  if (out.slot !== undefined) fm.slot = out.slot;
  if (out.adapter !== undefined) fm.adapter = out.adapter;
  if (out.milestone !== undefined) fm.milestone = out.milestone;
  if (out.elaborated !== undefined) fm.elaborated = out.elaborated;
  if (out.merged_into !== undefined) fm.merged_into = out.merged_into;
  if (out.skip_plan !== undefined) fm.skip_plan = asBoolean(out.skip_plan);
  if (out.uses_browser !== undefined) fm.uses_browser = asBoolean(out.uses_browser);
  if (out.started !== undefined) fm.started = out.started;
  if (out.completed !== undefined) fm.completed = out.completed;
  if (out.modified !== undefined) fm.modified = out.modified;
  if (out.deadline !== undefined) fm.deadline = out.deadline;
  return fm;
}

/** Return line indices of the opening and closing `---` delimiters.
 *  Returns null if no valid frontmatter block is found. */
export function frontmatterBounds(lines: string[]): { openLine: number; closeLine: number } | null {
  if (lines.length < 2 || lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return { openLine: 0, closeLine: i };
  }
  return null;
}

export function updateFrontmatterField(filePath: string, field: string, value: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const bounds = frontmatterBounds(lines);
  if (!bounds) return;

  let done = false;
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i > bounds.openLine && i < bounds.closeLine && !done && lines[i]!.startsWith(`${field}:`)) {
      output.push(`${field}: ${value}`);
      done = true;
      continue;
    }
    output.push(lines[i]!);
  }

  if (!done) {
    // Upsert: insert before the frontmatter closing ---
    output.splice(bounds.closeLine, 0, `${field}: ${value}`);
  }

  atomicWriteFileSync(filePath, output.join("\n"));
}

export function addFrontmatterField(filePath: string, field: string, value: string): void {
  updateFrontmatterField(filePath, field, value);
}

/**
 * Atomically transition a task's status field.
 * Returns true if the transition succeeded, false if the current status
 * did not match any of the expectedFrom values (transition skipped).
 * Throws if the file does not exist.
 */
export function transitionStatus(
  filePath: string,
  expectedFrom: string | string[],
  to: string,
): boolean {
  if (!existsSync(filePath)) throw new Error(`task file not found: ${filePath}`);
  const content = readFileSync(filePath, "utf-8");
  const current = parseTaskFrontmatter(content).status ?? "ready";
  const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
  if (!allowed.includes(current)) {
    return false;
  }
  updateFrontmatterField(filePath, "status", to);
  return true;
}

/** Append a line to a markdown section (## heading). Handles "None." replacement, dedup, and missing sections. */
export function appendToSection(filePath: string, section: string, line: string): void {
  if (!existsSync(filePath)) return;
  let content = readFileSync(filePath, "utf-8");
  const header = `## ${section}`;

  // Dedupe: don't append if exact line already present
  if (content.includes(line)) return;

  if (content.includes(header)) {
    // Replace "None." placeholder if present
    const nonePattern = new RegExp(`(${header}\\s*\\n\\s*)None\\.`);
    if (nonePattern.test(content)) {
      content = content.replace(nonePattern, `$1${line}`);
    } else {
      // Append after existing section content, before next ## header or EOF
      const headerIdx = content.indexOf(header);
      const afterHeader = headerIdx + header.length;
      const nextHeaderMatch = content.slice(afterHeader).match(/\n## /);
      const insertIdx = nextHeaderMatch
        ? afterHeader + nextHeaderMatch.index!
        : content.length;
      const before = content.slice(0, insertIdx).trimEnd();
      const after = content.slice(insertIdx);
      content = before + "\n" + line + "\n" + after;
    }
  } else {
    // Create section at end of document
    content = content.trimEnd() + `\n\n${header}\n\n${line}\n`;
  }

  atomicWriteFileSync(filePath, content);
}

export function removeFrontmatterField(filePath: string, field: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const bounds = frontmatterBounds(lines);
  if (!bounds) { atomicWriteFileSync(filePath, content); return; }

  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i > bounds.openLine && i < bounds.closeLine && lines[i]!.startsWith(`${field}:`)) {
      // Skip this line and any indented continuation lines (block YAML values)
      while (i + 1 < bounds.closeLine && /^\s+/.test(lines[i + 1]!)) {
        i++;
      }
      continue;
    }
    output.push(lines[i]!);
  }

  atomicWriteFileSync(filePath, output.join("\n"));
}

/**
 * Update an array subfield within the dependencies block of a task file.
 * Handles both existing and missing subfields (inserts after last dependency line).
 */
export function updateDependencyArray(filePath: string, subfield: string, values: string[]): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const bounds = frontmatterBounds(lines);
  if (!bounds) return;

  let inDeps = false;
  let found = false;
  let lastDepsLineIdx = -1;
  const output: string[] = [];
  const formatted = `  ${subfield}: [${values.join(", ")}]`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === bounds.closeLine) {
      // If we never found the subfield, insert it before closing ---
      if (!found && lastDepsLineIdx >= 0) {
        output.splice(lastDepsLineIdx + 1, 0, formatted);
      }
      output.push(line);
      continue;
    }
    if (i > bounds.openLine && i < bounds.closeLine) {
      if (line.startsWith("dependencies:")) {
        inDeps = true;
        lastDepsLineIdx = output.length;
        output.push(line);
        continue;
      }
      if (inDeps && line.match(/^\s{2}\w/)) {
        lastDepsLineIdx = output.length;
        if (line.trimStart().startsWith(`${subfield}:`)) {
          output.push(formatted);
          found = true;
          continue;
        }
      } else if (inDeps && !line.match(/^\s/)) {
        inDeps = false;
      }
    }
    output.push(line);
  }

  atomicWriteFileSync(filePath, output.join("\n"));
}

export function writeTaskFile(
  dir: string,
  id: string,
  title: string,
  source: string,
  usesBrowser: boolean,
  repo: string,
  url: string,
  labels: string,
  today: string,
): boolean {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);

  // Skip if file already exists (don't overwrite user edits)
  if (existsSync(file)) {
    console.error(`ludics: skipping existing: ${id}`);
    return false;
  }

  // Infer priority from labels. Never produces D — D is reachable only via
  // explicit demote/postpone on an existing C-priority task.
  let priority = "B";
  if (/urgent|critical|high|priority/i.test(labels)) {
    priority = "A";
  } else if (/low|minor|nice-to-have/i.test(labels)) {
    priority = "C";
  }

  const project = repo ? repo.split("/").pop()! : "";

  let content = `---
id: ${id}
title: "${title}"
project: ${project}
status: ready
priority: ${priority}
deadline: null
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
  subtask_of: null
effort: medium
context: ${project}
uses_browser: ${usesBrowser}
slot: null
adapter: null
created: ${today}
started: null
completed: null
modified: null
source: ${source}
`;

  if (url) content += `url: ${url}\n`;
  if (source === "github") {
    const m = id.match(/gh-[^-]+-(\d+)$/);
    if (m) content += `github_issue: ${m[1]}\n`;
  }

  content += `---

# ${title}

## Context

${url ? `Source: ${url}\n` : ""}${labels ? `Labels: ${labels}\n` : ""}
## Acceptance Criteria

- [ ] TBD

## Notes

`;

  atomicWriteFileSync(file, content);
  console.error(`ludics: created: ${id}`);
  return true;
}
