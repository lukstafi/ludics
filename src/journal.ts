// Journal functions — append events to journal/YYYY-MM-DD.md

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { harnessDir } from "./config.ts";
import { emitEvent } from "./events.ts";

function journalDir(): string {
  return join(harnessDir(), "journal");
}

function todayStr(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function journalFile(): string {
  return join(journalDir(), `${todayStr()}.md`);
}

export function journalAppend(category: string, message: string): void {
  const dir = journalDir();
  mkdirSync(dir, { recursive: true });

  const file = journalFile();
  if (!existsSync(file)) {
    writeFileSync(file, `# Journal ${todayStr()}\n\n`);
  }

  const time = new Date().toTimeString().slice(0, 8);
  appendFileSync(file, `- **${time}** [${category}] ${message}\n`);

  // Also emit structured event as generic fallback
  emitEvent({ event_type: "journal", source: "cli", scope: category, message });
}

export function journalRecent(count: number = 20): void {
  const file = journalFile();
  if (!existsSync(file)) {
    console.log("No journal entries for today");
    return;
  }

  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("- **"));
  const recent = lines.slice(-count);
  for (const line of recent) {
    console.log(line);
  }
}

export function journalList(days: number = 7): void {
  const dir = journalDir();
  if (!existsSync(dir)) {
    console.log("No journal directory");
    return;
  }

  const cutoff = Date.now() - days * 86400 * 1000;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).mtimeMs >= cutoff)
    .sort()
    .reverse();

  for (const f of files) {
    console.log(f);
  }
}
