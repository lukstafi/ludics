// task-a670cdbf — structural regression for docs/orchestration-stall-detection.md.
// AC: "vocabulary (settled vs hung), two subsystems, signals, recovery
// progressions, escalation graph, threshold config." Each must be a
// resolvable heading (so cross-doc anchors work) AND must mention the
// required concept by name (so a future heading rename that drops the
// concept content surfaces here).
//
// Per feedback_md_anchors_only_for_headings: GitHub generates anchors
// only for #/##/### headings. The structural assertion is that each
// required section anchor exists; deleting any one of them breaks
// cross-doc links from orchestration-patterns.md and breaks the AC.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const DOC_PATH = join(import.meta.dir, "..", "docs", "orchestration-stall-detection.md");

function headingsOf(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of body.split("\n")) {
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]! });
  }
  return out;
}

describe("docs/orchestration-stall-detection.md structural ACs (task-a670cdbf)", () => {
  const body = readFileSync(DOC_PATH, "utf-8");
  const headings = headingsOf(body);
  const headingTexts = headings.map((h) => h.text.toLowerCase());

  test("# H1 title is the stall-detection doc title", () => {
    expect(headings[0]?.level).toBe(1);
    expect(headings[0]?.text.toLowerCase()).toContain("stall detection");
  });

  test("Vocabulary section: settled vs hung definitions present at heading level", () => {
    // AC clause: "vocabulary (settled vs hung)"
    const hasVocabulary = headingTexts.some((t) => t.includes("vocabulary"));
    expect(hasVocabulary).toBe(true);
    // Body must define both terms — a heading without content fails the AC.
    expect(/[Ss]ettled\b/.test(body)).toBe(true);
    expect(/[Hh]ung\b/.test(body)).toBe(true);
    // Defining property: "ready to process the next prompt" / "alive but not
    // ready" — the proposal's load-bearing phrasing.
    expect(body).toContain("ready to process the next prompt");
    // Defining property of *hung*: agent is not ready for the next prompt.
    // The doc emphasises with ** so accept both bold and plain.
    expect(/not[* ]+ready/i.test(body)).toBe(true);
  });

  test("Two subsystems section with both layer headings present", () => {
    // AC clause: "two subsystems".
    const hasTwoSubsystems = headingTexts.some(
      (t) => t.includes("two subsystem") || t.includes("subsystems"),
    );
    expect(hasTwoSubsystems).toBe(true);
    const hasSettledLayerHeading = headingTexts.some(
      (t) => t.includes("settled-no-signal"),
    );
    const hasHungLayerHeading = headingTexts.some(
      (t) => t.includes("hung-agent") || t.includes("substantive-diff"),
    );
    expect(hasSettledLayerHeading).toBe(true);
    expect(hasHungLayerHeading).toBe(true);
  });

  test("Signals: each layer documents its detection signal", () => {
    // AC clause: "signals". The two-subsystems area must name the
    // detection signal for each layer — pane-static for settled-no-signal
    // and substantive-diff for hung. The proposal's load-bearing
    // distinguisher between layers.
    expect(body).toContain("static");          // settled-no-signal trigger
    expect(body).toContain("substantiveDiff"); // hung trigger
  });

  test("Recovery progressions: both layers' recovery ladders present", () => {
    // AC clause: "recovery progressions". Each layer's ladder must be
    // documented; a doc that drops one leaves operators without a
    // recovery reference.
    expect(body).toContain("breakAndPrompt"); // hung recovery
    expect(body).toContain("interruptAgent"); // shared force-settle escalation
    expect(body).toContain('"Continue."');   // settled-no-signal soft nudge
    expect(body).toContain("Enter");          // settled-no-signal soft nudge
  });

  test("Escalation graph: cooldown + max-attempts + force-settle path is named", () => {
    // AC clause: "escalation graph". The doc must describe the second
    // detection escalating to force-settle; otherwise an operator
    // doesn't know where the recovery loop terminates.
    expect(body).toMatch(/(cooldown|nudgeCooldownSeconds)/i);
    expect(body).toMatch(/(force-settle|interruptAgent)/);
    // Both layers' attempt ceilings:
    expect(body).toContain("maxNudgeAttempts");
  });

  test("Threshold config section + table with all five substantive-stall keys", () => {
    // AC clause: "threshold config". The Threshold table is the
    // operator-facing knob inventory; missing rows would silently
    // ship undocumented knobs.
    const hasThresholdHeading = headingTexts.some(
      (t) => t.includes("threshold"),
    );
    expect(hasThresholdHeading).toBe(true);
    for (const k of [
      "thresholdSeconds",
      "minChars",
      "minPct",
      "nudgeCooldownSeconds",
      "maxNudgeAttempts",
    ]) {
      expect(body).toContain(k);
    }
  });

  test("Configuration section ties YAML key path to runtime config", () => {
    // AC clause part of "threshold config" — the doc must name the
    // YAML key path so a config.yaml editor can find the knob.
    expect(body).toContain("mag.orchestration.substantive_stall");
  });

  test("Incident-capture format documented (matches AC `Incident capture`)", () => {
    // Glue AC: "Incident capture: persist … under mag/hung-incidents/…"
    // The doc must show the path shape and the required payload fields
    // so auditors can verify capture format without reading code.
    expect(body).toContain("mag/hung-incidents/");
    for (const k of [
      "detectedAt", "stallSeconds", "diffCharsAccumulated",
      "paneSnapshot", "promptSent",
    ]) {
      expect(body).toContain(k);
    }
  });

  test("orchestration-patterns.md cross-reference target is reachable from this doc", () => {
    // Per glue AC: a one-line cross-reference in
    // orchestration-patterns.md points HERE; the corresponding back-link
    // in this doc closes the loop and keeps the pair from drifting.
    expect(body).toContain("orchestration-patterns.md");
  });
});
