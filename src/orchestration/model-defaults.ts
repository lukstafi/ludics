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
 *  is NOT class: `claude-code` resolves to its high-end class (`claude-opus` by
 *  default, or `claude-fable` when selected per role) for medium/large effort, or
 *  `claude-sonnet` (tiny/small coder + the generic claude default). `claude-fable`
 *  is a *selectable high-end model class* (task-13dee93b), NOT a new provider —
 *  it runs on the same `claude-code` provider / `claudeAgent` runner as Opus. */
export const TRACKED_MODEL_CLASSES = ["codex", "claude-opus", "claude-sonnet", "claude-fable"] as const;
export type ModelClass = (typeof TRACKED_MODEL_CLASSES)[number];

/** The two Claude classes a user may pick as a role's high-end (medium/large
 *  effort) model. A strict subset of {@link TRACKED_MODEL_CLASSES}; the default
 *  is `claude-opus` (preserves pre-task-13dee93b behaviour). */
export const HIGH_END_CLAUDE_CLASSES = ["claude-opus", "claude-fable"] as const;
export type HighEndClass = (typeof HIGH_END_CLAUDE_CLASSES)[number];

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

// ---------------------------------------------------------------------------
// Per-role high-end class selection + Fable-unavailable handling (task-13dee93b)
// ---------------------------------------------------------------------------

/**
 * Normalize a per-role high-end class config value (`mag.orchestration.coder_class`
 * / `reviewer_class`) into a {@link HighEndClass}. FORGIVING by contract (AC3 of
 * task-13dee93b): missing / blank / non-string / unrecognised values resolve to
 * `claude-opus` (preserving today's behaviour), warning on a recognisably-wrong
 * non-empty string. This deliberately does NOT throw — the hard throw is reserved
 * for an unset tracked class in `resolveModelClass`.
 */
export function normalizeHighEndClass(value: unknown): HighEndClass {
  if (typeof value === "string") {
    const v = value.trim();
    if (v === "claude-fable") return "claude-fable";
    if (v === "claude-opus" || v === "") return "claude-opus";
    console.error(
      `ludics: orchestration: ignoring unknown high-end class ${JSON.stringify(value)}; ` +
        `expected "claude-opus" or "claude-fable" — falling back to claude-opus.`,
    );
    return "claude-opus";
  }
  if (value != null) {
    console.error(
      `ludics: orchestration: ignoring non-string high-end class ${JSON.stringify(value)}; ` +
        `falling back to claude-opus.`,
    );
  }
  return "claude-opus";
}

/**
 * True when `model` is the Fable class model. Compares against the resolved
 * `model_classes.claude-fable` from `orchCfg` (robust to a config override) and
 * always also matches the canonical literal `claude-fable-5` — so it stays
 * correct at launch boundaries that lack an `orchCfg` (e.g. when config loading
 * returns undefined). Never throws.
 *
 * @param orchCfg the parsed `mag.orchestration` block (reads `.model_classes`).
 */
export function isFableModel(model: string, orchCfg?: Record<string, unknown>): boolean {
  const m = (model ?? "").trim();
  if (!m) return false;
  if (m === "claude-fable-5") return true;
  try {
    const table = orchCfg?.model_classes as Record<string, unknown> | undefined;
    return resolveModelClass(table, "claude-fable") === m;
  } catch {
    return false;
  }
}

/**
 * Build the actionable hard-error message shown when a `claude-fable` session
 * fails to launch / first-message (AC9 of task-13dee93b). Names the failing
 * model AND the exact config key to edit, instructing the user to switch to
 * `claude-opus`. When `role` is unknown, both role keys are named.
 */
export function fableUnavailableMessage(model: string, role?: "coder" | "reviewer"): string {
  const key = role
    ? `mag.orchestration.${role}_class`
    : `mag.orchestration.coder_class / mag.orchestration.reviewer_class`;
  return (
    `claude-fable (${model}) failed to launch — it may be unavailable on the active ` +
    `plan (Fable is promo-gated to 2026-06-22 and is not guaranteed on subscription ` +
    `plans). There is no silent fallback. To proceed, set ${key} to claude-opus in ` +
    `config.yaml and retry.`
  );
}

/**
 * Run an awaited launch/first-message dispatch, and — ONLY when the dispatched
 * model is the Fable class — rethrow a failure annotated with the actionable
 * {@link fableUnavailableMessage} (preserving the original error text). Non-Fable
 * failures pass through completely unchanged (never relabeled). No silent
 * fallback: the original failure is never swallowed.
 */
export async function dispatchWithFableContext<T>(
  fn: () => Promise<T>,
  model: string,
  role: "coder" | "reviewer" | undefined,
  orchCfg?: Record<string, unknown>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isFableModel(model, orchCfg)) {
      const orig = e instanceof Error ? e.message : String(e);
      throw new Error(`${fableUnavailableMessage(model, role)}\n(original error: ${orig})`);
    }
    throw e;
  }
}
