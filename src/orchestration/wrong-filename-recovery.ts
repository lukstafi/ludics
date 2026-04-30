// Defense-in-depth recovery for wrong-filename phase artifacts.
//
// When the artifact gate fires for `plan` / `plan-merge` / `plan-review` /
// `review` and the agent's canonical artifact is missing, this module:
//   1. Auto-cp's a small whitelisted set of safe alternatives onto the
//      canonical path (currently `plan-merge` only).
//   2. Failing that, sends a targeted nudge naming the canonical path and
//      listing recently-modified candidate files from `plans/` ∪ `reviews/`.
//
// The async driver (`recoverWrongFilename`) is called from runner.ts; the
// pure suppression predicate (`recoveryRecentlyActed`) is read by
// `phases.ts:validateDoneStatus` to suppress its 10s warning when a nudge
// already fired this (round, planMergeRound) tuple.

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "fs";
import { basename, dirname, join } from "path";
import { emitEvent } from "../events.ts";
import { mergedPlanFilePath, parsePlanFilename } from "./plan-files.ts";
import { reviewFilePath } from "./review-files.ts";
import type {
  AgentConfig,
  AgentRuntimeState,
  OrchestrationState,
} from "./state.ts";
import type { OrchestrationTransport } from "./transport.ts";
import { isoNow } from "./util.ts";
import type { Phase } from "./phases.ts";

/** Phases that participate in wrong-filename recovery. Outside this set the
 *  driver is a no-op so git-artifact phases (work, pr-create, merge-execute)
 *  and `merge-amend` (no canonical) keep their existing fall-through. */
export function isRecoveryEligiblePhase(phase: Phase): boolean {
  return phase === "plan-merge" || phase === "plan"
    || phase === "plan-review" || phase === "review";
}

/** Build the canonical artifact path for the current phase. Mirrors
 *  `phases.requiredArtifactPath` for the eligible phases only — kept local
 *  to avoid a circular import with phases.ts. */
function canonicalPath(state: OrchestrationState, agent: AgentConfig): string | null {
  const dir = state.peerSyncDir;
  switch (state.phase) {
    case "plan":
      return join(dir, "plans", `round-${state.round}-${agent.name}.md`);
    case "plan-merge":
      return mergedPlanFilePath(dir, state.round, state.planMergeRound ?? 0);
    case "plan-review":
      return reviewFilePath(dir, "plan-review", state.planMergeRound ?? 0, agent.name);
    case "review":
      return reviewFilePath(dir, "review", state.round, agent.name);
    default:
      return null;
  }
}

/** Return absolute paths of files that, when found in-phase, are safe to
 *  auto-cp onto the canonical path. The whitelist is intentionally narrow
 *  and grows by code edit only. v1: plan-merge only. */
export function whitelistSuspects(state: OrchestrationState, _agent: AgentConfig): string[] {
  if (state.phase !== "plan-merge") return [];

  const plansDir = join(state.peerSyncDir, "plans");
  const round = state.round;
  const k = state.planMergeRound ?? 0;
  const canonical = mergedPlanFilePath(state.peerSyncDir, round, k);
  const out: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return out;
  }

  for (const f of entries) {
    const full = join(plansDir, f);
    if (full === canonical) continue;
    const parsed = parsePlanFilename(f);
    if (!parsed) continue;
    if (parsed.type === "plan" && parsed.round === round) {
      // Covers `round-R-coder.md` clobber, `round-R-merge.md`,
      // `round-R-merged.md` — PLAN_RE's `[\w-]+` accepts those literals
      // as agent names, so the parse-based rule subsumes the singular-name
      // fallthrough described in the proposal text.
      out.push(full);
      continue;
    }
    if (parsed.type === "merged"
        && parsed.round === round
        && parsed.planMergeRound !== undefined
        && parsed.planMergeRound !== k) {
      // off-by-one (K-1) and skip-counter (K+1)
      out.push(full);
    }
  }

  return out;
}

/** Scan plans/ ∪ reviews/ for `.md` files modified at or after phaseStartedAt,
 *  excluding the canonical. Returns up to 5 entries, sorted by mtime
 *  descending. Missing directories are treated as empty. */
