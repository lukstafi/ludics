// Import-safe helpers for the top-level command dispatcher in src/index.ts.
//
// Extracted so tests and the CLI-subcommand drift lint
// (scripts/lint-cli-subcommands.ts) can import without side-effecting `main()`
// execution. src/index.ts has an unguarded `main().catch(...)` at the bottom
// of the file; importing it for the helper alone would run the CLI.
//
// This module must remain side-effect-free: no top-level statements, no
// imports from src/index.ts, and no module-level work beyond declarations.

const TOP_LEVEL_ALIASES = new Set<string>(["orchestration"]);

export const TOP_LEVEL_ALIAS_NAMES: ReadonlySet<string> = TOP_LEVEL_ALIASES;

export function formatUnknownTopLevel(
  cmd: string,
  knownCommands: ReadonlyArray<string>,
): string {
  const canonical = knownCommands
    .filter((k) => !TOP_LEVEL_ALIASES.has(k))
    .slice()
    .sort();
  return `unknown ludics command: ${cmd} (use: ${canonical.join(", ")})`;
}
