// Task frontmatter parsing and writing

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { TaskFrontmatter } from "./types.ts";

/** Regex for valid task IDs — used across all task-related endpoints. */
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;

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

  const data = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
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

export function updateFrontmatterField(filePath: string, field: string, value: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let inFrontmatter = false;
  let done = false;
  const output: string[] = [];

  for (const line of lines) {
    if (line === "---" && !inFrontmatter) {
      inFrontmatter = true;
      output.push(line);
      continue;
    }
    if (line === "---" && inFrontmatter) {
      inFrontmatter = false;
      output.push(line);
      continue;
    }
    if (inFrontmatter && !done && line.startsWith(`${field}:`)) {
      output.push(`${field}: ${value}`);
      done = true;
      continue;
    }
    output.push(line);
  }

  writeFileSync(filePath, output.join("\n"));
}

export function addFrontmatterField(filePath: string, field: string, value: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");

  // If field already exists, update instead
  if (content.includes(`\n${field}:`)) {
    updateFrontmatterField(filePath, field, value);
    return;
  }

  // Insert before closing ---
  const lines = content.split("\n");
  let count = 0;
  const output: string[] = [];
  for (const line of lines) {
    if (line === "---") count++;
    if (count === 2 && line === "---") {
      output.push(`${field}: ${value}`);
    }
    output.push(line);
  }

  writeFileSync(filePath, output.join("\n"));
}

export function removeFrontmatterField(filePath: string, field: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let inFrontmatter = false;
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---" && !inFrontmatter) {
      inFrontmatter = true;
      output.push(line);
      continue;
    }
    if (line === "---" && inFrontmatter) {
      inFrontmatter = false;
      output.push(line);
      continue;
    }
    if (inFrontmatter && line.startsWith(`${field}:`)) {
      // Skip this line and any indented continuation lines (block YAML values)
      while (i + 1 < lines.length && lines[i + 1] !== "---" && /^\s+/.test(lines[i + 1]!)) {
        i++;
      }
      continue;
    }
    output.push(line);
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
  let inFrontmatter = false;
  let inDeps = false;
  let found = false;
  let lastDepsLineIdx = -1;
  const output: string[] = [];
  const formatted = `  ${subfield}: [${values.join(", ")}]`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---" && !inFrontmatter) {
      inFrontmatter = true;
      output.push(line);
      continue;
    }
    if (line === "---" && inFrontmatter) {
      // If we never found the subfield, insert it before closing ---
      if (!found && lastDepsLineIdx >= 0) {
        output.splice(lastDepsLineIdx + 1, 0, formatted);
      }
      inFrontmatter = false;
      output.push(line);
      continue;
    }
    if (inFrontmatter) {
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