export function scanRecentlyModified(
  peerSyncDir: string,
  phaseStartedAt: number,
  excludePath: string,
): { path: string; mtime: number }[] {
  const candidates: { path: string; mtime: number }[] = [];
  for (const sub of ["plans", "reviews"]) {
    const subDir = join(peerSyncDir, sub);
    let entries: string[];
    try {
      entries = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      const full = join(subDir, f);
      if (full === excludePath) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const mtimeSec = Math.floor(st.mtimeMs / 1000);
      if (mtimeSec < phaseStartedAt) continue;
      candidates.push({ path: full, mtime: mtimeSec });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.slice(0, 5);
}

/** `cp -p` semantics: copy contents and preserve source mtime/atime.
 *  Atomic via `.tmp` + rename. Returns false on any IO error (caller falls
 *  through to nudge-or-warning). */
export function attemptAutoCp(suspectPath: string, canonicalPath: string): boolean {
  try {
    mkdirSync(dirname(canonicalPath), { recursive: true });
    const tmp = `${canonicalPath}.tmp.${process.pid}.${Date.now()}`;
    copyFileSync(suspectPath, tmp);
    renameSync(tmp, canonicalPath);
    const srcStat = statSync(suspectPath);
    utimesSync(canonicalPath, srcStat.atime, srcStat.mtime);
    return true;
  } catch {
    // Best-effort cleanup of the .tmp file on failure (rare path).
    try {
      const stale = `${canonicalPath}.tmp.${process.pid}`;
      if (existsSync(stale)) unlinkSync(stale);
    } catch { /* swallow */ }
    return false;
  }
}

export type RecoveryOutcome = "cp" | "nudge" | "deferred" | "diagnostic-only" | "none";

function formatHmsUtc(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function buildNudgeBody(state: OrchestrationState, canonical: string, candidates: { path: string; mtime: number }[]): string {
  const lines: string[] = [];
  lines.push(`The canonical artifact for the ${state.phase} phase was not produced.`);
  lines.push("");
  lines.push(`Expected path: ${canonical}`);
  lines.push("Recently-modified candidates (did you mean to write here?):");
  for (const c of candidates) {
    lines.push(`  - ${c.path}  (mtime ${formatHmsUtc(c.mtime)} UTC)`);
  }
  lines.push("");
  lines.push(`Please ensure your output is written to the canonical path exactly: ${canonical}`);
  return lines.join("\n");
}

/** Suppression predicate read by `phases.ts:validateDoneStatus`.
 *
 *  Note: `validateDoneStatus` is reached only when (a) `runtime.turnLifecycle`
 *  is undefined (legacy / resume) or (b) `lc.state === "settled"` —
 *  `isAgentDone` short-circuits non-settled lifecycle states earlier. So
 *  this predicate intentionally does NOT branch on `lc.state`; it asks only
 *  "did a wrong-filename nudge already fire for this (round,
 *  planMergeRound) tuple in the settled path?" When yes, suppress the
 *  10s warning so we don't double-log. */
export function recoveryRecentlyActed(
  state: OrchestrationState,
  _agent: AgentConfig,
  runtime: AgentRuntimeState,
): boolean {
  const lc = runtime.turnLifecycle;
  if (!lc) return false;
  return lc.wrongFilenameNudgeRound === state.round
    && (lc.wrongFilenameNudgePlanMergeRound ?? null) === (state.planMergeRound ?? -1);
}

/** Driver: auto-cp → nudge → diagnostic-only → none.
 *  Called from runner.ts each poll cycle for each participating done-status
 *  agent. */
export async function recoverWrongFilename(
  state: OrchestrationState,
  agent: AgentConfig,
  runtime: AgentRuntimeState,
  transport: OrchestrationTransport,
): Promise<RecoveryOutcome> {
  if (!isRecoveryEligiblePhase(state.phase)) return "none";
  const canonical = canonicalPath(state, agent);
  if (!canonical) return "none";
  if (existsSync(canonical)) return "none";

  // --- Auto-cp branch ---
  if (state.config.autoRecoverWrongFilename) {
    const suspects = whitelistSuspects(state, agent);
    let best: { path: string; mtime: number } | null = null;
    for (const sp of suspects) {
      let st;
      try {
        st = statSync(sp);
      } catch {
        continue;
      }
      const mtimeSec = Math.floor(st.mtimeMs / 1000);
      // Strict `>` (not `>=`): mtime and phaseStartedAt are both floored to
      // seconds, so a file written in the same wall-clock second as the
      // phase transition is ambiguous between "last write of previous
      // phase" and "first write of new phase". Auto-cp is destructive
      // (overwrites the canonical), so we exclude that boundary second.
      // The proposal text's `>=` is preserved for the informational nudge
      // scan via `scanRecentlyModified`.
      if (mtimeSec <= state.phaseStartedAt) continue;
      if (!best || mtimeSec > best.mtime) {
        best = { path: sp, mtime: mtimeSec };
      }
    }
    if (best) {
      if (attemptAutoCp(best.path, canonical)) {
        emitEvent({
          event_type: "orchestration_artifact_recovered",
          source: "orchestration",
          scope: "slot",
          slot: state.slot,
          task: state.taskId,
          agent: agent.name,
          phase: state.phase,
          round: state.round,
          planMergeRound: state.planMergeRound,
          suspectPath: best.path,
          canonicalPath: canonical,
          message: `${agent.name}: auto-cp'd ${basename(best.path)} → ${basename(canonical)} (phase=${state.phase} round=${state.round})`,
        });
        return "cp";
      }
      // Fall through to the nudge branch on copy failure.
    }
  }

  // --- Nudge dedup ---
  const lc = runtime.turnLifecycle;
  // No-lifecycle bail-out: when `runtime.turnLifecycle` is null (legacy /
  // resume / setup paths), we have nowhere to persist the nudge sentinel
  // — sending the nudge would re-fire on every poll forever, AND
  // `recoveryRecentlyActed` would still return false so the existing
  // 10s warning would also keep spamming. Skip the nudge branch
  // entirely; auto-cp above already handled the recoverable case, and
  // `validateDoneStatus`'s existing warning matches today's behaviour
  // for legacy state. Once the runner re-dispatches the agent and
  // installs a turnLifecycle, the full recovery path engages.
  if (!lc) return "none";
  if (lc.wrongFilenameNudgeRound === state.round
      && (lc.wrongFilenameNudgePlanMergeRound ?? null) === (state.planMergeRound ?? -1)) {
    return "none";
  }

  // --- TUI gating (proposal-aligned) ---
  // - dispatched | starting | running → defer
  // - error → diagnostic-only (no nudge)
  // - settled → proceed
  {
    if (lc.state === "dispatched" || lc.state === "starting" || lc.state === "running") {
      return "deferred";
    }
    if (lc.state === "error") {
      emitEvent({
        event_type: "orchestration_artifact_recovery_skipped",
        source: "orchestration",
        scope: "slot",
        slot: state.slot,
        task: state.taskId,
        agent: agent.name,
        phase: state.phase,
        round: state.round,
        planMergeRound: state.planMergeRound,
        reason: "lifecycle-error",
        message: `${agent.name}: skipping wrong-filename nudge (lifecycle.state=error)`,
      });
      return "diagnostic-only";
    }
  }

  // --- Recently-modified scan ---
  const candidates = scanRecentlyModified(state.peerSyncDir, state.phaseStartedAt, canonical);
  if (candidates.length === 0) return "none";

  // --- Send nudge ---
  const body = buildNudgeBody(state, canonical, candidates);
  try {
    await transport.sendTurn(state, agent, body);
    // `lc` is guaranteed non-null here by the no-lifecycle bail-out above.
    lc.nudgeAttempts = (lc.nudgeAttempts ?? 0) + 1;
    lc.lastNudgeAt = isoNow();
    lc.wrongFilenameNudgeRound = state.round;
    lc.wrongFilenameNudgePlanMergeRound = state.planMergeRound ?? -1;
    emitEvent({
      event_type: "orchestration_wrong_filename_nudge",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      agent: agent.name,
      phase: state.phase,
      round: state.round,
      planMergeRound: state.planMergeRound,
      candidatePaths: candidates.map((c) => c.path),
      canonicalPath: canonical,
      message: `${agent.name}: wrong-filename nudge sent (canonical missing, ${candidates.length} candidates)`,
    });
    return "nudge";
  } catch (err) {
    emitEvent({
      event_type: "orchestration_nudge_failed",
      source: "orchestration",
      scope: "slot",
      slot: state.slot,
      task: state.taskId,
      agent: agent.name,
      phase: state.phase,
      message: `${agent.name}: wrong-filename nudge dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    // Do NOT bump counters or sentinels — next poll retries.
    return "none";
  }
}
