/**
 * lint-config-helpers.ts
 *
 * Reusable helpers for config-reference drift detection.
 * Import-safe: no top-level execution.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// TS Interface Parsing
// ---------------------------------------------------------------------------

/** Extract the body of a named interface from TypeScript source (brace-counting). */
export function extractInterfaceBody(source: string, name: string): string | null {
  const re = new RegExp(`\\binterface\\s+${name}\\s*\\{`);
  const match = re.exec(source);
  if (!match) return null;

  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;

  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    if (depth > 0) i++;
  }

  return source.slice(start, i);
}

/** Parse field declarations from an interface body string. */
export function parseFieldDeclarations(
  body: string,
): Array<{ name: string; typeExpr: string }> {
  const cleaned = body
    .replace(/\/\*\*[\s\S]*?\*\//g, "") // JSDoc
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/\/\/.*$/gm, "");          // line comments

  const fields: Array<{ name: string; typeExpr: string }> = [];
  let i = 0;

  while (i < cleaned.length) {
    while (i < cleaned.length && /\s/.test(cleaned[i])) i++;
    if (i >= cleaned.length) break;

    const rest = cleaned.slice(i);
    const fieldMatch = rest.match(/^(\w+)\??\s*:\s*/);
    if (!fieldMatch) { i++; continue; }

    const name = fieldMatch[1];
    i += fieldMatch[0].length;

    // Extract type expression until `;` at depth 0
    let depth = 0;
    const typeStart = i;
    while (i < cleaned.length) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") depth--;
      else if (cleaned[i] === ";" && depth === 0) break;
      i++;
    }

    const typeExpr = cleaned.slice(typeStart, i).trim();
    fields.push({ name, typeExpr });
    i++; // skip ';'
  }

  return fields;
}

export interface ExtractResult {
  /** All dotted key paths derived from the interface. */
  paths: Set<string>;
  /** Paths with opaque TS types (Record<string, unknown> etc.) — children not modeled. */
  opaquePaths: Set<string>;
}

/**
 * Build dotted key paths from a named TypeScript interface, recursively
 * expanding inline objects, named interface references, arrays, and Records.
 */
export function extractInterfacePaths(
  source: string,
  rootInterface: string,
  knownInterfaces: Set<string>,
  prefix: string = "",
): ExtractResult {
  const body = extractInterfaceBody(source, rootInterface);
  if (!body) return { paths: new Set(), opaquePaths: new Set() };
  return extractPathsFromBody(body, source, knownInterfaces, prefix);
}

function extractPathsFromBody(
  body: string,
  source: string,
  knownInterfaces: Set<string>,
  prefix: string,
): ExtractResult {
  const paths = new Set<string>();
  const opaquePaths = new Set<string>();
  const fields = parseFieldDeclarations(body);

  for (const { name, typeExpr } of fields) {
    const fullPath = prefix ? `${prefix}.${name}` : name;
    paths.add(fullPath);

    const trimmed = typeExpr.trim();

    // Inline object: { ... }
    if (trimmed.startsWith("{")) {
      const lastBrace = trimmed.lastIndexOf("}");
      const innerBody = trimmed.slice(1, lastBrace);
      const child = extractPathsFromBody(innerBody, source, knownInterfaces, fullPath);
      for (const p of child.paths) paths.add(p);
      for (const p of child.opaquePaths) opaquePaths.add(p);
      continue;
    }

    // Array<Record<string, unknown>> → opaque array
    if (/^Array<Record<string,\s*unknown>>$/.test(trimmed)) {
      opaquePaths.add(fullPath);
      continue;
    }

    // SomeInterface[] → array of known interface
    const arrBracketMatch = trimmed.match(/^(\w+)\[\]$/);
    if (arrBracketMatch && knownInterfaces.has(arrBracketMatch[1])) {
      const wc = `${fullPath}.*`;
      paths.add(wc);
      const child = extractInterfacePaths(source, arrBracketMatch[1], knownInterfaces, wc);
      for (const p of child.paths) paths.add(p);
      for (const p of child.opaquePaths) opaquePaths.add(p);
      continue;
    }

    // Array<SomeInterface>
    const arrAngleMatch = trimmed.match(/^Array<(\w+)>$/);
    if (arrAngleMatch && knownInterfaces.has(arrAngleMatch[1])) {
      const wc = `${fullPath}.*`;
      paths.add(wc);
      const child = extractInterfacePaths(source, arrAngleMatch[1], knownInterfaces, wc);
      for (const p of child.paths) paths.add(p);
      for (const p of child.opaquePaths) opaquePaths.add(p);
      continue;
    }

    // Record<string, KnownInterface> → typed record
    const recordMatch = trimmed.match(/^Record<string,\s*(\w+)>$/);
    if (recordMatch) {
      if (knownInterfaces.has(recordMatch[1])) {
        const wc = `${fullPath}.*`;
        paths.add(wc);
        const child = extractInterfacePaths(source, recordMatch[1], knownInterfaces, wc);
        for (const p of child.paths) paths.add(p);
        for (const p of child.opaquePaths) opaquePaths.add(p);
      } else {
        // Record<string, unknown/string/number> → opaque
        opaquePaths.add(fullPath);
      }
      continue;
    }

    // Other Record<...> → opaque (complex value types)
    if (trimmed.startsWith("Record<")) {
      opaquePaths.add(fullPath);
      continue;
    }

    // Default: leaf (simple types, type aliases, unions, etc.)
  }

  return { paths, opaquePaths };
}

