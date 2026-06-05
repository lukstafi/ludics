import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  OUTBOUND_EVENT_CAUSE_REMEDY,
  latestOutboundCauseRemedy,
} from "./staging-event-meta.ts";

function tmpEvents(lines: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "staging-event-meta-"));
  const file = join(dir, "events.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("OUTBOUND_EVENT_CAUSE_REMEDY", () => {
  test("workflow-scope entry names the gh auth refresh remedy", () => {
    const meta = OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!;
    expect(meta.cause).toContain("workflow");
    expect(meta.remedy).toBe("gh auth refresh -h github.com -s workflow");
  });

  test("credentials entry names the credential-refresh remedy", () => {
    const meta = OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_credentials_missing!;
    expect(meta.cause).toContain("credentials");
    expect(meta.remedy.toLowerCase()).toContain("credentials");
  });
});

describe("latestOutboundCauseRemedy", () => {
  test("returns workflow-scope cause/remedy for a structured-project event", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 100, message: "x" },
    ]);
    const got = latestOutboundCauseRemedy(file, "ocannl");
    expect(got).toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!);
  });

  test("returns credentials cause/remedy for a structured-project event", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_credentials_missing", project: "ocannl", epoch: 100, message: "x" },
    ]);
    const got = latestOutboundCauseRemedy(file, "ocannl");
    expect(got).toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_credentials_missing!);
  });

  test("ordering: newest epoch wins when both classes are present", () => {
    // Credentials event is older; workflow-scope is newer → workflow-scope wins.
    const file = tmpEvents([
      { event_type: "staging_outbound_credentials_missing", project: "ocannl", epoch: 100, message: "x" },
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 200, message: "x" },
    ]);
    const got = latestOutboundCauseRemedy(file, "ocannl");
    expect(got).toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!);

    // Reverse the epochs → credentials (now newest) wins. This is the
    // assertion that fails if the reader returns first-match instead of the
    // newest-epoch match.
    const file2 = tmpEvents([
      { event_type: "staging_outbound_credentials_missing", project: "ocannl", epoch: 300, message: "x" },
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 200, message: "x" },
    ]);
    const got2 = latestOutboundCauseRemedy(file2, "ocannl");
    expect(got2).toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_credentials_missing!);
  });

  test("project filter: an event for another project does not match", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_workflow_scope_missing", project: "other-proj", epoch: 100, message: "other-proj: x" },
    ]);
    expect(latestOutboundCauseRemedy(file, "ocannl")).toBeNull();
  });

  test("legacy fallback: matches via `${project}:` message prefix when structured project absent", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_credentials_missing", epoch: 100, message: "ocannl: outbound push failed (credentials)" },
    ]);
    const got = latestOutboundCauseRemedy(file, "ocannl");
    expect(got).toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_credentials_missing!);
  });

  test("sinceEpoch: events older than the boundary are ignored (Codex PR #557 P2)", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 100, message: "ocannl: x" },
    ]);
    // Boundary above the event → dropped.
    expect(latestOutboundCauseRemedy(file, "ocannl", { sinceEpoch: 200 })).toBeNull();
    // Boundary at/below the event → kept.
    expect(latestOutboundCauseRemedy(file, "ocannl", { sinceEpoch: 100 }))
      .toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!);
    expect(latestOutboundCauseRemedy(file, "ocannl", { sinceEpoch: 50 }))
      .toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!);
  });

  test("sinceEpoch: a newer matching event wins even when an older one predates the boundary", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_credentials_missing", project: "ocannl", epoch: 100, message: "ocannl: old" },
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 300, message: "ocannl: new" },
    ]);
    // Boundary 200 drops the credentials event but keeps the workflow one.
    expect(latestOutboundCauseRemedy(file, "ocannl", { sinceEpoch: 200 }))
      .toEqual(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!);
  });

  test("control: no matching event → null", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 100, message: "ocannl: pushed" },
      { event_type: "some_other_event", project: "ocannl", epoch: 200, message: "ocannl: noise" },
    ]);
    expect(latestOutboundCauseRemedy(file, "ocannl")).toBeNull();
  });

  test("missing file → null (best-effort, never throws)", () => {
    expect(latestOutboundCauseRemedy(join(tmpdir(), "does-not-exist-xyz", "events.jsonl"), "ocannl")).toBeNull();
  });
});
