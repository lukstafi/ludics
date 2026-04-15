// Task frontmatter parsing and writing

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { TaskFrontmatter } from "./types.ts";

/** Regex for valid task IDs — used across all task-related endpoints. */
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;

export const PRIORITY_INCREASE: Record<string, string> = { C: "B", B: "A", A: "S" };
export const PRIORITY_DECREASE: Record<string, string> = { S: "A", A: "B", B: "C" };

/** Numeric sort key for priority levels. S < A < B < C < anything else. */
export function priorityValue(p: string): number {
  switch (p) {
    case "S": return 0;
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
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

export function parseTaskFrontmatter(content: string): Partial<TaskFrontmatter> & { id: string; title: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error("no frontmatter found");

  const data = YAML.parse(fmMatch[1]!, { uniqueKeys: false }) as Record<string, unknown>;
  const deps = (data.dependencies as Record<string, unknown>) ?? {};
  return {
    id: String(data.id ?? ""),
    title: String(data.title ?? ""),
    project: String(data.project ?? ""),
    status: String(data.status ?? "ready"),
    priority: String(data.priority ?? "B"),
    deadline: data.deadline ? String(data.deadline) : null,
    dependencies: {
      blocks: Array.isArray(deps.blocks) ? (deps.blocks as string[]) : [],
      blocked_by: Array.isArray(deps.blocked_by) ? (deps.blocked_by as string[]) : [],
      relates_to: Array.isArray(deps.relates_to) ? (deps.relates_to as string[]) : [],
      subtask_of: deps.subtask_of ? String(deps.subtask_of) : null,
    },
    effort: String(data.effort ?? "medium"),
    requirements: data.requirements ? data.requirements as { os?: string; gpu?: string } : undefined,
    context: String(data.context ?? ""),
    uses_browser: asBoolean(data.uses_browser),
    slot: data.slot ? String(data.slot) : null,
    adapter: data.adapter ? String(data.adapter) : null,
    created: String(data.created ?? ""),
    started: data.started ? String(data.started) : null,
    completed: data.completed ? String(data.completed) : null,
    modified: data.modified ? String(data.modified) : null,
    source: String(data.source ?? ""),
    url: data.url ? String(data.url) : undefined,
    github_issue: data.github_issue ? Number(data.github_issue) : undefined,
    github_title: data.github_title ? String(data.github_title) : undefined,
    github_repo: data.github_repo ? String(data.github_repo) : undefined,
    github_labels: data.github_labels ? String(data.github_labels) : undefined,
    github_state: data.github_state ? String(data.github_state) : undefined,
    github_state_reason: data.github_state !== undefined && data.github_state_reason === null
      ? null
      : (data.github_state_reason ? String(data.github_state_reason) : undefined),
    github_updated_at: data.github_updated_at !== undefined && data.github_updated_at === null
      ? null
      : (data.github_updated_at ? String(data.github_updated_at) : undefined),
    github_closed_at: data.github_closed_at !== undefined && data.github_closed_at === null
      ? null
      : (data.github_closed_at ? String(data.github_closed_at) : undefined),
    milestone: data.milestone ? String(data.milestone) : undefined,
    elaborated: data.elaborated ? String(data.elaborated) : undefined,
    merged_into: data.merged_into ? String(data.merged_into) : undefined,
    merged_from: Array.isArray(data.merged_from) ? (data.merged_from as string[]) : undefined,
    t3code_threads: Array.isArray(data.t3code_threads) ? (data.t3code_threads as string[]) : undefined,
  };
}

export function readFrontmatterField(content: string, field: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  let data: unknown;
  try {
    data = YAML.parse(fmMatch[1]!, { uniqueKeys: false });
  } catch {
    return null;
  }
  if (typeof data !== "object" || data == null) return null;

  const value = (data as Record<string, unknown>)[field];
  if (value == null) return null;
  const str = String(value);
  if (!str || str.toLowerCase() === "null") return null;
  return str;
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

  writeFileSync(filePath, output.join("\n"));
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
  const statusMatch = content.match(/^status:\s*(.+)$/m);
  const current = statusMatch ? statusMatch[1]!.trim() : "ready";
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

  writeFileSync(filePath, content);
}

export function removeFrontmatterField(filePath: string, field: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const bounds = frontmatterBounds(lines);
  if (!bounds) { writeFileSync(filePath, content); return; }

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

  writeFileSync(filePath, output.join("\n"));
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

  writeFileSync(filePath, output.join("\n"));
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

  // Infer priority from labels
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

  writeFileSync(file, content);
  console.error(`ludics: created: ${id}`);
  return true;
}
