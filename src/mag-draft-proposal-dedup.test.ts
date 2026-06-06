// Regression tests for task-0d1f8d76: dedup draft-proposal enqueues across the
// manual CLI handler and the keepalive auto-queue paths, including the in-flight
// (popped-but-unresolved) window.
//
// The shared invariant pinned here: a draft-proposal is enqueued at most once
// per task while a prior request is still pending in mag/queue.jsonl OR popped
// and unresolved (an mag/in-flight/<id>.json record exists with no matching
// mag/results/<id>.json). Both the manual handler and every keepalive enqueue
// site route through the single exported predicate
// draftProposalAlreadyPendingOrInFlight(), so they cannot drift apart.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function harnessDir(): string {
  return join(TMP, "harness");
}
function magDir(): string {
  return join(harnessDir(), "mag");
}
function queueFile(): string {
  return join(magDir(), "queue.jsonl");
}
function tasksDir(): string {
  return join(harnessDir(), "tasks");
}
function resultFile(id: string): string {
  return join(magDir(), "results", `${id}.json`);
}

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  // start_sessions: auto is required so the keepalive paths run (default is
  // manual, which early-returns before any enqueue).
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
mag:
  autonomy_level:
    start_sessions: auto
`);
  return configPath;
}

/** A ready, elaborated, no-questions, no-proposal candidate so the keepalive
 *  paths select it for a draft-proposal enqueue. */
function writeCandidateTask(id: string): void {
  writeFileSync(join(tasksDir(), `${id}.md`), `---
id: ${id}
title: "Candidate ${id}"
status: ready
priority: B
project: Ludics
leaf: true
elaborated: 2026-06-06
dependencies:
  blocks: []
  blocked_by: []
  relates_to: []
---

# Candidate ${id}

