import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DISPATCHERS,
  ALIASES,
  INTERNAL_HIDDEN,
  USAGE_INLINE_HANDLED,
  extractNamedBody,
  extractCasesFromFn,
  extractRegistryMapKeys,
  extractRegistryRecordKeys,
  extractIfElseSubs,
  extractListing,
  extractUsageSubs,
  extractCasesForSite,
  checkSite,
  lintCliSubcommands,
} from "./lint-cli-subcommands.ts";
import { extractUsageBlock } from "./lint-cli-readme.ts";
import { runTasks } from "../src/tasks/index.ts";

const root = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Pure extractor unit tests (in-memory fixtures)
// ---------------------------------------------------------------------------

describe("extractNamedBody", () => {
  test("returns the body of a function declaration via brace balancing", () => {
    const src = `function foo() {\n  if (1) { x }\n  return 2;\n}\n`;
    const body = extractNamedBody(src, "foo", "{");
    expect(body).toContain("if (1)");
    expect(body).toContain("return 2");
  });

  test("returns the array body of a const = new Map([...]) literal", () => {
    const src = [
      "const reg = new Map<string, Handler>([",
      `  ["alpha", () => {}],`,
      `  ["beta",  betaHandler],`,
      "]);",
    ].join("\n");
    const body = extractNamedBody(src, "reg", "[");
    expect(body).toContain(`"alpha"`);
    expect(body).toContain(`"beta"`);
  });

  test("returns empty string when the name is absent", () => {
    expect(extractNamedBody("// nothing here", "missing", "{")).toBe("");
  });
});

describe("extractCasesFromFn (switch shape)", () => {
  test("captures every case literal at any indent depth", () => {
    const body = `
      switch (sub) {
        case "alpha": doA(); break;
        case "beta": {
          doB();
          break;
        }
        default:
          throw new Error("nope");
      }
    `;
    const cases = extractCasesFromFn(body);
    expect([...cases].sort()).toEqual(["alpha", "beta"]);
  });

  test("ignores nested switch case literals when scoped to outer body", () => {
    // Nested switch sits inside an outer `case` body. We deliberately keep
    // the regex flat — both the outer "alpha" and inner "x"/"y" are picked
    // up. The lint relies on first-level scoping at the *site* level
    // (we run extractCasesFromFn against the registered fnName's body
    // only), not on this regex understanding nesting.
    const body = `
      case "alpha": {
        switch (sub2) {
          case "x": break;
          case "y": break;
        }
        break;
      }
    `;
    const cases = extractCasesFromFn(body);
    expect(cases.has("alpha")).toBe(true);
    expect(cases.has("x")).toBe(true);
    expect(cases.has("y")).toBe(true);
  });
});

describe("extractRegistryMapKeys (registry-map shape)", () => {
  test("captures every entry with mixed handler shapes", () => {
    const body = [
      `["one", oneHandler],`,
      `["two", async (args) => { doB(args); }],`,
      `["three", (args) => doC(args)],`,
      `["four-with-dash", async () => doD()],`,
    ].join("\n  ");
    const keys = extractRegistryMapKeys(body);
    expect([...keys].sort()).toEqual(["four-with-dash", "one", "three", "two"]);
  });
});

