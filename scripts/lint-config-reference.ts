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
  comparePaths,
} from "./lint-config-helpers.ts";

if (import.meta.main) {
  const root = join(import.meta.dir, "..");

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

  // 7. Report
  let errors = 0;

  if (missingFromYaml.length > 0) {
    console.error(
      "\n❌  TypeScript interface has keys not documented in config.reference.yaml:",
    );
    for (const p of missingFromYaml) {
      console.error(`     - ${p}`);
    }
    errors += missingFromYaml.length;
  }

  if (missingFromTs.length > 0) {
    console.error(
      "\n❌  config.reference.yaml has keys not in TypeScript interface:",
    );
    for (const p of missingFromTs) {
      console.error(`     - ${p}`);
    }
    errors += missingFromTs.length;
  }

  // 8. Direction 3: templates/harness/config.yaml must be a subset of
  //    config.reference.yaml keys. The harness config is a sparse user-facing
  //    example and only needs to contain keys that exist in the reference.
  const harnessPath = join(root, "templates", "harness", "config.yaml");
  const harnessText = readFileSync(harnessPath, "utf-8");
  const harnessObj = YAML.parse(harnessText);
  const harnessPaths = flattenYamlPaths(
    harnessObj, "", FREEFORM_CHILDREN, WILDCARD_MAP_PATHS,
  );

  const harnessExtras: string[] = [];
  for (const p of harnessPaths) {
    if (!yamlPaths.has(p)) harnessExtras.push(p);
  }
  harnessExtras.sort();

  if (harnessExtras.length > 0) {
    console.error(
      "\n❌  templates/harness/config.yaml has keys not in config.reference.yaml:",
    );
    for (const p of harnessExtras) {
      console.error(`     - ${p}`);
    }
    errors += harnessExtras.length;
  }

  if (errors === 0) {
    console.log(
      "✅  Config reference is in sync with TypeScript interfaces, and " +
        "harness config is a subset of the reference.",
    );
  }

  process.exit(errors > 0 ? 1 : 0);
}
