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
    if (meta.tmux_session) {
      lines.push(`- **tmux session:** ${meta.tmux_session}`);
    }
    if (meta.git_branch) {
      lines.push(`- **Git branch:** ${meta.git_branch}`);
    }
    if (meta.summary) {
      lines.push(`- **Summary:** ${meta.summary}`);
    }
  }

  // Show orchestration context
  if (session.orchestration) {
    const o = session.orchestration;
    lines.push(
      `- **Orchestration:** ${o.type} (feature: ${o.feature || "?"}, phase: ${o.phase || "?"}, round: ${o.round || "?"})`,
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
    if (src.meta.tmux_session && !meta.tmux_session) meta.tmux_session = src.meta.tmux_session;
    if (src.meta.git_branch && !meta.git_branch) meta.git_branch = src.meta.git_branch;
    if (src.meta.summary && !meta.summary) meta.summary = src.meta.summary;
    if (src.meta.message_count && !meta.message_count) meta.message_count = src.meta.message_count;
    if (src.meta.port && !meta.port) meta.port = src.meta.port;
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
