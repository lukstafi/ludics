import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as spawnMod from "./spawn.ts";
import { checkJqPrereq } from "./init.ts";

// gh-ludics-590: `ludics init` must HARD-fail when jq is absent, mirroring the
// existing `which tmux` / `which ttyd` gates — a worker must not onboard jq-less
// (the orchestration on-stop hook + Mag queue hard-depend on jq).
describe("checkJqPrereq (gh-ludics-590 init jq hard gate)", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function spyWhich(jqResolves: boolean) {
    // Force only the `which jq` probe; delegate every other argv to the real impl
    // so we exercise the exact gate predicate, not a blanket stub.
    const real = spawnMod.safeSyncOutput;
    const spy = spyOn(spawnMod, "safeSyncOutput").mockImplementation((argv: string[]) => {
      if (argv[0] === "which" && argv[1] === "jq") {
        return {
          ok: jqResolves,
          exitCode: jqResolves ? 0 : 1,
          stdout: jqResolves ? "/usr/bin/jq" : "",
          stderr: "",
          timedOut: false,
        };
      }
      return real(argv);
    });
    spies.push(spy);
    return spy;
  }

  test("exits non-zero with an install hint naming jq when `which jq` fails", () => {
    // Harness condition: `which jq` reports NOT ok — the jq-absent worker state.
    const whichSpy = spyWhich(false);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    spies.push(errSpy);
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    spies.push(exitSpy);

    // Invariant: jq-absent ⇒ process.exit(1). Mutation — turning the gate into a
    // soft warn (no exit) makes this throw never fire and the assertion fails.
    expect(() => checkJqPrereq()).toThrow("process.exit(1)");
    // The gate predicate actually probed `which jq` (not a vacuous pass).
    expect(whichSpy.mock.calls.some((c) => (c[0] as string[]).join(" ") === "which jq")).toBe(true);
    // Install hints must name jq and BOTH per-OS commands (AC 5).
    const msg = (errSpy.mock.calls[0]?.[0] as string) ?? "";
    expect(msg).toContain("jq");
    expect(msg).toContain("brew install jq");
    expect(msg).toContain("apt install jq");
  });

  test("does NOT exit when `which jq` succeeds", () => {
    // Harness condition: `which jq` reports ok — the gate must be a pass-through.
    spyWhich(true);
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    spies.push(exitSpy);

    // Invariant: jq present ⇒ no exit. Catches an over-eager gate that exits regardless.
    expect(() => checkJqPrereq()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
