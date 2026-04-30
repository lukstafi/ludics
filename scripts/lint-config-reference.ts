#!/usr/bin/env bun
/**
 * lint-config-reference.ts
 *
 * CI lint: bidirectional drift detection between config.reference.yaml
 * and the TypeScript interfaces in src/config.ts, plus a subset check
 * that templates/harness/config.yaml contains only keys present in the
 * reference YAML.
 *
 * Exit code:
 *   0 — no drift (config reference is in sync with TypeScript interfaces
 *       and harness config is a subset of the reference)
 *   1 — drift detected (mismatches in either direction, or harness has
 *       keys not present in the reference)
 */

import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  extractInterfacePaths,
  extractMagPathsFromSource,
  flattenYamlPaths,
  collectArrayPaths,
  comparePaths,
} from "./lint-config-helpers.ts";

export interface RunLintResult {
  exitCode: number;
  /** TS-interface paths missing from the reference YAML. */
  missingFromYaml: string[];
  /** YAML paths missing from the TS interface. */
  missingFromTs: string[];
  /** Harness paths not present in the reference YAML. */
  harnessExtras: string[];
}

/**
 * Run the bidirectional drift check against an arbitrary repo root. Reads
 * `<root>/templates/config.reference.yaml`, `<root>/src/config.ts`, and
 * `<root>/templates/harness/config.yaml` (the harness path remains overridable
 * via the `LUDICS_HARNESS_CONFIG_PATH` env var so tests can point at a
 * fabricated fixture without duplicating the rest of the repo).
 *
 * Carries forward the env-var carve-out from the previous CLI block —
 * `staleThresholdSeconds` is computed from an env var, not the config YAML —
 * and the FREEFORM_CHILDREN / WILDCARD_MAP_PATHS sets unchanged.
 */
export function runLint(root: string): RunLintResult {
  // 1. Parse TS interfaces from src/config.ts
  const configSource = readFileSync(join(root, "src", "config.ts"), "utf-8");
  const knownInterfaces = new Set(["ProjectConfig", "AdapterConfigEntry"]);
  const { paths: tsInterfacePaths, opaquePaths } = extractInterfacePaths(
    configSource, "LudicsFullConfig", knownInterfaces,
  );

  // 2. Extract first-level mag paths from source code grep
  const magPaths = extractMagPathsFromSource(join(root, "src"));

  // 3. Build unified TS path set
  const tsPaths = new Set([...tsInterfacePaths, ...magPaths]);
  // staleThresholdSeconds is computed from env var, not from config YAML
  tsPaths.delete("staleThresholdSeconds");

  // 4. Parse reference YAML
  const yamlText = readFileSync(
    join(root, "templates", "config.reference.yaml"), "utf-8",
  );
  const yamlObj = YAML.parse(yamlText);

  const FREEFORM_CHILDREN = new Set([
    "triggers",
    "notifications.topics",
    "notifications.priorities",
  ]);
  const WILDCARD_MAP_PATHS = new Set(["adapters"]);

  const yamlPaths = flattenYamlPaths(yamlObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS);

  // 5. Filter YAML paths for Direction 2 comparison
  //    - Skip mag deep paths (mag.X.Y) — YAML-authoritative for mag subtree structure
  //    - Skip children of opaque TS paths (except mag, which is handled via source grep)
  const filteredOpaquePaths = new Set(opaquePaths);
  filteredOpaquePaths.delete("mag");       // handled via source grep
  filteredOpaquePaths.delete("triggers");  // handled by FREEFORM_CHILDREN

  const yamlCheckPaths = new Set<string>();
  for (const p of yamlPaths) {
    // Skip mag deep paths (mag.X.Y where Y has additional nesting)
    if (p.startsWith("mag.") && p.slice(4).includes(".")) continue;
    // Skip children of opaque TS paths
    let underOpaque = false;
    for (const op of filteredOpaquePaths) {
      if (p.startsWith(op + ".")) { underOpaque = true; break; }
    }
    if (underOpaque) continue;
    yamlCheckPaths.add(p);
  }

  // 6. Compare
  const { missingFromYaml, missingFromTs } = comparePaths(tsPaths, yamlCheckPaths);

  // 7. Direction 3: templates/harness/config.yaml must be a subset of
  //    config.reference.yaml keys. The harness config is a sparse user-facing
  //    example and only needs to contain keys that exist in the reference.
  //
  //    The harness file path is overridable via LUDICS_HARNESS_CONFIG_PATH so
  //    tests can point at a fabricated fixture without duplicating the rest
  //    of the repo (and its node_modules) into a tmp directory.
  const harnessPath =
    process.env.LUDICS_HARNESS_CONFIG_PATH ||
    join(root, "templates", "harness", "config.yaml");
  const harnessText = readFileSync(harnessPath, "utf-8");
  const harnessObj = YAML.parse(harnessText);
  const harnessPaths = flattenYamlPaths(
    harnessObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS,
  );

  // Reference arrays (including empty ones like `cluster.machines: []`) have
  // no enumerable `.*` child paths, but a valid harness entry beneath them
  // should still be accepted. Collect the array-valued paths in the reference
  // and allow any harness path whose prefix extends one of them via `.*`.
  const refArrayPaths = collectArrayPaths(
    yamlObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS,
  );
  const isUnderRefArray = (p: string): boolean => {
    for (const arr of refArrayPaths) {
      const wildcardPrefix = arr ? `${arr}.*` : "*";
      if (p === wildcardPrefix || p.startsWith(`${wildcardPrefix}.`)) return true;
    }
    return false;
  };

  const harnessExtras: string[] = [];
  for (const p of harnessPaths) {
    if (yamlPaths.has(p)) continue;
    if (isUnderRefArray(p)) continue;
    harnessExtras.push(p);
  }
  harnessExtras.sort();

  const errors =
    missingFromYaml.length + missingFromTs.length + harnessExtras.length;

  return {
    exitCode: errors > 0 ? 1 : 0,
    missingFromYaml,
    missingFromTs,
    harnessExtras,
  };
}

if (import.meta.main) {
  // Optional first positional arg overrides the root directory, which lets
  // tests exercise the real CLI exit-code paths against a tmp fixture.
  const argRoot = process.argv[2];
  const root = argRoot ? argRoot : join(import.meta.dir, "..");
  const result = runLint(root);

  if (result.missingFromYaml.length > 0) {
    console.error(
      "\n❌  TypeScript interface has keys not documented in config.reference.yaml:",
    );
    for (const p of result.missingFromYaml) {
      console.error(`     - ${p}`);
    }
  }

  if (result.missingFromTs.length > 0) {
    console.error(
      "\n❌  config.reference.yaml has keys not in TypeScript interface:",
    );
    for (const p of result.missingFromTs) {
      console.error(`     - ${p}`);
    }
  }

  if (result.harnessExtras.length > 0) {
    console.error(
      "\n❌  templates/harness/config.yaml has keys not in config.reference.yaml:",
    );
    for (const p of result.harnessExtras) {
      console.error(`     - ${p}`);
    }
  }

  if (result.exitCode === 0) {
    console.log(
      "✅  Config reference is in sync with TypeScript interfaces, and " +
        "harness config is a subset of the reference.",
    );
  }

  process.exit(result.exitCode);
}
