// Shared server-side constants + validators for the dashboard's
// provider-role toggle (task-b43bd578).
//
// `PROVIDERS` must stay in lockstep with
// `templates/dashboard/role-switcher.js`'s browser-local copy; a
// constant-sync test in `src/orchestration-defaults.test.ts` pins both.
//
// Asymmetry (AC 13a): with `PROVIDERS = {claude-code, codex}`, the
// dashboard persists an explicit `coder: null` / `reviewer: null` choice
// across reloads, but the auto-fill read sites
// (`selectOrchestrationFlags`, `expandDuoSlots`) coerce explicit null to
// the literal fallback. Honouring null at auto-fill is deferred to the
// N≥3 provider-extension task.

export const PROVIDERS = ["claude-code", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ROLES = ["coder", "reviewer", "none"] as const;
export type Role = (typeof ROLES)[number];

export const EFFECTIVE_DEFAULTS = {
  coder: "claude-code" as Provider,
  reviewer: "codex" as Provider,
} as const;

export interface OrchestrationDefaultsState {
  coder: Provider | null;
  reviewer: Provider | null;
}

export function isProvider(x: unknown): x is Provider {
  return typeof x === "string" && (PROVIDERS as readonly string[]).includes(x);
}

/**
 * Compute the dashboard's effective defaults from a parsed
 * `mag.orchestration` config block.
 *
 * Key-presence semantics (load-bearing for AC 7 + AC 10 + AC 11):
 *   - key absent           → effective fallback (claude-code / codex)
 *   - key present and null → null (preserves explicit user "none")
 *   - key present + valid  → the configured value
 *   - key present + invalid (e.g. "cursor") → effective fallback +
 *     console.error warning (so dashboard generation never crashes)
 */
export function effectiveDefaultsFromConfig(
  orch: Record<string, unknown> | undefined | null,
): OrchestrationDefaultsState {
  return {
    coder: resolveRole(orch, "default_coder", EFFECTIVE_DEFAULTS.coder),
    reviewer: resolveRole(orch, "default_reviewer", EFFECTIVE_DEFAULTS.reviewer),
  };
}

function resolveRole(
  orch: Record<string, unknown> | undefined | null,
  key: string,
  fallback: Provider,
): Provider | null {
  if (!orch || !(key in orch)) return fallback;
  const v = orch[key];
  if (v === null) return null;
  if (isProvider(v)) return v;
  console.error(
    `ludics: orchestration-defaults: ignoring unknown mag.orchestration.${key}=${JSON.stringify(v)}; falling back to ${fallback}`,
  );
  return fallback;
}

export type ValidatePayloadResult =
  | { ok: true; coder: Provider | null; reviewer: Provider | null }
  | { ok: false; error: string };

/**
 * Validate a POST /api/orchestration-defaults body. Server-side
 * enforcement of AC 4's ≤1-coder / ≤1-reviewer invariant and AC 10's
 * shape constraints.
 */
export function validatePayload(body: unknown): ValidatePayloadResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  if (!("coder" in obj)) return { ok: false, error: "missing 'coder' key" };
  if (!("reviewer" in obj)) return { ok: false, error: "missing 'reviewer' key" };
  const coder = obj.coder;
  const reviewer = obj.reviewer;
  if (coder !== null && !isProvider(coder)) {
    return { ok: false, error: `invalid 'coder' value: ${JSON.stringify(coder)}` };
  }
  if (reviewer !== null && !isProvider(reviewer)) {
    return { ok: false, error: `invalid 'reviewer' value: ${JSON.stringify(reviewer)}` };
  }
  if (coder !== null && reviewer !== null && coder === reviewer) {
    return { ok: false, error: "'coder' and 'reviewer' must differ when both non-null" };
  }
  return {
    ok: true,
    coder: coder as Provider | null,
    reviewer: reviewer as Provider | null,
  };
}