Body.
`);
}

function readQueueRequests(): Record<string, unknown>[] {
  if (!existsSync(queueFile())) return [];
  const content = readFileSync(queueFile(), "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function draftProposalRequestsFor(taskId: string): Record<string, unknown>[] {
  return readQueueRequests().filter(
    (r) => r.action === "draft-proposal" && String(r.task ?? "") === taskId,
  );
}

/** Seed a pending draft-proposal directly in the queue file. */
function seedQueueDraftProposal(taskId: string, id = "req-pending"): void {
  writeFileSync(queueFile(), JSON.stringify({ id, action: "draft-proposal", task: taskId }) + "\n");
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-dp-dedup-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(join(magDir(), "results"), { recursive: true });
  mkdirSync(join(harnessDir(), "journal"), { recursive: true });
  mkdirSync(tasksDir(), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

// --- Shared predicate (single source of truth) ---

describe("draftProposalAlreadyPendingOrInFlight", () => {
  test("queue arm: true when a pending draft-proposal for the task exists", async () => {
    const { draftProposalAlreadyPendingOrInFlight } = await import("./mag.ts");
    seedQueueDraftProposal("task-X");
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(true);
  });

  test("queue arm: false for a pending draft-proposal targeting a different task", async () => {
    const { draftProposalAlreadyPendingOrInFlight } = await import("./mag.ts");
    seedQueueDraftProposal("task-OTHER");
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(false);
  });

  test("in-flight arm: true when an unresolved record's line targets the task", async () => {
    const { draftProposalAlreadyPendingOrInFlight, writeInFlight } = await import("./mag.ts");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(true);
  });

  test("in-flight arm: false when record targets a different action on the same task", async () => {
    const { draftProposalAlreadyPendingOrInFlight, writeInFlight } = await import("./mag.ts");
    writeInFlight({
      requestId: "req-ELAB",
      command: "/ludics-elaborate",
      line: JSON.stringify({ id: "req-ELAB", action: "elaborate", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(false);
  });

  test("in-flight arm: false when record targets a different task", async () => {
    const { draftProposalAlreadyPendingOrInFlight, writeInFlight } = await import("./mag.ts");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-OTHER" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(false);
  });

  // AC-(d): resolved record (result JSON present) is NOT in-flight. This is the
  // mutation guard for listInFlightDeliveries() vs listInFlight(): swapping to
  // the unfiltered list would make this assertion fail (return true).
  test("in-flight arm: false when the record's result JSON has landed (resolved)", async () => {
    const { draftProposalAlreadyPendingOrInFlight, writeInFlight } = await import("./mag.ts");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });
    writeFileSync(resultFile("req-IF"), JSON.stringify({ status: "ok" }));
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(false);
  });

  test("false when neither a pending queue entry nor an in-flight record exists", async () => {
    const { draftProposalAlreadyPendingOrInFlight } = await import("./mag.ts");
    expect(draftProposalAlreadyPendingOrInFlight("task-X")).toBe(false);
  });
});

// --- AC (a): manual handler skip when already pending in queue ---

describe("manual handler — skip when already pending in queue (AC a)", () => {
  test("runMag draft-proposal does not append a second request and logs a skip naming the task", async () => {
    const { runMag } = await import("./mag.ts");
    seedQueueDraftProposal("task-X", "req-pending");
    const before = draftProposalRequestsFor("task-X");
    expect(before.length).toBe(1);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMag(["draft-proposal", "task-X"]);
      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Skipped draft-proposal request for task-X"))).toBe(true);
      expect(messages.some((m) => m.startsWith("Queued draft-proposal request"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }

    const after = draftProposalRequestsFor("task-X");
    expect(after.length).toBe(1); // unchanged — no second enqueue
  });
});

// --- AC (b): in-flight dedup from BOTH entry points ---

describe("in-flight dedup — manual handler (AC b)", () => {
  test("popped-but-unresolved record blocks a manual re-enqueue (queue empty)", async () => {
    const { runMag, writeInFlight } = await import("./mag.ts");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });
    expect(draftProposalRequestsFor("task-X").length).toBe(0);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMag(["draft-proposal", "task-X"]);
      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Skipped draft-proposal request for task-X"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }

    expect(draftProposalRequestsFor("task-X").length).toBe(0); // no redundant request
  });
});

describe("in-flight dedup — keepalive maybeQueueProposals (AC b)", () => {
  test("popped-but-unresolved record blocks the keepalive auto-queue (queue empty)", async () => {
    const { maybeQueueProposals, writeInFlight } = await import("./mag.ts");
    writeCandidateTask("task-X");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      maybeQueueProposals();
    } finally {
      errSpy.mockRestore();
    }

    expect(draftProposalRequestsFor("task-X").length).toBe(0); // not re-enqueued
  });
});

describe("in-flight dedup — keepalive maybeFillEmptySlots top candidate (AC b)", () => {
  test("popped-but-unresolved record blocks the top-candidate auto-queue (queue empty)", async () => {
    const { maybeFillEmptySlots, writeInFlight } = await import("./mag.ts");
    writeCandidateTask("task-X");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await maybeFillEmptySlots();
    } finally {
      errSpy.mockRestore();
    }

    expect(draftProposalRequestsFor("task-X").length).toBe(0); // not re-enqueued
  });
});

// --- AC (c): negative control — genuinely-absent draft-proposal still enqueues ---

describe("negative control — absent draft-proposal still enqueues (AC c)", () => {
  test("manual handler enqueues exactly one when nothing pending/in-flight", async () => {
    const { runMag } = await import("./mag.ts");
    expect(draftProposalRequestsFor("task-X").length).toBe(0);

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMag(["draft-proposal", "task-X"]);
      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Queued draft-proposal request for task-X"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }

    expect(draftProposalRequestsFor("task-X").length).toBe(1);
  });

  test("keepalive maybeQueueProposals enqueues when nothing pending/in-flight", async () => {
    const { maybeQueueProposals } = await import("./mag.ts");
    writeCandidateTask("task-X");

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      maybeQueueProposals();
    } finally {
      errSpy.mockRestore();
    }

    expect(draftProposalRequestsFor("task-X").length).toBe(1);
  });
});

// --- AC (d): negative control on the in-flight arm via an entry point ---

describe("negative control — resolved in-flight record does not block (AC d)", () => {
  test("manual handler enqueues when an in-flight record's result JSON exists", async () => {
    const { runMag, writeInFlight } = await import("./mag.ts");
    writeInFlight({
      requestId: "req-IF",
      command: "/ludics-draft-proposal",
      line: JSON.stringify({ id: "req-IF", action: "draft-proposal", task: "task-X" }),
      deliveredAt: "2026-06-06T14:10:33Z",
    });
    writeFileSync(resultFile("req-IF"), JSON.stringify({ status: "ok" }));

    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMag(["draft-proposal", "task-X"]);
      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Queued draft-proposal request for task-X"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }

    expect(draftProposalRequestsFor("task-X").length).toBe(1);
  });
});
