// Tasks CLI handlers

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { extname, join } from "path";
import { harnessDir } from "../config.ts";
import { parseTaskFrontmatter, updateFrontmatterField, addFrontmatterField } from "./markdown.ts";
import { tasksSync, tasksConvert, tasksUpdate, tasksNeedsElaborationList, tasksQueueElaborations, contentFingerprint } from "./sync.ts";
import { emitEvent } from "../events.ts";

function tasksDir(): string {
  return join(harnessDir(), "tasks");
}

function tasksYamlPath(): string {
  return join(harnessDir(), "tasks.yaml");
}

function tasksList(): void {
  const dir = tasksDir();
  if (!existsSync(dir)) {
    throw new Error(`tasks directory not found: ${dir} (run: ludics tasks sync)`);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), "utf-8");
      const fm = parseTaskFrontmatter(content);
      console.log(`${fm.id} - ${fm.title}`);
    } catch {
      // skip malformed files
    }
  }
}

function tasksShow(taskId: string): void {
  // Task .md files are the source of truth
  const mdFile = join(tasksDir(), `${taskId}.md`);
  if (existsSync(mdFile)) {
    console.log(readFileSync(mdFile, "utf-8"));
    return;
  }

  // Fall back to tasks.yaml index for tasks not yet converted to .md
  const file = tasksYamlPath();
  if (existsSync(file)) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    let inBlock = false;
    const output: string[] = [];

    for (const line of lines) {
      const idMatch = line.match(/^\s*-\s*id:\s*(.+)$/);
      if (idMatch) {
        const current = idMatch[1]!.replace(/"/g, "");
        if (inBlock && current !== taskId) break;
        inBlock = current === taskId;
      }
      if (inBlock) output.push(line);
    }

    if (output.length > 0) {
      console.log(output.join("\n"));
      return;
    }
  }

  throw new Error(`task not found: ${taskId}`);
}

