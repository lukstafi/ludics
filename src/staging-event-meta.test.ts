import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  OUTBOUND_EVENT_CAUSE_REMEDY,
  NO_ATTEMPTS_REMEDY,
  BLOCKED_WORKTREE_REMEDY,
  latestOutboundCauseRemedy,
  outboundActivitySince,
  classifyOutboundStaleness,
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

describe("outboundActivitySince", () => {
  test("returns true when a staging_outbound_* event for the project is in-window", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 500, message: "ocannl: pushed" },
    ]);
    expect(outboundActivitySince(file, "ocannl", 400)).toBe(true);
  });

  test("returns false when the only matching event predates sinceEpoch", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 100, message: "ocannl: pushed" },
    ]);
    expect(outboundActivitySince(file, "ocannl", 200)).toBe(false);
  });

  test("returns false for events belonging to a different project", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "other", epoch: 500, message: "other: pushed" },
    ]);
    expect(outboundActivitySince(file, "ocannl", 0)).toBe(false);
  });

  test("returns false for non-staging_outbound_ events", () => {
    const file = tmpEvents([
      { event_type: "some_other_event", project: "ocannl", epoch: 500, message: "ocannl: x" },
    ]);
    expect(outboundActivitySince(file, "ocannl", 0)).toBe(false);
  });

  test("returns false for missing file (best-effort)", () => {
    expect(outboundActivitySince(join(tmpdir(), "does-not-exist-xyz", "events.jsonl"), "ocannl", 0)).toBe(false);
  });

  test("matches events at exactly sinceEpoch boundary", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_error", project: "ocannl", epoch: 300, message: "ocannl: err" },
    ]);
    expect(outboundActivitySince(file, "ocannl", 300)).toBe(true);
    expect(outboundActivitySince(file, "ocannl", 301)).toBe(false);
  });
});

