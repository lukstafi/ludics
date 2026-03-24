import { describe, expect, test } from "bun:test";
import { waitForNewTurn } from "./index.ts";
import type { T3LatestTurn, T3Snapshot } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(threadId: string, latestTurn: T3LatestTurn | null): T3Snapshot {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: "proj-1",
        title: "Test Thread",
        model: "claude-opus-4",
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        latestTurn,
      },
    ],
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeTurn(
  turnId: string,
  state: T3LatestTurn["state"],
  requestedAt = "2026-03-24T10:00:00Z",
): T3LatestTurn {
  return { turnId, state, requestedAt };
}

// ---------------------------------------------------------------------------
// waitForNewTurn — turn-ID correlation tests
// ---------------------------------------------------------------------------

describe("waitForNewTurn", () => {
  test("ignores a pre-existing completed turn and waits for the new one", async () => {
    const threadId = "thread-abc";
    const stale = "turn-stale";
    const fresh = "turn-fresh";

    // Simulate: first poll still shows stale completed turn; second poll shows new completed turn.
    let calls = 0;
    const getSnapshot = async (): Promise<T3Snapshot> => {
      calls += 1;
      if (calls === 1) {
        return makeSnapshot(threadId, makeTurn(stale, "completed"));
      }
      return makeSnapshot(threadId, makeTurn(fresh, "completed"));
    };

    const result = await waitForNewTurn(getSnapshot, threadId, stale, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
    });

    expect(result).not.toBeNull();
    expect(result?.state).toBe("completed");
    expect(result?.turnId).toBe(fresh);
    // We must have polled at least twice (once stale, once fresh)
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("returns immediately when new completed turn is first observation (no pre-dispatch turn)", async () => {
    const threadId = "thread-xyz";
    const fresh = "turn-new";

    const getSnapshot = async (): Promise<T3Snapshot> =>
      makeSnapshot(threadId, makeTurn(fresh, "completed"));

    const result = await waitForNewTurn(getSnapshot, threadId, null, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
    });

    expect(result?.state).toBe("completed");
    expect(result?.turnId).toBe(fresh);
  });

  test("waits through running state before completing", async () => {
    const threadId = "thread-run";
    const fresh = "turn-running";
    let calls = 0;

    const getSnapshot = async (): Promise<T3Snapshot> => {
      calls += 1;
      const state: T3LatestTurn["state"] = calls < 3 ? "running" : "completed";
      return makeSnapshot(threadId, makeTurn(fresh, state));
    };

    const result = await waitForNewTurn(getSnapshot, threadId, null, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
    });

    expect(result?.state).toBe("completed");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("returns error state when turn ends with error", async () => {
    const threadId = "thread-err";

    const getSnapshot = async (): Promise<T3Snapshot> =>
      makeSnapshot(threadId, makeTurn("turn-err", "error"));

    const result = await waitForNewTurn(getSnapshot, threadId, null, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
    });

    expect(result?.state).toBe("error");
  });

  test("returns interrupted state when turn is interrupted", async () => {
    const threadId = "thread-int";

    const getSnapshot = async (): Promise<T3Snapshot> =>
      makeSnapshot(threadId, makeTurn("turn-int", "interrupted"));

    const result = await waitForNewTurn(getSnapshot, threadId, null, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
    });

    expect(result?.state).toBe("interrupted");
  });

  test("returns null when thread is not found in snapshot", async () => {
    const getSnapshot = async (): Promise<T3Snapshot> => ({
      snapshotSequence: 1,
      projects: [],
      threads: [], // no threads at all
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const result = await waitForNewTurn(getSnapshot, "thread-missing", null, {
      pollIntervalMs: 10,
      maxWaitMs: 100,
    });

    expect(result).toBeNull();
  });

  test("returns null on timeout when no new turn appears", async () => {
    const threadId = "thread-stall";
    const stale = "turn-stale";

    // Always return the same stale completed turn — dispatch turn never appears
    const getSnapshot = async (): Promise<T3Snapshot> =>
      makeSnapshot(threadId, makeTurn(stale, "completed"));

    const result = await waitForNewTurn(getSnapshot, threadId, stale, {
      pollIntervalMs: 10,
      maxWaitMs: 80,
    });

    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // minRequestedAt filter (concurrent-actor guard)
  // ---------------------------------------------------------------------------

  test("ignores a concurrent turn requested before minRequestedAt", async () => {
    const threadId = "thread-concurrent";
    const concurrent = "turn-concurrent";
    const ours = "turn-ours";

    // concurrent turn was created before our dispatch timestamp
    const minRequestedAt = "2026-03-24T12:00:00Z";
    const beforeDispatch = "2026-03-24T11:59:00Z";
    const afterDispatch = "2026-03-24T12:01:00Z";

    let calls = 0;
    const getSnapshot = async (): Promise<T3Snapshot> => {
      calls += 1;
      if (calls === 1) {
        // First poll: concurrent actor's completed turn (before our dispatch time)
        return makeSnapshot(threadId, makeTurn(concurrent, "completed", beforeDispatch));
      }
      // Second poll: our turn completes
      return makeSnapshot(threadId, makeTurn(ours, "completed", afterDispatch));
    };

    const result = await waitForNewTurn(getSnapshot, threadId, null, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
      minRequestedAt,
    });

    expect(result?.turnId).toBe(ours);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("accepts a turn with requestedAt exactly at minRequestedAt", async () => {
    const threadId = "thread-exact";
    const ts = "2026-03-24T12:00:00Z";

    const getSnapshot = async (): Promise<T3Snapshot> =>
      makeSnapshot(threadId, makeTurn("turn-exact", "completed", ts));

    const result = await waitForNewTurn(getSnapshot, threadId, null, {
      pollIntervalMs: 10,
      maxWaitMs: 5_000,
      minRequestedAt: ts,
    });

    expect(result?.turnId).toBe("turn-exact");
  });
});