function tasksCreate(
  title: string,
  project: string = "personal",
  priority: string = "B",
  usesBrowser: boolean = false,
): void {
  const dir = tasksDir();
  mkdirSync(dir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const id = `task-${contentFingerprint(title)}`;
  const file = join(dir, `${id}.md`);

  if (existsSync(file)) {
    console.log(`Task already exists: ${file}`);
    console.log(`ID: ${id}`);
    return;
  }

  const content = `---
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
---

# ${title}

## Context

Created manually via ludics.

## Acceptance Criteria

- [ ] TBD

## Notes

`;

  writeFileSync(file, content, { flag: "wx" });
  emitEvent({ event_type: "task_created", source: "cli", scope: "task", task: id, message: title });
  console.log(`Created task: ${file}`);
  console.log(`ID: ${id}`);
}

function tasksFilesList(): void {
  const dir = tasksDir();
  if (!existsSync(dir)) {
    console.log("No task files yet (run: ludics tasks convert)");
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf-8");
    const fm = parseTaskFrontmatter(content);
    console.log(`${fm.id} (${fm.priority}) [${fm.status}] ${fm.title}`);
  }
}

function tasksSamples(): void {
  const dir = tasksDir();
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const samples = [
    {
      id: "task-001", title: "Implement user authentication", project: "sample-app",
      status: "ready", priority: "A", blocks: "[task-002, task-003]", blocked_by: "[]",
      effort: "large", context: "auth", extra: "",
    },
    {
      id: "task-002", title: "Add password reset flow", project: "sample-app",
      status: "ready", priority: "B", blocks: "[]", blocked_by: "[task-001]",
      effort: "medium", context: "auth", extra: "",
    },
    {
      id: "task-003", title: "Write API documentation", project: "sample-app",
      status: "ready", priority: "B", blocks: "[]", blocked_by: "[task-001]",
      effort: "medium", context: "docs", extra: `deadline: ${today}`,
    },
    {
      id: "task-004", title: "Refactor database layer", project: "sample-app",
      status: "in-progress", priority: "B", blocks: "[]", blocked_by: "[]",
      effort: "large", context: "backend", extra: `started: ${today}`,
    },
    {
      id: "task-005", title: "Add dark mode support", project: "sample-app",
      status: "ready", priority: "C", blocks: "[]", blocked_by: "[]",
      effort: "small", context: "ui", extra: "",
    },
  ];

  for (const s of samples) {
    const file = join(dir, `${s.id}.md`);
    const content = `---
id: ${s.id}
title: "${s.title}"
project: ${s.project}
status: ${s.status}
priority: ${s.priority}
${s.extra ? s.extra + "\n" : ""}deadline: null
dependencies:
  blocks: ${s.blocks}
  blocked_by: ${s.blocked_by}
  relates_to: []
  subtask_of: null
effort: ${s.effort}
context: ${s.context}
uses_browser: false
slot: null
adapter: null
created: ${today}
started: null
completed: null
modified: null
---

# ${s.title}

## Context

Sample task for testing ludics flow engine.

## Acceptance Criteria

- [ ] TBD

## Notes

`;
    writeFileSync(file, content);
  }

  console.log(`Created 5 sample task files in ${dir}`);
}

function tasksNeedsElaboration(): void {
  const dir = tasksDir();
  if (!existsSync(dir)) return;

  const ids = tasksNeedsElaborationList(dir);
  for (const id of ids) {
    console.log(id);
  }
}

function tasksCheckElaboration(taskId: string): void {
  const dir = tasksDir();
  const file = join(dir, `${taskId}.md`);
  if (!existsSync(file)) {
    throw new Error(`task file not found: ${file}`);
  }

  const content = readFileSync(file, "utf-8");
  if (!content.includes("\nelaborated:")) {
    console.log("needs-elaboration");
    return;
  }
  if (content.includes("- [ ] TBD\n")) {
    console.log("needs-elaboration");
    return;
  }
  console.log("elaborated");
}

function tasksMerge(targetId: string, sourceIds: string[]): void {
  const dir = tasksDir();
  const targetFile = join(dir, `${targetId}.md`);
  if (!existsSync(targetFile)) {
    throw new Error(`target task not found: ${targetId}`);
  }

  for (const srcId of sourceIds) {
    const srcFile = join(dir, `${srcId}.md`);
    if (!existsSync(srcFile)) throw new Error(`source task not found: ${srcId}`);
    if (srcId === targetId) throw new Error(`cannot merge a task into itself: ${srcId}`);
  }

  for (const srcId of sourceIds) {
    updateFrontmatterField(join(dir, `${srcId}.md`), "status", "merged");
    addFrontmatterField(join(dir, `${srcId}.md`), "merged_into", targetId);
    updateFrontmatterField(join(dir, `${srcId}.md`), "slot", "null");
    console.log(`Merged: ${srcId} -> ${targetId}`);
  }

  // Add merged_from to target
  const mergedList = `[${sourceIds.join(",")}]`;
  const targetContent = readFileSync(targetFile, "utf-8");
  if (targetContent.includes("\nmerged_from:")) {
    // Append to existing
    const existingMatch = targetContent.match(/^merged_from:\s*(.+)$/m);
    if (existingMatch) {
      const existing = existingMatch[1]!.replace(/^\[/, "").replace(/\]$/, "");
      const combined = existing ? `[${existing}, ${sourceIds.join(",")}]` : mergedList;
      updateFrontmatterField(targetFile, "merged_from", combined);
    }
  } else {
    addFrontmatterField(targetFile, "merged_from", mergedList);
  }

  emitEvent({ event_type: "task_merged", source: "cli", scope: "task", task: targetId, message: `merged ${sourceIds.join(", ")} into ${targetId}` });
  console.log(`\nMerged ${sourceIds.length} task(s) into ${targetId}`);
}

function tasksDuplicates(): void {
  const dir = tasksDir();
  if (!existsSync(dir)) {
    console.log("No task files yet");
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const groups = new Map<string, Array<{ id: string; title: string }>>();

  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf-8");
    const fm = parseTaskFrontmatter(content);
    if (["done", "abandoned", "merged"].includes(fm.status ?? "")) continue;
    if (!fm.title) continue;

    const fp = contentFingerprint(fm.title);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp)!.push({ id: fm.id, title: fm.title });
  }

  let found = false;
  let groupNum = 0;
  for (const [fp, entries] of groups) {
    if (entries.length < 2) continue;
    found = true;
    groupNum++;
    console.log(`Group ${groupNum} (fingerprint: ${fp}):`);
    for (const entry of entries) {
      console.log(`  ${entry.id}  "${entry.title}"`);
    }
    const first = entries[0]!.id;
    const others = entries.slice(1).map((e) => e.id).join(" ");
    console.log(`  -> ludics tasks merge ${first} ${others}`);
    console.log("");
  }

  if (!found) {
    console.log("No duplicate tasks found");
  }
}

