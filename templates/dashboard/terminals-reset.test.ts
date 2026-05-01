// task-7476a03a — terminals-reset.js regression coverage. Pins the
// once-per-page-lifetime invariant and warn-only error handling for both
// network rejections and non-2xx responses.

import { describe, expect, test, beforeEach, spyOn } from "bun:test";

import {
  __resetForTests,
  maybeResetTtydCounters,
} from "./terminals-reset.js";

type FetchCall = { url: string; init?: { method?: string } };

function makeFetchSpy(impl: (url: string, init?: { method?: string }) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = ((url: string, init?: { method?: string }) => {
    calls.push({ url, init });
    return impl(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

beforeEach(() => {
  __resetForTests();
});

describe("maybeResetTtydCounters — once per page lifetime", () => {
  test("first call posts /api/ttyd-reset?slot=N for each active slot; second call is a no-op", async () => {
    const { fn, calls } = makeFetchSpy(async () => new Response("OK", { status: 200 }));

    await maybeResetTtydCounters([1, 2, 3], fn);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/ttyd-reset?slot=1",
      "/api/ttyd-reset?slot=2",
      "/api/ttyd-reset?slot=3",
    ]);
    for (const c of calls) expect(c.init?.method).toBe("POST");

    // Invariant: subsequent calls within the same module lifetime add
    // zero new fetch invocations regardless of the args. Mutation:
    // commenting out `if (resetSent) return;` makes calls.length jump.
    await maybeResetTtydCounters([1, 2, 3], fn);
    await maybeResetTtydCounters([4, 5], fn);
    expect(calls.length).toBe(3);
  });

  test("first call with [] still flips resetSent so a follow-up with non-empty slots is a no-op", async () => {
    const { fn, calls } = makeFetchSpy(async () => new Response("OK", { status: 200 }));
    await maybeResetTtydCounters([], fn);
    expect(calls.length).toBe(0);
    // Invariant from proposal AC: "first call may see zero active slots;
    // should mark itself done for that page lifetime".
    await maybeResetTtydCounters([1, 2], fn);
    expect(calls.length).toBe(0);
  });
});

describe("maybeResetTtydCounters — warn-only failure handling", () => {
  test("rejected fetch resolves through Promise.allSettled and warns to console", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fn = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
      // Must not throw — render path depends on this resolving.
      await maybeResetTtydCounters([1, 2], fn);
      // Both slots produced one warn entry each. Mutation: removing the
      // try/catch around `await f(...)` would cause an unhandled rejection
      // and Promise.allSettled would still resolve, but the test's "warn
      // count = slot count" assertion would fail.
      expect(warnSpy.mock.calls.length).toBe(2);
      const messages = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(messages.every((m: string) => m === "ttyd-reset failed")).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("non-2xx response logs status code via console.warn (no throw)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fn = makeFetchSpy(async () => new Response("oops", { status: 503, statusText: "Service Unavailable" })).fn;
      await maybeResetTtydCounters([1], fn);
      // Invariant: a 5xx response (resp.ok === false) must trigger a warn.
      // Mutation: removing the `if (!resp.ok) console.warn(...)` branch
      // makes warnSpy.mock.calls.length === 0 and this assertion fails.
      expect(warnSpy.mock.calls.length).toBe(1);
      const args = warnSpy.mock.calls[0] as unknown[];
      expect(String(args[0])).toBe("ttyd-reset non-2xx");
      expect(args[1]).toBe(1);
      expect(args[2]).toBe(503);
      expect(args[3]).toBe("Service Unavailable");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a 2xx response does NOT warn", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fn = makeFetchSpy(async () => new Response("OK", { status: 200 })).fn;
      await maybeResetTtydCounters([1, 2], fn);
      expect(warnSpy.mock.calls.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
