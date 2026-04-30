import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import {
  detectDefaultBranches,
  expandHome,
  hasRemote,
  resolveBaseRef,
  withCheckout,
  type RunGit,
} from "./git-runner.ts";

/**
 * Build a fake runGit that dispatches on argv prefix. Each rule matches a
 * leading subsequence of argv; the first matching rule wins.
 */
function fakeGit(rules: Array<{ match: string[]; stdout: string; exitCode?: number }>): RunGit {
  return (args) => {
    for (const r of rules) {
      if (r.match.every((m, i) => args[i] === m)) {
        return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
      }
    }
    return { stdout: "", exitCode: 128 };
  };
}

describe("git-runner helpers", () => {
  test("expandHome: expands ~/ prefix and normalizes via resolve semantics", () => {
    const origHome = process.env.HOME;
    process.env.HOME = "/home/alice";
    try {
      // ~/ prefix expands to $HOME and normalizes the joined path.
      expect(expandHome("~/work/foo")).toBe("/home/alice/work/foo");
      // Absolute paths pass through unchanged.
      expect(expandHome("/abs/path")).toBe("/abs/path");
      // Relative inputs become absolute (anchored at cwd) — this is the
      // behaviour the consolidation borrowed from the former expandHomePath.
      expect(expandHome("relative")).toBe(resolve("relative"));
      // Normalization: `..` segments are collapsed.
      expect(expandHome("~/a/../b")).toBe("/home/alice/b");
      // Normalization: trailing slashes are removed.
      expect(expandHome("/abs/path/")).toBe("/abs/path");
    } finally {
      process.env.HOME = origHome;
    }
  });

  test("hasRemote: parses `git remote` output", () => {
    const rg = fakeGit([{ match: ["remote"], stdout: "origin\nupstream\n" }]);
    expect(hasRemote("/x", "origin", rg)).toBe(true);
    expect(hasRemote("/x", "upstream", rg)).toBe(true);
    expect(hasRemote("/x", "fork", rg)).toBe(false);
  });

  test("hasRemote: returns false on non-zero exit", () => {
    const rg = fakeGit([{ match: ["remote"], stdout: "", exitCode: 128 }]);
    expect(hasRemote("/x", "origin", rg)).toBe(false);
  });

  test("detectDefaultBranches: primary symbolic-ref wins", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/master\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/main\n" },
    ]);
    const b = detectDefaultBranches("/x", rg);
    expect(b.origin).toBe("master");
    expect(b.upstream).toBe("main");
  });

  test("detectDefaultBranches: falls back to main/master probe when no symbolic-ref", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "abcdef\n" },
    ]);
    const b = detectDefaultBranches("/x", rg);
    expect(b.upstream).toBe("main");
  });

  test("detectDefaultBranches: null when nothing matches", () => {
    const rg = fakeGit([]);
    const b = detectDefaultBranches("/x", rg);
    expect(b.origin).toBeNull();
    expect(b.upstream).toBeNull();
  });

  test("detectDefaultBranches({ authoritativeIO: true }): prefers local symbolic-ref when present", () => {
    // If symbolic-ref succeeds we should NOT call ls-remote (no network).
    const calls: string[][] = [];
    const rg: RunGit = (args) => {
      calls.push(args.slice());
      if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
        return { stdout: "refs/remotes/origin/main\n", exitCode: 0 };
      }
      if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/upstream/HEAD") {
        return { stdout: "refs/remotes/upstream/main\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    };
    const b = detectDefaultBranches("/x", rg, { authoritativeIO: true });
    expect(b.origin).toBe("main");
    expect(b.upstream).toBe("main");
    expect(calls.some((c) => c[0] === "ls-remote")).toBe(false);
  });

  test("detectDefaultBranches({ authoritativeIO: true }): falls back to ls-remote --symref when symbolic-ref fails", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref"], stdout: "", exitCode: 128 },
      {
        match: ["ls-remote", "--symref", "upstream", "HEAD"],
        stdout: "ref: refs/heads/develop\tHEAD\n0123abc\tHEAD\n",
      },
      {
        match: ["ls-remote", "--symref", "origin", "HEAD"],
        stdout: "ref: refs/heads/trunk\tHEAD\n0123abc\tHEAD\n",
      },
    ]);
    const b = detectDefaultBranches("/x", rg, { authoritativeIO: true });
    expect(b.origin).toBe("trunk");
    expect(b.upstream).toBe("develop");
  });

  test("detectDefaultBranches({ authoritativeIO: true }): ls-remote failure falls through to main/master probe", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref"], stdout: "", exitCode: 128 },
      { match: ["ls-remote"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "feedface\n" },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], stdout: "deadbeef\n" },
    ]);
    const b = detectDefaultBranches("/x", rg, { authoritativeIO: true });
    expect(b.origin).toBe("main");
    expect(b.upstream).toBe("main");
  });

  test("detectDefaultBranches({ authoritativeIO: true }): ls-remote without `ref:` line falls through", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref"], stdout: "", exitCode: 128 },
      // exit 0 but stdout lacks "ref: refs/heads/..." — treat as unknown and fall through.
      { match: ["ls-remote"], stdout: "0123abc\tHEAD\n", exitCode: 0 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"], stdout: "x\n" },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/master"], stdout: "x\n" },
    ]);
    const b = detectDefaultBranches("/x", rg, { authoritativeIO: true });
    expect(b.origin).toBe("master");
    expect(b.upstream).toBe("master");
  });

  test("detectDefaultBranches: default (no opts) does not invoke ls-remote — guards the briefing-lag no-network contract", () => {
    // Briefing-lag invokes detectDefaultBranches every keepalive tick on
    // every project; an accidental network round-trip per tick would be a
    // serious regression. This test pins the no-network default by failing
    // if any ls-remote call leaks through.
    const calls: string[][] = [];
    const rg: RunGit = (args) => {
      calls.push(args.slice());
      // Force the cascade past the symref tier so the bug — ls-remote
      // firing when authoritativeIO is unset — would be observable.
      if (args[0] === "symbolic-ref") return { stdout: "", exitCode: 128 };
      if (args[0] === "rev-parse" && args[3]?.endsWith("/main")) {
        return { stdout: "deadbeef\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 128 };
    };
    detectDefaultBranches("/x", rg);
    expect(calls.some((c) => c[0] === "ls-remote")).toBe(false);
    // And for authoritativeIO: false explicitly, same guarantee.
    const calls2: string[][] = [];
    const rg2: RunGit = (args) => {
      calls2.push(args.slice());
      if (args[0] === "symbolic-ref") return { stdout: "", exitCode: 128 };
      if (args[0] === "rev-parse" && args[3]?.endsWith("/main")) {
        return { stdout: "deadbeef\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 128 };
    };
    detectDefaultBranches("/x", rg2, { authoritativeIO: false });
    expect(calls2.some((c) => c[0] === "ls-remote")).toBe(false);
  });
});

describe("resolveBaseRef", () => {
  test("origin symref present → returns origin/<name>", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/main\n" },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/develop\n" },
    ]);
    expect(resolveBaseRef("/x", rg)).toBe("origin/main");
  });

  test("origin absent + upstream symref present → returns upstream/<name>", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref", "refs/remotes/origin/HEAD"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"], stdout: "", exitCode: 1 },
      { match: ["symbolic-ref", "refs/remotes/upstream/HEAD"], stdout: "refs/remotes/upstream/develop\n" },
    ]);
    expect(resolveBaseRef("/x", rg)).toBe("upstream/develop");
  });

  test("both remote symrefs empty + refs/heads/main exists → returns 'main'", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref"], stdout: "", exitCode: 128 },
      // No remote main/master.
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/master"], stdout: "", exitCode: 1 },
      // Local main exists.
      { match: ["rev-parse", "--verify", "--quiet", "refs/heads/main"], stdout: "abcdef\n" },
    ]);
    expect(resolveBaseRef("/x", rg)).toBe("main");
  });

  test("both remote symrefs empty + refs/heads/master only → returns 'master'", () => {
    const rg = fakeGit([
      { match: ["symbolic-ref"], stdout: "", exitCode: 128 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/master"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/heads/main"], stdout: "", exitCode: 1 },
      { match: ["rev-parse", "--verify", "--quiet", "refs/heads/master"], stdout: "fedcba\n" },
    ]);
    expect(resolveBaseRef("/x", rg)).toBe("master");
  });

  test("all probes fail → returns null", () => {
    const rg = fakeGit([]);
    expect(resolveBaseRef("/x", rg)).toBeNull();
  });

  test("no network round-trip — ls-remote is never invoked", () => {
    // Pins the local-only contract: resolveBaseRef must not call
    // ls-remote even on a fully-empty repo where every probe fails.
    const calls: string[][] = [];
    const rg: RunGit = (args) => {
      calls.push(args.slice());
      return { stdout: "", exitCode: 128 };
    };
    resolveBaseRef("/x", rg);
    expect(calls.some((c) => c[0] === "ls-remote")).toBe(false);
  });
});

