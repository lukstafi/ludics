import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractInterfaceBody,
  parseFieldDeclarations,
  extractInterfacePaths,
  flattenYamlPaths,
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
});
