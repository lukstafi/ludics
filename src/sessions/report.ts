// Sessions report generation — Markdown + JSON output

import { writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import type { MergedSession, DiscoveryResult } from "../types.ts";

function formatAge(epochSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const age = now - epochSeconds;
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return `${Math.floor(age / 86400)}d ago`;
}

function formatSessionMarkdown(session: MergedSession, classification: "classified" | "unclassified"): string {
  const lines: string[] = [];
  const primaryAgent = session.agents[0] ?? "unknown";

  lines.push(`### ${primaryAgent} — ${session.cwd}`);
  if (classification === "classified" && session.slot !== null) {
    lines.push(`- **Slot:** ${session.slot}`);
  }
  lines.push(`- **Session ID:** ${session.ids.join(", ")}`);
  lines.push(`- **Sources:** ${session.agents.join(", ")}`);

  const staleMarker = session.stale ? " (STALE)" : "";
  lines.push(`- **Last activity:** ${formatAge(session.lastActivityEpoch)}${staleMarker}`);

  // Extract useful fields from primary source meta
  for (const src of session.sources) {
    const meta = src.meta;
    if (meta.git_branch) {
      lines.push(`- **Git branch:** ${meta.git_branch}`);
    }
    if (meta.branch) {
      lines.push(`- **Branch:** ${meta.branch}`);
    }
    if (meta.summary) {
      lines.push(`- **Summary:** ${meta.summary}`);
    }
    if (meta.threadId) {
      lines.push(`- **Thread:** ${meta.threadId}`);
    }
    if (meta.model) {
      lines.push(`- **Model:** ${meta.model}`);
    }
    if (meta.sessionStatus) {
      lines.push(`- **Session status:** ${meta.sessionStatus}`);
    }
    if (meta.turnState) {
      lines.push(`- **Turn state:** ${meta.turnState}`);
    }
    if (meta.title) {
      lines.push(`- **Title:** ${meta.title}`);
    }
  }

  // Show orchestration context
  if (session.orchestration) {
    const o = session.orchestration;
    lines.push(
      `- **Orchestration:** ${o.type} (task: ${o.taskId || "?"}, phase: ${o.phase || "?"}, round: ${o.round || "?"})`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

export function generateMarkdownReport(result: DiscoveryResult): string {
  const lines: string[] = [];

  lines.push("# Discovered Sessions");
  lines.push("");
  lines.push(`Generated: ${result.generatedAt}`);
  lines.push("");

  if (result.classified.length > 0) {
    lines.push("## Classified Sessions");
    lines.push("");
    for (const session of result.classified) {
      lines.push(formatSessionMarkdown(session, "classified"));
    }
  }

  if (result.unclassified.length > 0) {
    lines.push("## Unclassified Sessions");
    lines.push("");
    lines.push("*These sessions could not be matched to any slot. Mag action needed.*");
    lines.push("");
    for (const session of result.unclassified) {
      lines.push(formatSessionMarkdown(session, "unclassified"));
    }
  }

  const totalClassified = result.classified.length;
  const totalUnclassified = result.unclassified.length;

  lines.push("---");
  lines.push("");
  lines.push(`**Summary:** ${totalClassified} classified, ${totalUnclassified} unclassified`);

  return lines.join("\n");
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

/** Extract useful metadata from sources without the full verbose array */
function extractMeta(sources: MergedSession["sources"]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const src of sources) {
    if (src.meta.git_branch && !meta.git_branch) meta.git_branch = src.meta.git_branch;
    if (src.meta.summary && !meta.summary) meta.summary = src.meta.summary;
    if (src.meta.message_count && !meta.message_count) meta.message_count = src.meta.message_count;
    // t3code fields
    if (src.meta.threadId && !meta.threadId) meta.threadId = src.meta.threadId;
    if (src.meta.projectId && !meta.projectId) meta.projectId = src.meta.projectId;
    if (src.meta.model && !meta.model) meta.model = src.meta.model;
    if (src.meta.sessionStatus && !meta.sessionStatus) meta.sessionStatus = src.meta.sessionStatus;
    if (src.meta.turnState && !meta.turnState) meta.turnState = src.meta.turnState;
    if (src.meta.branch && !meta.branch) meta.branch = src.meta.branch;
    if (src.meta.worktreePath && !meta.worktreePath) meta.worktreePath = src.meta.worktreePath;
    if (src.meta.title && !meta.title) meta.title = src.meta.title;
    if (src.meta.providerName && !meta.providerName) meta.providerName = src.meta.providerName;
  }
  return meta;
}

/** Serialize DiscoveryResult to JSON, replacing the `sources` array with extracted metadata */
function toJsonOutput(result: DiscoveryResult): string {
  const strip = (sessions: MergedSession[]) =>
    sessions.map(({ sources, ...rest }) => ({ ...rest, meta: extractMeta(sources) }));
  return JSON.stringify(
    {
      generatedAt: result.generatedAt,
      staleAfterHours: result.staleAfterHours,
      sources: result.sources,
      slots: result.slots,
      classified: strip(result.classified),
      unclassified: strip(result.unclassified),
    },
    null,
    2,
  );
}

export function writeReport(reportPath: string, result: DiscoveryResult): void {
  // Write Markdown report
  atomicWrite(reportPath, generateMarkdownReport(result));

  // Write JSON report alongside Markdown
  const jsonPath = reportPath.replace(/\.md$/, ".json");
  atomicWrite(jsonPath, toJsonOutput(result));
}

export function printJson(result: DiscoveryResult): void {
  console.log(toJsonOutput(result));
}

export function printSummary(result: DiscoveryResult): void {
  const allSessions = [...result.classified, ...result.unclassified];
  const total = allSessions.length;

  const counts: Record<string, number> = {};
  for (const s of allSessions) {
    for (const agent of s.agents) {
      counts[agent] = (counts[agent] ?? 0) + 1;
    }
  }

  const parts = Object.entries(counts)
    .map(([agent, count]) => `${count} ${agent}`)
    .join(", ");

  console.log(`Sessions: ${total} total (${parts || "none"})`);
  console.log(`Classified: ${result.classified.length} | Unclassified: ${result.unclassified.length}`);
}

export function printDetailedSummary(result: DiscoveryResult): void {
  printSummary(result);

  if (result.unclassified.length > 0) {
    console.log("");
    console.log("Unclassified sessions:");
    for (const s of result.unclassified) {
      const agent = s.agents[0] ?? "unknown";
      console.log(`  ${agent}: ${s.cwd} (${s.ids.join(", ")})`);
    }
  }

  if (result.classified.length > 0) {
    console.log("Classified sessions:");
    for (const s of result.classified) {
      const agent = s.agents[0] ?? "unknown";
      console.log(`  Slot ${s.slot}: ${agent} ${s.cwd} (${s.ids.join(", ")})`);
    }
  }
}
