// Latest-within-class default-model resolution for orchestration (task-c48b7beb).
//
// The per-class "latest" mapping is the SINGLE SOURCE OF TRUTH in the global
// config file under `mag.orchestration.model_classes` — NOT a hardcoded
// constant. The resolver below reads that table and THROWS LOUDLY when a
// tracked class is missing, blank, or non-string, so staleness /
// misconfiguration surfaces immediately (before any orchestration side
// effect) rather than silently running a stale pin.
//
// HOW TO BUMP: when a new minor ships, edit the value in `config.yaml`
// (`mag.orchestration.model_classes.<class>`). That is a config edit, not a
// code change — see templates/config.reference.yaml for the documented table.

/** The model classes resolved from `mag.orchestration.model_classes`. Provider
 *  is NOT class: `claude-code` resolves to `claude-opus` (medium/large coder)
 *  or `claude-sonnet` (tiny/small coder + the generic claude default). */
export const TRACKED_MODEL_CLASSES = ["codex", "claude-opus", "claude-sonnet"] as const;
export type ModelClass = (typeof TRACKED_MODEL_CLASSES)[number];

/**
 * Resolve the latest-within-class model for `cls` from the
 * `mag.orchestration.model_classes` table. Throws a clear, actionable error
 * naming the full config key when the table is absent, the class key is
 * missing, or the value is non-string / blank / whitespace-only.
 *
 * The throw is deliberate (AC3): the config table is the single source of
 * truth, so an unset tracked class is a configuration error that must fail
 * loudly, never a silent fallback to a built-in default (which would
 * reintroduce the staleness this task removes).
 *
 * @param table the parsed `mag.orchestration.model_classes` object (i.e.
 *              `orchCfg?.model_classes`), or undefined when absent.
 */
export function resolveModelClass(
  table: Record<string, unknown> | undefined,
  cls: ModelClass,
): string {
  const v = table?.[cls];
  if (typeof v === "string" && v.trim()) return v.trim();
  throw new Error(
    `mag.orchestration.model_classes.${cls} is required — set the latest ${cls} ` +
      `model in config.yaml (see templates/config.reference.yaml).`,
  );
}

/**
 * Map a provider to its default model class when no explicit model is given.
 * `codex` → `codex`; everything else (`claude-code`) → `claude-sonnet`, the
 * generic claude default. Effort-specific Opus selection for `claude-code`
 * coders happens earlier, in `selectOrchestrationFlags`.
 */
export function classForProvider(provider: string): ModelClass {
  return provider === "codex" ? "codex" : "claude-sonnet";
}