describe("extractRegistryRecordKeys (registry-record shape)", () => {
  test("captures top-level record keys but not nested object literals", () => {
    const body = [
      "  alpha: handlerA,",
      "  beta: async (args) => {",
      "    if (args[0]) {",
      "      something({ inner: true });", // nested key — must be ignored
      "    }",
      "  },",
      "  gamma: handlerG,",
    ].join("\n");
    const keys = extractRegistryRecordKeys(body);
    expect([...keys].sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(keys.has("inner")).toBe(false);
  });
});

describe("extractIfElseSubs (if-else shape)", () => {
  test("captures every `sub === \"X\"` branch and ignores empty-string", () => {
    const body = `
      if (sub === "status" || sub === "") {
        statusFn();
      } else if (sub === "alpha") {
        alphaFn();
      } else if (sub === "beta") {
        betaFn();
      } else {
        throw new Error("unknown");
      }
    `;
    const subs = extractIfElseSubs(body);
    expect([...subs].sort()).toEqual(["alpha", "beta", "status"]);
  });
});

describe("extractListing", () => {
  test("captures the (use: ...) entries via the unknown-<prefix> pattern", () => {
    const body = `throw new Error(\`unknown flow command: \${sub} (use: ready, blocked, critical)\`);`;
    const set = extractListing(body, "flow");
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual(["blocked", "critical", "ready"]);
  });

  test("tolerates 'subcommand' wording (runTasks shape)", () => {
    const body = `throw new Error(\`unknown tasks subcommand: \${sub} (use: a, b, c)\`);`;
    const set = extractListing(body, "tasks");
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual(["a", "b", "c"]);
  });

  test("returns null when the pattern is absent", () => {
    expect(extractListing("nothing relevant", "mag")).toBeNull();
  });
});

describe("extractUsageSubs", () => {
  test("scopes matches to the requested prefix", () => {
    const usage = [
      "  mag start                 Start",
      "  mag elaborate <id>        Elab",
      "  flow ready                Show",
      "  flow blocked              Show",
    ].join("\n");
    const mag = extractUsageSubs(usage, "mag");
    const flow = extractUsageSubs(usage, "flow");
    expect([...mag].sort()).toEqual(["elaborate", "start"]);
    expect([...flow].sort()).toEqual(["blocked", "ready"]);
  });

  test("for the ludics top-level prefix returns top-level commands", () => {
    const usage = [
      "  tasks ls                  List",
      "  flow ready                Show",
      "  status                    Overview",
    ].join("\n");
    const top = extractUsageSubs(usage, "ludics");
    expect(top.has("tasks")).toBe(true);
    expect(top.has("flow")).toBe(true);
    expect(top.has("status")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkSite — negative fixtures, one per invariant
// ---------------------------------------------------------------------------

describe("checkSite — negative fixtures", () => {
  test("flags case implemented but undocumented in USAGE", () => {
    const src = [
      "function runFoo(args: string[]) {",
      `  switch (args[0]) {`,
      `    case "alpha": break;`,
      `    case "beta": break;`,
      `    default: throw new Error(\`unknown foo command: \${sub} (use: alpha, beta)\`);`,
      "  }",
      "}",
    ].join("\n");
    const usage = "  foo alpha   first\n";
    const result = checkSite(
      { file: "f.ts", prefix: "foo", fnName: "runFoo", shape: "switch", hasListing: true },
      src,
      usage,
    );
    expect(result.errors.some((e) => e.includes("undocumented in USAGE"))).toBe(true);
    expect(result.errors.some((e) => e.includes("beta"))).toBe(true);
  });

  test("flags case implemented but missing from default listing", () => {
    const src = [
      "function runFoo(args: string[]) {",
      `  switch (args[0]) {`,
      `    case "alpha": break;`,
      `    case "beta": break;`,
      `    default: throw new Error(\`unknown foo command: \${sub} (use: alpha)\`);`,
      "  }",
      "}",
    ].join("\n");
    const usage = "  foo alpha   first\n  foo beta   second\n";
    const result = checkSite(
      { file: "f.ts", prefix: "foo", fnName: "runFoo", shape: "switch", hasListing: true },
      src,
      usage,
    );
    expect(result.errors.some((e) => e.includes("missing from default (use:"))).toBe(true);
  });

  test("flags listing entry with no implementation", () => {
    const src = [
      "function runFoo(args: string[]) {",
      `  switch (args[0]) {`,
      `    case "alpha": break;`,
      `    default: throw new Error(\`unknown foo command: \${sub} (use: alpha, ghost)\`);`,
      "  }",
      "}",
    ].join("\n");
    const usage = "  foo alpha   first\n";
    const result = checkSite(
      { file: "f.ts", prefix: "foo", fnName: "runFoo", shape: "switch", hasListing: true },
      src,
      usage,
    );
    expect(result.errors.some((e) => e.includes("no implementation"))).toBe(true);
    expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags documented command with no implementation", () => {
    const src = [
      "function runFoo(args: string[]) {",
      `  switch (args[0]) {`,
      `    case "alpha": break;`,
      `    default: throw new Error(\`unknown foo command: \${sub} (use: alpha)\`);`,
      "  }",
      "}",
    ].join("\n");
    const usage = "  foo alpha   first\n  foo phantom  fake\n";
    const result = checkSite(
      { file: "f.ts", prefix: "foo", fnName: "runFoo", shape: "switch", hasListing: true },
      src,
      usage,
    );
    expect(result.errors.some((e) => e.includes("documented in USAGE but no implementation"))).toBe(true);
    expect(result.errors.some((e) => e.includes("phantom"))).toBe(true);
  });

  test("flags zero-case extractor breakage", () => {
    const src = "function runFoo() {}\n";
    const result = checkSite(
      { file: "f.ts", prefix: "foo", fnName: "runFoo", shape: "switch", hasListing: false },
      src,
      "",
    );
    expect(result.errors.some((e) => e.includes("zero cases"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Allow-list and internal-hidden tables — sanity
// ---------------------------------------------------------------------------

describe("ALIASES + INTERNAL_HIDDEN tables", () => {
  test("each ALIASES prefix is a real DISPATCHERS prefix", () => {
    const validPrefixes = new Set(DISPATCHERS.map((d) => d.prefix));
    for (const prefix of Object.keys(ALIASES)) {
      expect(validPrefixes.has(prefix)).toBe(true);
    }
  });

  test("INTERNAL_HIDDEN names are subsets of valid prefixes", () => {
    const validPrefixes = new Set(DISPATCHERS.map((d) => d.prefix));
    for (const prefix of Object.keys(INTERNAL_HIDDEN)) {
      expect(validPrefixes.has(prefix)).toBe(true);
    }
  });

  test("USAGE_INLINE_HANDLED is restricted to ludics today", () => {
    expect(Object.keys(USAGE_INLINE_HANDLED)).toEqual(["ludics"]);
  });
});

// ---------------------------------------------------------------------------
// Real-repo smoke — must hold after Phases 1+2 land
// ---------------------------------------------------------------------------

describe("real repository", () => {
  test("lintCliSubcommands returns no errors against the real source", () => {
    const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf-8");
    const usageBlock = extractUsageBlock(indexSrc);
    const results = lintCliSubcommands(
      (rel) => readFileSync(join(root, rel), "utf-8"),
      usageBlock,
    );
    const allErrors = results.flatMap((r) => r.errors);
    if (allErrors.length > 0) {
      // Surface the actual mismatches in the test failure message.
      throw new Error(`real-repo drift:\n${allErrors.map((e) => "  - " + e).join("\n")}`);
    }
    expect(allErrors).toEqual([]);
    expect(results.length).toBe(10);
  });

  test("runTasks unknown-subcommand listing now contains queue-elaborations", async () => {
    // Invariant: the runTasks default listing on `main` was missing
    // queue-elaborations even though the case existed. The Phase 1 fix
    // restored it; this test catches regressions.
    // Harness condition: invoke runTasks with a sentinel sub that is not
    // any real case label.
    let err: Error | null = null;
    try {
      await runTasks(["__bogus__"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("queue-elaborations");
  });
});

// ---------------------------------------------------------------------------
// Floor-count meta-tests (gh-ludics-406 convention)
// ---------------------------------------------------------------------------

describe("floor-count guards (gh-ludics-406)", () => {
  // Failure modes these guards catch:
  //   (a) a future DRY refactor collapses the case literals (e.g. introduces
  //       a generated table) — extractor returns 0/few hits, lint passes
  //       vacuously without the guard;
  //   (b) the extractor regex itself drifts and silently stops matching.
  //
  // Today: runMag registry has 25 entries; MIGRATED_COMMANDS has 27. Floors
  // are set with slack so single-command removals do not trip the guard.

  test("magSubcommands registry size ≥ 20", () => {
    const src = readFileSync(join(root, "src", "mag.ts"), "utf-8");
    const body = extractNamedBody(src, "magSubcommands", "[");
    const keys = extractCasesForSite(body, "registry-map");
    expect(keys.size).toBeGreaterThanOrEqual(20);
  });

  test("MIGRATED_COMMANDS top-level keys ≥ 20", () => {
    const src = readFileSync(join(root, "src", "index.ts"), "utf-8");
    const body = extractNamedBody(src, "MIGRATED_COMMANDS", "{");
    const keys = extractCasesForSite(body, "registry-record");
    expect(keys.size).toBeGreaterThanOrEqual(20);
  });

  test("each switch dispatcher has at least one case extracted", () => {
    // Positive control for the switch extractor across every site that uses
    // the shape; protects against the regex breaking on a syntax variation.
    for (const site of DISPATCHERS) {
      if (site.shape !== "switch") continue;
      const src = readFileSync(join(root, site.file), "utf-8");
      const body = extractNamedBody(src, site.fnName, "{");
      const cases = extractCasesForSite(body, "switch");
      expect(cases.size).toBeGreaterThan(0);
    }
  });
});