describe("withCheckout", () => {
  function recordingGit(responder: (args: string[]) => { stdout: string; exitCode: number }): {
    run: RunGit;
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      calls,
      run: (args) => {
        calls.push(args.slice());
        return responder(args);
      },
    };
  }

  test("named-branch: checks out target, runs callback, restores prior branch", () => {
    const { run, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "topic\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const result = withCheckout("/x", "master", run, () => {
      calls.push(["<callback>"]);
      return "ok";
    });
    expect(result).toBe("ok");
    const sequence = calls.map((c) => c.join(" "));
    // Prior branch read, then checkout master, then callback, then checkout topic.
    expect(sequence[0]).toContain("rev-parse --abbrev-ref");
    expect(sequence[1]).toBe("checkout master");
    expect(sequence[2]).toBe("<callback>");
    expect(sequence[3]).toBe("checkout topic");
  });

  test("detached HEAD: captures SHA, checks out target, restores with --detach", () => {
    const SHA = "abcdef0123456789abcdef0123456789abcdef01";
    const { run, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "HEAD\n", exitCode: 0 };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: `${SHA}\n`, exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    withCheckout("/x", "master", run, () => undefined);
    const last = calls[calls.length - 1]!;
    expect(last).toEqual(["checkout", "--detach", SHA]);
  });

  test("already on target: skips checkout and restore, just invokes callback", () => {
    const { run, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "master\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    let called = false;
    const r = withCheckout("/x", "master", run, () => {
      called = true;
      return 42;
    });
    expect(r).toBe(42);
    expect(called).toBe(true);
    expect(calls.some((c) => c[0] === "checkout")).toBe(false);
  });

  test("callback exception still triggers restore", () => {
    const { run, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "topic\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    expect(() =>
      withCheckout("/x", "master", run, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const last = calls[calls.length - 1]!;
    expect(last).toEqual(["checkout", "topic"]);
  });

  test("rejects async callbacks at compile time via the conditional-type constraint on fn", () => {
    // The `fn` parameter is typed `() => T extends PromiseLike<unknown> ? never : T`,
    // so any callback whose return type extends `PromiseLike` (including `async`
    // functions and explicit `Promise<X>` returns) requires `() => never` and
    // fails to typecheck. These `@ts-expect-error` lines assert that contract:
    // if the constraint is ever weakened, tsc will flag the directive as unused
    // and the test fails to compile.
    const { run } = recordingGit(() => ({ stdout: "", exitCode: 0 }));
    // @ts-expect-error async callback returns Promise — banned by conditional type
    void withCheckout("/x", "master", run, async () => 42);
    // @ts-expect-error explicit Promise.resolve return — banned by conditional type
    void withCheckout("/x", "master", run, () => Promise.resolve("ok"));
    // Sanity: the synchronous form still typechecks (no @ts-expect-error here
    // would surface "Unused @ts-expect-error" if the line below were misclassified).
    const r = withCheckout("/x", "master", run, () => 7);
    expect(r).toBe(7);
  });

  test("checkout failure throws and does not invoke callback", () => {
    const { run, calls } = recordingGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "topic\n", exitCode: 0 };
      }
      if (args[0] === "checkout") {
        return { stdout: "error: the following untracked files\n", exitCode: 1 };
      }
      return { stdout: "", exitCode: 0 };
    });
    let invoked = false;
    expect(() =>
      withCheckout("/x", "master", run, () => {
        invoked = true;
      }),
    ).toThrow(/checkout master failed/);
    expect(invoked).toBe(false);
    // No restore call recorded, because we never swapped away.
    expect(calls.filter((c) => c[0] === "checkout")).toHaveLength(1);
  });
});
