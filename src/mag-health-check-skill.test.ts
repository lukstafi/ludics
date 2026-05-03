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
});