interface TaskIdMigrationPlan {
  oldId: string;
  newId: string;
  oldFile: string;
  newFile: string;
  title: string;
}

function isLegacyManualTaskId(id: string): boolean {
  return /^task-\d+$/.test(id);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectReferenceFiles(rootDir: string): string[] {
  const out: string[] = [];
  const allowedExt = new Set([".md", ".markdown", ".yaml", ".yml", ".json", ".jsonl", ".txt"]);

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (allowedExt.has(extname(entry.name).toLowerCase())) {
        out.push(path);
      }
    }
  }

  walk(rootDir);
  return out.sort();
}

function replaceTaskIds(content: string, mappings: Array<[string, string]>): { content: string; replacements: number } {
  let updated = content;
  let replacements = 0;

  const sorted = mappings.slice().sort((a, b) => b[0].length - a[0].length);
  for (const [oldId, newId] of sorted) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(oldId)}(?![A-Za-z0-9_-])`, "g");
    const hits = updated.match(pattern)?.length ?? 0;
    if (hits === 0) continue;
    replacements += hits;
    updated = updated.replace(pattern, newId);
  }

  return { content: updated, replacements };
}

function tasksMigrateRefs(dryRun: boolean = false): void {
  const harness = harnessDir();
  const dir = tasksDir();
  if (!existsSync(dir)) {
    throw new Error(`tasks directory not found: ${dir} (run: ludics tasks sync)`);
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const candidates: TaskIdMigrationPlan[] = [];
  const conflicts: string[] = [];

  for (const f of files) {
    const filePath = join(dir, f);
    let content = "";
    let fm;
    try {
      content = readFileSync(filePath, "utf-8");
      fm = parseTaskFrontmatter(content);
    } catch {
      continue;
    }

    if (!isLegacyManualTaskId(fm.id)) continue;
    const title = fm.title.trim();
    if (!title) {
      conflicts.push(`${fm.id}: missing title; cannot derive deterministic ID`);
      continue;
    }

    const newId = `task-${contentFingerprint(title)}`;
    candidates.push({
      oldId: fm.id,
      newId,
      oldFile: filePath,
      newFile: join(dir, `${newId}.md`),
      title,
    });
  }

  if (candidates.length === 0) {
    console.log("No legacy task-<number> IDs found");
    return;
  }

  const byNewId = new Map<string, TaskIdMigrationPlan[]>();
  for (const c of candidates) {
    const group = byNewId.get(c.newId) ?? [];
    group.push(c);
    byNewId.set(c.newId, group);
  }

  const duplicateTargets = new Set<string>();
  for (const [newId, group] of byNewId.entries()) {
    if (group.length < 2) continue;
    duplicateTargets.add(newId);
    const ids = group.map((g) => g.oldId).join(", ");
    conflicts.push(`${newId}: multiple legacy tasks map to this ID (${ids})`);
  }

  const withoutDuplicateTargets = candidates.filter((c) => !duplicateTargets.has(c.newId));
  const oldFiles = new Set(withoutDuplicateTargets.map((c) => c.oldFile));
  const renames: TaskIdMigrationPlan[] = [];

  for (const c of withoutDuplicateTargets) {
    if (existsSync(c.newFile) && !oldFiles.has(c.newFile)) {
      conflicts.push(`${c.oldId} -> ${c.newId}: target file already exists (${c.newFile})`);
      continue;
    }
    renames.push(c);
  }

  console.log(
    `Found ${candidates.length} legacy task(s): ${renames.length} migratable, ${conflicts.length} conflict(s)`,
  );

  if (conflicts.length > 0) {
    console.log("");
    console.log("Conflicts:");
    for (const c of conflicts) {
      console.log(`- ${c}`);
    }
  }

  if (renames.length === 0) {
    return;
  }

  console.log("");
  console.log(dryRun ? "Planned migrations:" : "Applying migrations:");
  for (const r of renames) {
    console.log(`- ${r.oldId} -> ${r.newId}  "${r.title}"`);
  }

  if (dryRun) {
    console.log("");
    console.log("Dry run only; no files modified");
    return;
  }

  const updatedContentByOldFile = new Map<string, string>();
  for (const r of renames) {
    const content = readFileSync(r.oldFile, "utf-8");
    const updated = content.replace(/^id:\s*.+$/m, `id: ${r.newId}`);
    updatedContentByOldFile.set(r.oldFile, updated);
  }

  const tempByOldFile = new Map<string, string>();
  for (const r of renames) {
    const tempFile = `${r.oldFile}.migrate-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    renameSync(r.oldFile, tempFile);
    tempByOldFile.set(r.oldFile, tempFile);
  }

  for (const r of renames) {
    const tempFile = tempByOldFile.get(r.oldFile);
    if (!tempFile) continue;
    const updated = updatedContentByOldFile.get(r.oldFile);
    if (updated !== undefined) {
      writeFileSync(tempFile, updated);
    }
    renameSync(tempFile, r.newFile);
  }

  const mappings: Array<[string, string]> = renames.map((r) => [r.oldId, r.newId]);
  const refFiles = collectReferenceFiles(harness);
  let changedFiles = 0;
  let replacements = 0;

  for (const file of refFiles) {
    const content = readFileSync(file, "utf-8");
    const result = replaceTaskIds(content, mappings);
    if (result.replacements === 0) continue;
    writeFileSync(file, result.content);
    changedFiles++;
    replacements += result.replacements;
  }

  console.log("");
  console.log(`Migrated ${renames.length} task file(s)`);
  console.log(`Updated ${changedFiles} file(s) with ${replacements} ID replacement(s)`);
}

