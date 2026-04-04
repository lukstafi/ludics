# Add `ludics config proposals-path <project>` CLI subcommand

## Goal

Expose a programmatic way to resolve the proposals directory for any project, replacing the inline resolution logic currently embedded in skill Markdown instructions. This adds a `resolveProposalsPath()` utility function and a `config` CLI command group with `proposals-path` as its first subcommand.

## Acceptance Criteria

1. `resolveProposalsPath(projectDir: string, configuredPath?: string): string` is exported from `src/config.ts`.
2. When `configuredPath` is provided, returns `join(projectDir, configuredPath)`.
3. When `configuredPath` is omitted, probes `docs/`, `doc/`, `.docs/` under `projectDir`; returns the first existing directory with `/proposals` appended. Falls back to `join(projectDir, "docs", "proposals")`.
4. `ludics config proposals-path <project>` prints the absolute proposals directory path to stdout and exits 0.
5. If the project name is unknown or cannot be resolved, exits non-zero with a clear error message.
6. The `config` command is wired into `MIGRATED_COMMANDS` in `src/index.ts` for easy extension with future config subcommands.
7. The USAGE string includes a `config proposals-path <project>` entry.
8. All existing tests pass.

## Context

### `proposals_path` field

Already exists on `ProjectConfig` (line 33 of `src/config.ts`) and is documented in `templates/config.reference.yaml`. Currently only consumed by the `ludics-draft-proposal` skill Markdown -- no TypeScript code reads it.

### Project resolution

`resolveProjectPath(projectName)` at line 334 of `src/config.ts` handles name matching (by `name` field or repo tail) and path resolution (config `path` field, then `~/name`, `~/repos/name` fallbacks). Returns `""` on failure.

### CLI structure

`src/index.ts` uses a flat `MIGRATED_COMMANDS` record mapping command names to `async (args) => void` handlers. Multi-level subcommands (e.g., `state pull`, `journal recent`) are dispatched inside each handler. The `config` command will follow this same pattern.

### No existing `config` command

There is no `config` entry in `MIGRATED_COMMANDS` today. This task establishes the pattern for future config-query subcommands.

## Approach

### 1. Add `resolveProposalsPath()` to `src/config.ts`

Insert after `resolveProjectPath()` (after line 380):

```typescript
/**
 * Resolve the absolute proposals directory for a project.
 * Uses configuredPath (relative to projectDir) if provided.
 * Otherwise probes docs/, doc/, .docs/ and appends proposals/.
 * Falls back to docs/proposals/.
 */
export function resolveProposalsPath(projectDir: string, configuredPath?: string): string {
  if (configuredPath) return join(projectDir, configuredPath);
  for (const candidate of ["docs", "doc", ".docs"]) {
    if (existsSync(join(projectDir, candidate))) {
      return join(projectDir, candidate, "proposals");
    }
  }
  return join(projectDir, "docs", "proposals");
}
```

### 2. Add `config` command handler to `src/index.ts`

Add a `config` entry to `MIGRATED_COMMANDS` (inline, similar to the `state` and `journal` handlers):

```typescript
config: async (args) => {
  const sub = args[0] ?? "";
  if (sub === "proposals-path") {
    const project = args[1];
    if (!project) {
      console.error("usage: ludics config proposals-path <project>");
      process.exit(1);
    }
    const { resolveProjectPath, resolveProposalsPath, loadConfigSync } = await import("./config.ts");
    const projectDir = resolveProjectPath(project);
    if (!projectDir) {
      console.error(`project not found: ${project}`);
      process.exit(1);
    }
    const cfg = loadConfigSync();
    const projCfg = (cfg.projects ?? []).find(
      (p: any) => String(p.name ?? "").toLowerCase() === project.toLowerCase()
    );
    console.log(resolveProposalsPath(projectDir, projCfg?.proposals_path));
  } else {
    console.error(`unknown config subcommand: ${sub} (available: proposals-path)`);
    process.exit(1);
  }
},
```

### 3. Update USAGE string

Add after the `quote` line:

```
  config proposals-path <project>
                               Print resolved proposals directory path for a project
```

## Scope

**In scope:**
- `src/config.ts`: add `resolveProposalsPath()` function
- `src/index.ts`: add `config` command handler and USAGE entry
- Verify existing tests pass

**Out of scope:**
- Unit tests for `resolveProposalsPath()` (optional, not required)
- Refactoring skill Markdown to call the CLI (separate task)
- Creating the proposals directory if it doesn't exist (callers handle this)
