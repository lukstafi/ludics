# Config & docs drift detection

## Goal

Reference files (`templates/config.reference.yaml`, README CLI reference) can silently
fall out of sync with implementation when config keys or CLI commands change. The existing
`lint:cli-readme` CI check already catches CLI/README drift. This task extends the same
pattern to catch config schema drift, and adds lightweight skill-level reminders so
agent workers check documentation when touching config or CLI code.

GitHub issue: https://github.com/lukstafi/ludics/issues/203

## Acceptance Criteria

1. A new CI lint script detects when `config.reference.yaml` is missing keys that exist
   in the `LudicsFullConfig` TypeScript interface (or its nested interfaces), and when
   the reference YAML contains top-level/nested keys absent from the interface. The check
   exits non-zero on drift, failing CI.
2. The lint correctly excludes freeform-children paths (`triggers`, `notifications.topics`,
   `notifications.priorities`) where user-defined keys are expected.
3. The lint is wired into CI (`.github/workflows/ci.yml`) and `package.json` scripts,
   following the `lint:cli-readme` pattern.
4. Coder and reviewer orchestration skills include a reminder to check
   `config.reference.yaml` and README when changing config schemas or CLI commands.

## Context

### Existing infrastructure

- **`scripts/lint-cli-readme.ts`** -- CI lint that parses the README CLI Reference section
  and cross-checks against the `USAGE` constant in `src/index.ts`. Runs via
  `bun run lint:cli-readme` in CI. This is the pattern to follow.

- **`src/config.ts`** -- Contains `LudicsFullConfig` interface (lines 58-86),
  `ProjectConfig` interface (lines 15-55), `AdapterConfigEntry` interface (lines 9-13),
  `validateConfigKeys()` (lines 153-178), `FREEFORM_CHILDREN` set (lines 145-149),
  and `loadReferenceConfig()` (lines 182-197). The runtime validator catches user typos
  (unknown keys in user config) but does NOT catch the reverse (code adds keys that
  reference YAML lacks).

- **`templates/config.reference.yaml`** -- 292-line exhaustive reference with all
  defaults and comments.

- **`.github/workflows/ci.yml`** -- CI pipeline already runs type check, build,
  `lint:cli-readme`, and `lint:no-mock-module`.

### Key considerations

- The `mag` section is typed as `Record<string, unknown>` in the TS interface but is
  fully specified in the reference YAML. The lint should extract the concrete keys from
  the reference YAML for `mag` subsections rather than stopping at the opaque TS type.
- `FREEFORM_CHILDREN` paths have user-defined keys and must be excluded.
- The `network` key exists in the TS interface but may be absent from reference YAML
  (legacy/deprecated) -- the lint should flag this as drift.
- Worktree copies of config.reference.yaml should be ignored (only lint the canonical
  `templates/config.reference.yaml`).

### Skill files to update

- `skills/orchestration/pair-coder-work.md` -- coder work instructions
- `skills/orchestration/pair-reviewer-review.md` -- reviewer review instructions

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

Create `scripts/lint-config-reference.ts` that:
1. Parses the `LudicsFullConfig`, `ProjectConfig`, and `AdapterConfigEntry` interfaces
   from `src/config.ts` using regex extraction (matching the low-dependency style of
   `lint-cli-readme.ts` -- no AST parser needed).
2. Parses `templates/config.reference.yaml` using the `yaml` package (already a
   dependency).
3. Compares the key-path sets bidirectionally, skipping `FREEFORM_CHILDREN` paths.
4. Reports mismatches and exits non-zero on drift.

Wire it as `lint:config-reference` in `package.json` and add a CI step.

For the skill reminders, add a short checklist item in the coder and reviewer skill
documents noting that changes to config types or CLI commands should include corresponding
updates to `config.reference.yaml` and/or README.

## Scope

**In scope:**
- New lint script for config reference vs. TypeScript interface drift
- CI integration
- Skill-level documentation reminders for coder/reviewer agents

**Out of scope:**
- Runtime validation changes (existing `validateConfigKeys` is fine as-is)
- Automated config.reference.yaml generation/templating
- Deeper static analysis of config key access patterns in source code (approach C from
  elaboration -- too fragile for the value)