// ---------------------------------------------------------------------------
// Mag Source Grep
// ---------------------------------------------------------------------------

// SILENT-DRIFT WARNING (gh-ludics-406):
// `extractMagPathsFromSource` is a regex-over-source extractor. Its safety
// claim — "every mag config key reachable from src/ is documented" — depends
// on the literal access patterns below appearing at the call sites. A
// "DRY-only" refactor that wraps any of these patterns behind a new helper,
// table, or loop *deletes* the literals from source. The regex still runs,
// just with fewer hits, and the lint passes silently with reduced coverage.
//
// If you introduce a new helper that reads `mag?.<key>` (or sibling), add a
// matching regex pattern below AND keep the floor-count test in
// scripts/lint-config-helpers.test.ts ("extractMagPathsFromSource: floor
// count of N keys") in sync. The floor-count test is the mechanical guard
// that catches the next instance of this silent-drift class.
//
// Recognised patterns (mirror in the test's failure-mode comment):
//   - mag?.property                              (local variable after cast)
//   - magXxx?.property                           (e.g. magConfig?.x)
//   - (config.mag as ...)?.property              (inline cast)
//   - config.mag?.property                       (direct optional chaining)
//   - magSecondsConfig("property", ...)          (shared *_seconds helper)

/**
 * Extract first-level mag property names accessed in source code.
 * Scans .ts files for mag config access patterns:
 *   - mag?.property (local variable after cast)
 *   - magXxx?.property (alternative variable names like magConfig, magCfg)
 *   - (config.mag as ...)?.property (inline cast)
 *   - config.mag?.property (direct optional chaining)
 *   - magSecondsConfig("property", ...) (shared helper for *_seconds keys)
 */
export function extractMagPathsFromSource(sourceDir: string): Set<string> {
  const magProps = new Set<string>();

  // Pattern 1: mag?.prop or config.mag?.prop
  const p1 = /\bmag\?\.(\w+)/g;
  // Pattern 2: magXxx?.prop (alternative variable names like magConfig, magCfg)
  const p2 = /\bmag[A-Z]\w*\?\.(\w+)/g;
  // Pattern 3: (config.mag as Type)?.prop (inline cast)
  const p3 = /\.mag\b[^;]*?\)\?\.(\w+)/g;
  // Pattern 4: magSecondsConfig("prop", ...) — shared helper that reads
  // mag?.[key] dynamically, so the literal key only appears in the call site.
  const p4 = /\bmagSecondsConfig\(\s*["'`](\w+)["'`]/g;

  function scanDir(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          scanDir(full);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
          const content = readFileSync(full, "utf-8");
          for (const pattern of [p1, p2, p3, p4]) {
            pattern.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(content)) !== null) {
              magProps.add(m[1]);
            }
          }
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  scanDir(sourceDir);
  return new Set([...magProps].map((prop) => `mag.${prop}`));
}

