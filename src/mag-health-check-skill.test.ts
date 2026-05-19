// task-a670cdbf — health-check skill content regression.
// The skill (skills/ludics-health-check.md) must surface the new
// hung-agent layer's events. This test treats the skill as an
// executable spec (per feedback_skill_md_executable_spec): if the
// content drops the journal-grep pattern, the documented check path
// is silently broken and nobody catches it until production.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SKILL_PATH = join(import.meta.dir, "..", "skills", "ludics-health-check.md");

describe("ludics-health-check skill content (task-a670cdbf)", () => {
  const body = readFileSync(SKILL_PATH, "utf-8");

  test("references the renamed settled-no-signal lifecycle field", () => {
    // The renamed layer's field name must be present so the skill
    // continues to flag t3code stalls. Pre-rename, the only reference
    // was `turnLifecycle.stallDetectedAt` — that is the legacy literal
    // and must be gone.
    expect(body).toContain("settledNoSignalDetectedAt");
    expect(body).toContain("settledNoSignalNudgeAttempts");
    // No legacy reference survives outside of explanatory cross-reference text.
    // Body matches must be in sentinel positions only — accept "renamed
    // from `stallDetectedAt`" as legacy-narration but not as an active
    // field-read instruction. The field-read instruction was previously:
    //   "Check each agent's `turnLifecycle.stallDetectedAt`"
    // Asserting it's gone catches a regression where a future edit
    // accidentally re-introduces it.
    expect(body).not.toMatch(/Check each agent's `turnLifecycle\.stallDetectedAt`/);
  });

  test("documents agent_hung_detected and agent_hung_force_settle journal scan", () => {
    // The hung-agent layer is event-driven (tmux-only). If the skill
    // doesn't grep for these event types, tmux hung incidents are
    // invisible to operators.
    expect(body).toContain('"event_type":"agent_hung_detected"');
    expect(body).toContain('"event_type":"agent_hung_force_settle"');
  });

  test("uses a defined baseline variable, not the broken EVENTS_BASELINE_LINE typo", () => {
    // Reviewer round-2 caught: the skill referenced `$EVENTS_BASELINE_LINE`
    // which was never defined elsewhere. The fix uses
    // `PREV_EVENTS_LINES` derived from health-last.json (or the
    // already-defined `EVENTS_LINES` fallback).
    expect(body).not.toContain("$EVENTS_BASELINE_LINE");
    expect(body).not.toContain("EVENTS_BASELINE_LINE");
    // The corrected baseline derivation (PREV_EVENTS_LINES + health-last.json)
    // must be present for the tail-grep instruction to be coherent.
    expect(body).toContain("PREV_EVENTS_LINES");
    expect(body).toContain("health-last.json");
  });

  test("issues a stable issue key for hung incidents", () => {
    // Per AC: "Build stable issue key" + "Severity ladder". Without a
    // stable key, delta tracking against health-last.json silently
    // duplicates ongoing hung incidents on every health tick.
    expect(body).toContain("slot-hung:");
  });

  test("severity ladder ties warning to agent_hung_detected and critical to agent_hung_force_settle (AC: 'as a warning')", () => {
    // The AC literal is "Health-check skill surfaces agent_hung_detected
    // events as a warning." A skill that mentions both event types but
    // doesn't *associate* the warning level with first-detect would
    // pass a weaker presence test. Here we lock the association
    // structurally: the severity sentence in the hung block must
    // co-locate "warning" with `agent_hung_detected` and "critical"
    // with `agent_hung_force_settle`. Mutation-test: swapping the
    // levels in the skill markdown breaks this assertion.
    //
    // Implementation: extract a window around the hung-events grep
    // pattern and assert both severity associations live inside it.
    const hungSection = (() => {
      const lines = body.split("\n");
      let start = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/Hung-agent layer.*event-driven/.test(lines[i]!)) {
          start = i;
          break;
        }
      }
      if (start === -1) throw new Error("hung-agent skill section not found");
      // Take up to 60 following lines (or until the next top-level numbered step).
      const slice: string[] = [];
      for (let i = start; i < Math.min(lines.length, start + 60); i++) {
        if (i > start && /^\d+\.\s/.test(lines[i]!)) break;
        slice.push(lines[i]!);
      }
      return slice.join("\n");
    })();

    // First-detect → warning. The literal "warning" must appear paired
    // with `agent_hung_detected` in the severity sentence.
    expect(/warning\s+on\s+`agent_hung_detected`/.test(hungSection)).toBe(true);
    // Escalation → critical paired with `agent_hung_force_settle`.
    expect(/critical\s+on\s+`agent_hung_force_settle`/.test(hungSection)).toBe(true);
  });
});

// gh-ludics-540: outbound staging-ff sentinel staleness skill content.
// The skill markdown is the executable spec — if a future edit drops
// the stable key, the threshold, the sentinel filename, or the
// no-notification clause, the documented surface gets out of sync with
// what `runStagingOutboundPushTick` and the health check actually do.
describe("ludics-health-check skill content (gh-ludics-540)", () => {
  const body = readFileSync(SKILL_PATH, "utf-8");

  test("references the outbound staging-ff sentinel filename verbatim", () => {
    // Invariant: the skill names the same sentinel file that
    // src/staging-ff.ts:outboundSentinelFile() writes and
    // src/briefing-lag.ts:outboundSentinelStaleNote() reads. Drift here
    // means the operator runs the documented check against a missing
    // file path and silently sees no findings.
    expect(body).toContain("last-outbound-fast-forward-");
  });

  test("documents the 48h warning / 72h critical thresholds", () => {
    // Mutation-test: bumping either threshold in code without updating
    // the skill drops one of these literals.
    expect(body).toContain("48h");
    expect(body).toContain("72h");
  });

  test("includes the stable issue key outbound-staging-ff-stale:<project>", () => {
    // Stable issue keys are how findings dedupe across ticks (see
    // health-last.json delta tracking). Without the literal in the
    // skill, two ticks would file the same finding as `new` each time.
    expect(body).toContain("outbound-staging-ff-stale:<project>");
  });

  test("documents the no-notification rule for outbound auth failures", () => {
    // AC 9: "no `ludics notify outgoing` call from the push function
    // or its caller". The skill must state this explicitly so future
    // editors don't add a notify call to "improve" the UX.
    expect(body).toMatch(/does NOT raise.*ludics notify outgoing|ludics notify outgoing.*not|No notification/i);
  });

  test("opt-in gate: skill scopes the check to projects with outbound_sync_enabled: true", () => {
    // Without this guard, the skill would file `outbound-staging-ff-stale`
    // for every upstream-aware project — but only opt-in projects ever
    // write the sentinel, so non-opt-in projects would erroneously be
    // flagged as critical (missing sentinel).
    expect(body).toContain("outbound_sync_enabled");
  });
});
