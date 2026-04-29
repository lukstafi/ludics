// Lazy-loaded registry that maps queue action names to skill commands
// by scanning frontmatter in skills/*.md at first use.
//
// Skill templates declare queue behaviour with these frontmatter fields:
//
//   queue-action: <action>          # required — the action string dispatched from the queue
//   queue-args: [field1, field2]    # optional — request fields passed as positional args
//   queue-args-defaults:            # optional — default values for args not present in request
//     field2: defaultValue
//   queue-required-args: [field1]   # optional — args that cause null return when empty
//
// Usage:
//   import { resolveSkillCommand, hasRegisteredAction, clearSkillQueueCache } from "./skill-queue-registry.ts";

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { ludicsRoot } from "./config.ts";

/** Resolved mapping for a single queue action. */
interface SkillQueueEntry {
  /** Slash command name, e.g. "/ludics-elaborate" */
  command: string;
  /** Ordered list of request field names to pass as positional args */
  args: string[];
  /** Default values for optional args */
  defaults: Record<string, string>;
  /** Args that cause null return when their value is empty */
  requiredArgs: string[];
}

/** Module-level cache; null means "not yet loaded". */
let cache: Map<string, SkillQueueEntry> | null = null;

/** Clear the registry cache. Useful in tests and for process-lifetime resets. */
export function clearSkillQueueCache(): void {
  cache = null;
}

/** Return true if the action is registered in any skill frontmatter. */
export function hasRegisteredAction(action: string): boolean {
  if (!cache) cache = buildRegistry();
  return cache.has(action);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter block from a Markdown file, or return null. */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return YAML.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Scan skills directory and build action → entry map. */
function buildRegistry(): Map<string, SkillQueueEntry> {
  const registry = new Map<string, SkillQueueEntry>();
  const skillsDir = join(ludicsRoot(), "skills");

  if (!existsSync(skillsDir)) return registry;

  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return registry;
  }

  for (const file of files) {
    const filePath = join(skillsDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const action = fm["queue-action"];
    if (!action || typeof action !== "string") continue;

    // Name defaults to file basename without extension
    const name = typeof fm["name"] === "string" ? fm["name"] : file.replace(/\.md$/, "");

    // Ordered positional args
    const rawArgs = fm["queue-args"];
    const args: string[] = Array.isArray(rawArgs) ? rawArgs.map(String) : [];

    // Default values
    const defaults: Record<string, string> = {};
    const rawDefaults = fm["queue-args-defaults"];
    if (rawDefaults && typeof rawDefaults === "object" && !Array.isArray(rawDefaults)) {
      for (const [k, v] of Object.entries(rawDefaults as Record<string, unknown>)) {
        defaults[k] = String(v);
      }
    }

    // Required args (null return when missing)
    const rawRequired = fm["queue-required-args"];
    const requiredArgs: string[] = Array.isArray(rawRequired) ? rawRequired.map(String) : [];

    registry.set(action, { command: `/${name}`, args, defaults, requiredArgs });
  }

  return registry;
}

/** Resolve a single arg value: request field → default → empty string. */
function resolveArg(
  entry: SkillQueueEntry,
  request: Record<string, unknown>,
  argName: string,
): string {
  const raw = request[argName];
  if (raw !== undefined && raw !== null && raw !== "") {
    return String(raw);
  }
  return entry.defaults[argName] ?? "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a queue action string to a skill slash command with positional args.
 *
 * Returns `null` when:
 * - the action has no registered skill frontmatter, or
 * - a `queue-required-args` arg is missing from the request (and has no default).
 *
 * Optional trailing args whose value is empty are silently skipped so they are
 * not appended as empty strings.
 *
 * Multi-line arg values (e.g. `feedback`) are rendered on separate lines below
 * the slash command so the skill receives them as free-form trailing text via
 * `$ARGUMENTS`. Single-line args render inline.
 */
export function resolveSkillCommand(
  action: string,
  request: Record<string, unknown>,
): string | null {
  if (!cache) cache = buildRegistry();

  const entry = cache.get(action);
  if (!entry) return null;

  // Reject if any required arg is missing
  for (const argName of entry.requiredArgs) {
    if (!resolveArg(entry, request, argName)) return null;
  }

  if (entry.args.length === 0) {
    return entry.command;
  }

  const inline: string[] = [entry.command];
  const trailing: string[] = [];
  for (const argName of entry.args) {
    const value = resolveArg(entry, request, argName);
    if (!value) continue;
    if (trailing.length === 0 && !value.includes("\n")) {
      inline.push(value);
    } else {
      trailing.push(value);
    }
  }

  const head = inline.join(" ");
  return trailing.length === 0 ? head : `${head}\n${trailing.join("\n\n")}`;
}