// ---------------------------------------------------------------------------
// YAML Flattener
// ---------------------------------------------------------------------------

/**
 * Flatten a parsed YAML object into dotted key paths.
 * - Arrays: walk first element with `*` wildcard.
 * - wildcardMapPaths: normalize user-defined map keys to `*`.
 * - skipPaths: stop recursion at freeform/opaque subtrees.
 */
export function flattenYamlPaths(
  obj: unknown,
  prefix: string,
  skipPaths: Set<string>,
  wildcardMapPaths: Set<string>,
): Set<string> {
  const paths = new Set<string>();
  if (prefix) paths.add(prefix);

  if (skipPaths.has(prefix)) return paths;

  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
      const childPrefix = prefix ? `${prefix}.*` : "*";
      for (const p of flattenYamlPaths(obj[0], childPrefix, skipPaths, wildcardMapPaths)) {
        paths.add(p);
      }
    }
    return paths;
  }

  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (wildcardMapPaths.has(prefix)) {
      // User-defined map keys: merge all entries under *
      const merged: Record<string, unknown> = {};
      for (const val of Object.values(rec)) {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          Object.assign(merged, val as Record<string, unknown>);
        }
      }
      const childPrefix = prefix ? `${prefix}.*` : "*";
      for (const p of flattenYamlPaths(merged, childPrefix, skipPaths, wildcardMapPaths)) {
        paths.add(p);
      }
    } else {
      for (const [key, val] of Object.entries(rec)) {
        const childPath = prefix ? `${prefix}.${key}` : key;
        for (const p of flattenYamlPaths(val, childPath, skipPaths, wildcardMapPaths)) {
          paths.add(p);
        }
      }
    }
  }

  return paths;
}

/**
 * Collect dotted key paths whose value in the YAML object is an array
 * (including empty arrays). Uses the same `skipPaths` / `wildcardMapPaths`
 * conventions as `flattenYamlPaths` so wildcards line up. Useful for the
 * harness-subset check: the reference may declare an array with no items
 * (e.g. `cluster.machines: []`), and a valid harness entry under it should
 * not be reported as an extra key.
 */
export function collectArrayPaths(
  obj: unknown,
  prefix: string,
  skipPaths: Set<string>,
  wildcardMapPaths: Set<string>,
): Set<string> {
  const out = new Set<string>();
  walk(obj, prefix);
  return out;

  function walk(node: unknown, path: string): void {
    if (skipPaths.has(path)) return;
    if (Array.isArray(node)) {
      out.add(path);
      if (node.length > 0 && typeof node[0] === "object" && node[0] !== null) {
        walk(node[0], path ? `${path}.*` : "*");
      }
      return;
    }
    if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (wildcardMapPaths.has(path)) {
        const merged: Record<string, unknown> = {};
        for (const v of Object.values(rec)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            Object.assign(merged, v as Record<string, unknown>);
          }
        }
        walk(merged, path ? `${path}.*` : "*");
      } else {
        for (const [k, v] of Object.entries(rec)) {
          walk(v, path ? `${path}.${k}` : k);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Bidirectional set comparison. */
export function comparePaths(
  tsPaths: Set<string>,
  yamlPaths: Set<string>,
): { missingFromYaml: string[]; missingFromTs: string[] } {
  const missingFromYaml: string[] = [];
  const missingFromTs: string[] = [];

  for (const p of tsPaths) {
    if (!yamlPaths.has(p)) missingFromYaml.push(p);
  }
  for (const p of yamlPaths) {
    if (!tsPaths.has(p)) missingFromTs.push(p);
  }

  return {
    missingFromYaml: missingFromYaml.sort(),
    missingFromTs: missingFromTs.sort(),
  };
}
