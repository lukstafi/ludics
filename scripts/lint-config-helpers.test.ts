import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractInterfaceBody,
  parseFieldDeclarations,
  extractInterfacePaths,
  extractMagPathsFromSource,
  flattenYamlPaths,
  collectArrayPaths,
  comparePaths,
} from "./lint-config-helpers.ts";

// ---------------------------------------------------------------------------
// extractInterfaceBody
// ---------------------------------------------------------------------------

describe("extractInterfaceBody", () => {
  test("extracts simple interface body", () => {
    const src = `export interface Foo {\n  a: string;\n  b: number;\n}`;
    expect(extractInterfaceBody(src, "Foo")).toBe("\n  a: string;\n  b: number;\n");
  });

  test("handles inline nested objects", () => {
    const src = `interface Bar { x?: { y?: number }; }`;
    const body = extractInterfaceBody(src, "Bar");
    expect(body).toContain("x?:");
    expect(body).toContain("y?: number");
  });

  test("returns null for missing interface", () => {
    expect(extractInterfaceBody("const x = 1;", "Nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseFieldDeclarations
// ---------------------------------------------------------------------------

describe("parseFieldDeclarations", () => {
  test("parses simple fields", () => {
    const body = "  name: string;\n  count?: number;";
    const fields = parseFieldDeclarations(body);
    expect(fields).toEqual([
      { name: "name", typeExpr: "string" },
      { name: "count", typeExpr: "number" },
    ]);
  });

  test("skips JSDoc comments", () => {
    const body = "  /** A comment */\n  val: boolean;";
    const fields = parseFieldDeclarations(body);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe("val");
  });
});

// ---------------------------------------------------------------------------
// extractInterfacePaths — nested fields
// ---------------------------------------------------------------------------

describe("extractInterfacePaths", () => {
  test("produces dotted paths for inline objects", () => {
    const src = `
      interface Config {
        top: string;
        nested?: {
          inner?: number;
          deep?: { leaf?: boolean };
        };
      }
    `;
    const { paths } = extractInterfacePaths(src, "Config", new Set());
    expect(paths.has("top")).toBe(true);
    expect(paths.has("nested")).toBe(true);
    expect(paths.has("nested.inner")).toBe(true);
    expect(paths.has("nested.deep")).toBe(true);
    expect(paths.has("nested.deep.leaf")).toBe(true);
  });

  test("expands named interface arrays with * wildcard", () => {
    const src = `
      interface Item { name: string; value: number; }
      interface Root { items?: Item[]; }
    `;
    const known = new Set(["Item"]);
    const { paths } = extractInterfacePaths(src, "Root", known);
    expect(paths.has("items")).toBe(true);
    expect(paths.has("items.*")).toBe(true);
    expect(paths.has("items.*.name")).toBe(true);
    expect(paths.has("items.*.value")).toBe(true);
  });

  test("expands typed Record with * wildcard", () => {
    const src = `
      interface Entry { enabled?: boolean; }
      interface Root { adapters?: Record<string, Entry>; }
    `;
    const known = new Set(["Entry"]);
    const { paths } = extractInterfacePaths(src, "Root", known);
    expect(paths.has("adapters")).toBe(true);
    expect(paths.has("adapters.*")).toBe(true);
    expect(paths.has("adapters.*.enabled")).toBe(true);
  });

  test("marks Record<string, unknown> as opaque", () => {
    const src = `interface Root { data?: Record<string, unknown>; }`;
    const { paths, opaquePaths } = extractInterfacePaths(src, "Root", new Set());
    expect(paths.has("data")).toBe(true);
    expect(opaquePaths.has("data")).toBe(true);
    // no children
    expect([...paths].filter((p) => p.startsWith("data."))).toHaveLength(0);
  });

  test("marks Array<Record<string, unknown>> as opaque", () => {
    const src = `interface Root { items?: Array<Record<string, unknown>>; }`;
    const { paths, opaquePaths } = extractInterfacePaths(src, "Root", new Set());
    expect(paths.has("items")).toBe(true);
    expect(opaquePaths.has("items")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flattenYamlPaths
// ---------------------------------------------------------------------------

describe("flattenYamlPaths", () => {
  test("flattens nested objects", () => {
    const obj = { a: 1, b: { c: 2, d: 3 } };
    const paths = flattenYamlPaths(obj, "", new Set(), new Set());
    expect(paths.has("a")).toBe(true);
    expect(paths.has("b")).toBe(true);
    expect(paths.has("b.c")).toBe(true);
    expect(paths.has("b.d")).toBe(true);
  });

  test("uses * wildcard for arrays", () => {
    const obj = { items: [{ x: 1, y: 2 }] };
    const paths = flattenYamlPaths(obj, "", new Set(), new Set());
    expect(paths.has("items")).toBe(true);
    expect(paths.has("items.*")).toBe(true);
    expect(paths.has("items.*.x")).toBe(true);
    expect(paths.has("items.*.y")).toBe(true);
  });

  test("skips children of freeform paths", () => {
    const obj = { parent: { child1: "a", child2: "b" } };
    const skip = new Set(["parent"]);
    const paths = flattenYamlPaths(obj, "", skip, new Set());
    expect(paths.has("parent")).toBe(true);
    expect(paths.has("parent.child1")).toBe(false);
    expect(paths.has("parent.child2")).toBe(false);
  });

  test("normalizes wildcard map paths", () => {
    const obj = {
      adapters: {
        "agent-claude": { enabled: true },
        "agent-codex": { enabled: true, extra: false },
      },
    };
    const wcMaps = new Set(["adapters"]);
    const paths = flattenYamlPaths(obj, "", new Set(), wcMaps);
    expect(paths.has("adapters")).toBe(true);
    expect(paths.has("adapters.*")).toBe(true);
    expect(paths.has("adapters.*.enabled")).toBe(true);
    expect(paths.has("adapters.*.extra")).toBe(true);
    // Should NOT have literal adapter names
    expect(paths.has("adapters.agent-claude")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// comparePaths
// ---------------------------------------------------------------------------

describe("comparePaths", () => {
  test("detects mismatches in both directions", () => {
    const ts = new Set(["a", "b", "c"]);
    const yaml = new Set(["b", "c", "d"]);
    const result = comparePaths(ts, yaml);
    expect(result.missingFromYaml).toEqual(["a"]);
    expect(result.missingFromTs).toEqual(["d"]);
  });

  test("returns empty arrays when in sync", () => {
    const both = new Set(["x", "y"]);
    const result = comparePaths(both, new Set(both));
    expect(result.missingFromYaml).toEqual([]);
    expect(result.missingFromTs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// public_filter fixture — protects the notifications.public_filter resolution
// ---------------------------------------------------------------------------

describe("public_filter fixture", () => {
  test("notifications.public_filter paths appear in TS extraction", () => {
    const configSource = readFileSync(join(import.meta.dir, "..", "src", "config.ts"), "utf-8");
    const known = new Set(["ProjectConfig", "AdapterConfigEntry"]);
    const { paths } = extractInterfacePaths(configSource, "LudicsFullConfig", known);
    expect(paths.has("notifications.public_filter")).toBe(true);
    expect(paths.has("notifications.public_filter.auto_publish")).toBe(true);
    expect(paths.has("notifications.public_filter.never_publish")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectArrayPaths
// ---------------------------------------------------------------------------

describe("collectArrayPaths", () => {
  test("records array-valued paths including empty arrays", () => {
    const obj = {
      top: "x",
      list_empty: [],
      list_full: [{ a: 1 }],
      nested: { inner: [] },
    };
    const arrs = collectArrayPaths(obj, "", new Set(), new Set());
    expect(arrs.has("list_empty")).toBe(true);
    expect(arrs.has("list_full")).toBe(true);
    expect(arrs.has("nested.inner")).toBe(true);
    expect(arrs.has("top")).toBe(false);
  });

  test("respects skipPaths and wildcard map paths", () => {
    const obj = {
      triggers: { custom: { list: [] } },
      adapters: { "foo-bar": { extras: [] } },
    };
    const arrs = collectArrayPaths(
      obj, "", new Set(["triggers"]), new Set(["adapters"]),
    );
    // triggers subtree is skipped entirely
    expect([...arrs].filter((p) => p.startsWith("triggers"))).toEqual([]);
    // adapters map keys are wildcard-normalized
    expect(arrs.has("adapters.*.extras")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// harness subset check — templates/harness/config.yaml ⊆ config.reference.yaml
// ---------------------------------------------------------------------------

describe("harness config subset of reference", () => {
  const FREEFORM_CHILDREN = new Set([
    "triggers",
    "notifications.topics",
    "notifications.priorities",
  ]);
  const WILDCARD_MAP_PATHS = new Set(["adapters"]);
  const root = join(import.meta.dir, "..");

  test("every harness key is present in config.reference.yaml", async () => {
    const YAML = (await import("yaml")).default;
    const harness = YAML.parse(
      readFileSync(join(root, "templates", "harness", "config.yaml"), "utf-8"),
    );
    const reference = YAML.parse(
      readFileSync(join(root, "templates", "config.reference.yaml"), "utf-8"),
    );
    const harnessPaths = flattenYamlPaths(
      harness, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS,
    );
    const refPaths = flattenYamlPaths(
      reference, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS,
    );
    const extras = [...harnessPaths].filter((p) => !refPaths.has(p)).sort();
    expect(extras).toEqual([]);
  });

  test("subset check flags a fabricated extra harness key", () => {
    const harnessObj = {
      state_repo: "x",
      adapters: { "agent-claude": { enabled: true, bogus_extra: 1 } },
    };
    const refObj = {
      state_repo: "x",
      adapters: { "agent-claude": { enabled: true } },
    };
    const hp = flattenYamlPaths(harnessObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS);
    const rp = flattenYamlPaths(refObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS);
    const extras = [...hp].filter((p) => !rp.has(p)).sort();
    expect(extras).toEqual(["adapters.*.bogus_extra"]);
  });

  test("allows harness entries under an empty reference array", () => {
    // Reference declares `cluster.machines: []` — no `.*` children are
    // enumerated, but a valid harness entry underneath should be accepted.
    const harnessObj = {
      cluster: { machines: [{ name: "desktop", host: "desktop.local" }] },
    };
    const refObj = {
      cluster: { machines: [] },
    };
    const hp = flattenYamlPaths(harnessObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS);
    const rp = flattenYamlPaths(refObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS);
    const refArrays = collectArrayPaths(refObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS);

    const isUnderRefArray = (p: string): boolean => {
      for (const arr of refArrays) {
        const wp = arr ? `${arr}.*` : "*";
        if (p === wp || p.startsWith(`${wp}.`)) return true;
      }
      return false;
    };
    const extras = [...hp].filter((p) => !rp.has(p) && !isUnderRefArray(p));
    expect(extras).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Floor-count guard for extractMagPathsFromSource (gh-ludics-406)
//
// Mirrors the meta-test pattern in scripts/lint-template-safety.test.ts (the
// "expected size for the current result literal" sanity check). The extractor
// has no second source of truth to assert equality against, so we use a floor
// instead of equality. Failure here means **either**:
//   (a) a DRY refactor collapsed call sites — add a regex / register the new
//       helper in extractMagPathsFromSource, then re-run this test;
//   (b) keys were intentionally removed — lower the floor and note what
//       moved in this comment.
// Today the extractor finds 15 keys; the floor is set to 10 with slack so
// single-key removal does not trip the lint.
// ---------------------------------------------------------------------------

describe("extractMagPathsFromSource floor count", () => {
  test("real src/ yields at least 10 mag.* paths (silent-drift guard)", () => {
    const repoRoot = join(import.meta.dir, "..");
    const set = extractMagPathsFromSource(join(repoRoot, "src"));
    expect(set.size).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Integration test — run the full lint script
// ---------------------------------------------------------------------------

describe("integration", () => {
  test("lint-config-reference exits 0 on current repo", () => {
    const result = spawnSync({
      cmd: ["bun", "run", join(import.meta.dir, "lint-config-reference.ts")],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      console.error(result.stderr.toString());
    }
    expect(result.exitCode).toBe(0);
  });

  test("lint-config-reference exits 1 when harness has an extra key", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");

    const repoRoot = join(import.meta.dir, "..");
    const tmp = mkdtempSync(join(tmpdir(), "ludics-lint-harness-"));
    try {
      // Start from the real harness and append an extra top-level key.
      const harnessFixture = join(tmp, "harness-with-extra.yaml");
      const original = readFileSync(
        join(repoRoot, "templates", "harness", "config.yaml"), "utf-8",
      );
      writeFileSync(harnessFixture, original + "\nbogus_harness_only_key: true\n");

      // Run the real script in the real repo (deps resolve) but override
      // the harness path via env var so it reads our fixture.
      const result = spawnSync({
        cmd: ["bun", "run", join(repoRoot, "scripts", "lint-config-reference.ts")],
        cwd: repoRoot,
        env: { ...process.env, LUDICS_HARNESS_CONFIG_PATH: harnessFixture },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(1);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("templates/harness/config.yaml has keys not in");
      expect(stderr).toContain("bogus_harness_only_key");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