export async function runTasks(args: string[]): Promise<void> {
  const sub = args[0] ?? "";

  switch (sub) {
    case "sync":
      await tasksSync();
      break;
    case "list":
      tasksList();
      break;
    case "show": {
      const id = args[1];
      if (!id) throw new Error("task ID required");
      tasksShow(id);
      break;
    }
    case "convert":
      await tasksConvert();
      break;
    case "update":
      await tasksUpdate();
      break;
    case "create": {
      const title = args[1];
      if (!title) throw new Error("title required");
      let project: string | undefined;
      let priority: string | undefined;
      let usesBrowser = false;
      for (let i = 2; i < args.length; i++) {
        const a = args[i];
        if (a === "--uses-browser") {
          usesBrowser = true;
          continue;
        }
        if (!project) {
          project = a;
          continue;
        }
        if (!priority) {
          priority = a;
        }
      }
      tasksCreate(title, project, priority, usesBrowser);
      break;
    }
    case "files":
      tasksFilesList();
      break;
    case "samples":
      tasksSamples();
      break;
    case "needs-elaboration":
      tasksNeedsElaboration();
      break;
    case "queue-elaborations":
      tasksQueueElaborations();
      break;
    case "check": {
      const id = args[1];
      if (!id) throw new Error("task ID required");
      tasksCheckElaboration(id);
      break;
    }
    case "merge": {
      const target = args[1];
      if (!target) throw new Error("target task ID required");
      const sources = args.slice(2);
      if (sources.length === 0) throw new Error("at least one source task ID required");
      tasksMerge(target, sources);
      break;
    }
    case "duplicates":
      tasksDuplicates();
      break;
    case "migrate-refs": {
      let dryRun = false;
      for (const arg of args.slice(1)) {
        if (arg === "--dry-run") {
          dryRun = true;
          continue;
        }
        throw new Error(`unknown migrate-refs argument: ${arg} (use: --dry-run)`);
      }
      tasksMigrateRefs(dryRun);
      break;
    }
    default:
      throw new Error(
        `unknown tasks subcommand: ${sub} (use: sync, list, show, convert, update, create, files, samples, needs-elaboration, check, merge, duplicates, migrate-refs)`,
      );
  }
}
