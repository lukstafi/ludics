// Sessions module — pipeline orchestration and CLI handlers

import { join } from "path";
import { loadConfig, harnessDir, slotsFilePath } from "../config.ts";
import { extractSlotPaths } from "../slots/paths.ts";
import { discoverCodex } from "./discover-codex.ts";
import { discoverClaudeCode } from "./discover-claude.ts";
import { discoverTmux } from "./discover-tmux.ts";
import { discoverTtyd } from "./discover-ttyd.ts";
import { enrichWithPeerSync } from "./enrich.ts";
import { deduplicateAndMerge } from "./dedup.ts";
import { classifySessions } from "./classify.ts";
import { writeReport, printSummary, printDetailedSummary, printJson } from "./report.ts";
import type { DiscoveredSession, DiscoveryResult, MergedSession } from "../types.ts";
import { emitEvent } from "../events.ts";

async function discoverAll(staleThreshold: number): Promise<DiscoveredSession[]> {
  // Run all scanners concurrently
  const [codex, claude, tmux, ttyd] = await Promise.all([
    discoverCodex(staleThreshold),
    discoverClaudeCode(staleThreshold),
    discoverTmux(),
    discoverTtyd(),
  ]);

  return [...codex, ...claude, ...tmux, ...ttyd];
}

async function runPipeline(): Promise<DiscoveryResult> {
  const config = await loadConfig();
  const harness = await harnessDir();
  const slotsFile = slotsFilePath(harness);

  // Step 1: Discover from all sources
  const raw = await discoverAll(config.staleThresholdSeconds);

  // Step 2: Enrich with .peer-sync orchestration data
  const orchestrations = await enrichWithPeerSync(raw);

  // Step 3: Deduplicate and merge
  const merged = deduplicateAndMerge(raw, orchestrations, config.staleThresholdSeconds);

  // Step 4: Classify against slot paths
  const slotPaths = await extractSlotPaths(slotsFile);
  const { classified, unclassified } = classifySessions(merged, slotPaths);

  // Step 5: Build result
  const staleHours = config.staleThresholdSeconds / 3600;

  // Count sources
  const sources: Record<string, number> = {};
  for (const s of raw) {
    sources[s.agentType] = (sources[s.agentType] ?? 0) + 1;
  }

  emitEvent({ event_type: "session_discovery", source: "keepalive", scope: "session", message: `discovered ${raw.length} sessions, classified ${classified.length}, unclassified ${unclassified.length}` });

  return {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    staleAfterHours: staleHours,
    sources,
    slots: slotPaths,
    classified,
    unclassified,
  };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printSessionDetail(session: MergedSession): void {
  console.log(`  cwd: ${session.cwd}`);
  console.log(`  agents: ${session.agents.join(", ")}`);
  console.log(`  ids: ${session.ids.join(", ")}`);
  console.log(`  last activity: ${session.lastActivity}`);
  console.log(`  stale: ${session.stale}`);
  if (session.slot !== null) {
    console.log(`  slot: ${session.slot} (path: ${session.slotPath})`);
  }
  if (session.orchestration) {
    const o = session.orchestration;
    console.log(`  orchestration: ${o.type} feature=${o.feature} phase=${o.phase} round=${o.round}`);
  }
  for (const src of session.sources) {
    if (src.meta.git_branch) console.log(`  git branch: ${src.meta.git_branch}`);
    if (src.meta.summary) console.log(`  summary: ${src.meta.summary}`);
  }
}

export async function runSessions(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  const jsonMode = hasFlag(args, "--json");

  switch (sub) {
    case "report": {
      const result = await runPipeline();
      const harness = await harnessDir();
      const reportPath = join(harness, "sessions.md");
      writeReport(reportPath, result);
      if (jsonMode) {
        printJson(result);
      } else {
        printSummary(result);
        console.error(`ludics: sessions report written to ${reportPath}`);
        const jsonPath = reportPath.replace(/\.md$/, ".json");
        console.error(`ludics: sessions JSON written to ${jsonPath}`);
        console.log(reportPath);
      }
      break;
    }

    case "refresh": {
      // Re-run discovery and write report (same as "report")
      const result = await runPipeline();
      const harness = await harnessDir();
      const reportPath = join(harness, "sessions.md");
      writeReport(reportPath, result);
      if (jsonMode) {
        printJson(result);
      } else {
        printSummary(result);
        console.error(`ludics: sessions refreshed`);
      }
      break;
    }

    case "show": {
      // Show detailed info for all sessions (or filter by cwd/id)
      const result = await runPipeline();
      const filter = args[1] && !args[1].startsWith("--") ? args[1] : null;
      const allSessions = [...result.classified, ...result.unclassified];

      if (jsonMode) {
        printJson(result);
        break;
      }

      const filtered = filter
        ? allSessions.filter(
            (s) =>
              s.cwd.includes(filter) ||
              s.cwdNormalized.includes(filter) ||
              s.ids.some((id) => id.includes(filter)),
          )
        : allSessions;

      if (filtered.length === 0) {
        console.log(filter ? `No sessions matching "${filter}"` : "No active sessions");
        break;
      }

      for (const session of filtered) {
        const slotLabel = session.slot !== null ? ` [Slot ${session.slot}]` : " [unclassified]";
        console.log(`${session.agents[0]}${slotLabel} — ${session.cwd}`);
        printSessionDetail(session);
        console.log("");
      }
      break;
    }

    case "": {
      // Quick discovery and summary to stdout
      const result = await runPipeline();
      if (jsonMode) {
        printJson(result);
      } else {
        printDetailedSummary(result);
      }
      break;
    }

    case "--json": {
      // `sessions --json` (--json is first arg)
      const result = await runPipeline();
      printJson(result);
      break;
    }

    default:
      throw new Error(
        `unknown sessions subcommand: ${sub} (use: report, refresh, show [filter], or omit for summary; add --json for JSON output)`,
      );
  }
}