describe("classifyOutboundStaleness", () => {
  test("auth branch: workflow-scope failure in window → { kind: 'auth', cause, remedy }", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 500, message: "ocannl: x" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("auth");
    if (result.kind === "auth") {
      expect(result.cause).toBe(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!.cause);
      expect(result.remedy).toBe(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_workflow_scope_missing!.remedy);
    }
  });

  test("auth branch: credentials failure in window → { kind: 'auth', cause, remedy }", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_credentials_missing", project: "ocannl", epoch: 500, message: "ocannl: x" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("auth");
    if (result.kind === "auth") {
      expect(result.cause).toBe(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_credentials_missing!.cause);
      expect(result.remedy).toBe(OUTBOUND_EVENT_CAUSE_REMEDY.staging_outbound_credentials_missing!.remedy);
    }
  });

  test("boundary: obsolete pre-sinceEpoch auth failure does NOT produce auth", () => {
    // Auth event exists but predates the sentinel boundary — must be dropped.
    const file = tmpEvents([
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 100, message: "ocannl: x" },
    ]);
    // sinceEpoch 200 > epoch 100 → event is obsolete
    const result = classifyOutboundStaleness(file, "ocannl", 200);
    expect(result.kind).not.toBe("auth");
  });

  test("no-attempts branch: empty/missing events file → { kind: 'no-attempts', remedy }", () => {
    const file = tmpEvents([]);
    const result = classifyOutboundStaleness(file, "ocannl", 0);
    expect(result.kind).toBe("no-attempts");
    if (result.kind === "no-attempts") {
      expect(result.remedy).toBe(NO_ATTEMPTS_REMEDY);
    }
  });

  test("no-attempts branch: only pre-sinceEpoch activity → { kind: 'no-attempts' }", () => {
    // Tick ran before the sentinel, but nothing since — downtime diagnosis.
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 100, message: "ocannl: pushed" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 200);
    expect(result.kind).toBe("no-attempts");
  });

  test("unknown branch: non-auth outbound activity in window → { kind: 'unknown' }", () => {
    // Tick ran (non-auth outcome like fast_forward or error) — conservative, no annotation.
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 500, message: "ocannl: pushed" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("unknown");
  });

  test("unknown branch: staging_outbound_local_behind in window → { kind: 'unknown' }", () => {
    const file = tmpEvents([
      { event_type: "staging_outbound_local_behind", project: "ocannl", epoch: 500, message: "ocannl: behind" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("unknown");
  });

  test("missing file with positive sinceEpoch → no-attempts (never throws)", () => {
    const result = classifyOutboundStaleness(
      join(tmpdir(), "does-not-exist-xyz", "events.jsonl"),
      "ocannl",
      1000,
    );
    expect(result.kind).toBe("no-attempts");
  });

  test("blocked-worktree: dirty-skip-only window → { kind: 'blocked-worktree', remedy }", () => {
    // Only in-window activity is the dirty-skip event → tick ran, worktree blocked.
    const file = tmpEvents([
      { event_type: "staging_outbound_skipped_dirty", project: "ocannl", epoch: 500, message: "ocannl: outbound skipped — /path worktree dirty" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("blocked-worktree");
    if (result.kind === "blocked-worktree") {
      expect(result.remedy).toBe(BLOCKED_WORKTREE_REMEDY);
      // Invariant: remedy must name the blocked ~/<repo> checkout so the
      // operator knows what to clear. Fails if the placeholder is dropped.
      expect(result.remedy).toContain("~/<repo>");
    }
  });

  test("blocked-worktree: prior success AT sinceEpoch boundary + dirty-skip after → blocked-worktree (sentinel-epoch excluded)", () => {
    // Real-world case: last tick succeeded at epoch 400 and touched the sentinel
    // (sinceEpoch = 400). After that the worktree became dirty, so ticks at 401+
    // all emitted dirty-skip events. The success event at epoch === sinceEpoch must
    // NOT count as "real post-sentinel activity" — only events strictly after the
    // boundary are in scope for the dirty-only check.
    const file = tmpEvents([
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 400, message: "ocannl: pushed" },
      { event_type: "staging_outbound_skipped_dirty", project: "ocannl", epoch: 401, message: "ocannl: skipped" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    // Without the > fix (old >=), the fast_forwarded event at epoch 400 is kept,
    // isExclusivelyDirtySkipActivity returns false, result is "unknown".
    expect(result.kind).toBe("blocked-worktree");
  });

  test("blocked-worktree: dirty-skip + real activity (fast-forward) after sentinel → unknown (negative control)", () => {
    // Real push activity AFTER sinceEpoch alongside dirty-skip: not exclusively dirty-skip → unknown.
    const file = tmpEvents([
      { event_type: "staging_outbound_skipped_dirty", project: "ocannl", epoch: 500, message: "ocannl: skipped" },
      { event_type: "staging_outbound_fast_forwarded", project: "ocannl", epoch: 510, message: "ocannl: pushed" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("unknown");
    expect(result.kind).not.toBe("blocked-worktree");
  });

  test("blocked-worktree: zero events → no-attempts (negative control)", () => {
    // No activity at all → controller downtime, not dirty worktree.
    const file = tmpEvents([]);
    const result = classifyOutboundStaleness(file, "ocannl", 0);
    expect(result.kind).toBe("no-attempts");
    expect(result.kind).not.toBe("blocked-worktree");
  });

  test("blocked-worktree: dirty-skip + in-window auth failure → auth (auth takes precedence)", () => {
    // Auth failure co-present with dirty-skip event: auth must win over blocked-worktree.
    const file = tmpEvents([
      { event_type: "staging_outbound_skipped_dirty", project: "ocannl", epoch: 500, message: "ocannl: skipped" },
      { event_type: "staging_outbound_workflow_scope_missing", project: "ocannl", epoch: 510, message: "ocannl: x" },
    ]);
    const result = classifyOutboundStaleness(file, "ocannl", 400);
    expect(result.kind).toBe("auth");
    expect(result.kind).not.toBe("blocked-worktree");
  });
});
