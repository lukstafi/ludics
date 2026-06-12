// Browser-side dashboard provider-role toggle (task-b43bd578).
//
// Exports:
//   - PROVIDERS         literal provider universe (kept in lockstep with
//                       `src/orchestration-defaults.ts` via constant-sync test).
//   - applyRoleChange   pure cascade per proposal AC 4–6 + AC 14.
//   - createRoleSwitcherElement
//                       DOM constructor. Pure: no fetch, no document mutation
//                       outside the returned subtree. nav.js owns the
//                       insertion into `.status-bar`.

export const PROVIDERS = ["claude-code", "codex"];
export const ROLES = ["coder", "reviewer"];
const ROLE_PREFIX = { coder: "C", reviewer: "R" };

// task-13dee93b: per-role high-end Claude class sub-select. NOT a provider —
// PROVIDERS stays exactly [claude-code, codex] (AC7). The class choice is only
// meaningful for a claude-code-held role.
export const HIGH_END_CLASSES = ["claude-opus", "claude-fable"];
const DEFAULT_HIGH_END_CLASS = "claude-opus";

/** A role's class sub-select is only enabled when claude-code holds that role
 *  (a model class is meaningless for codex / an unheld role). Pure — exported so
 *  the enable/disable rule is tested without a DOM. */
export function roleHeldByClaudeCode(role, state) {
  return !!state && state["claude-code"] === role;
}

/** Build the POST wire body from the provider role-state + the per-role class
 *  state. Maps internal `none` → `null` for providers and always carries the two
 *  class fields (so the persisted choice round-trips). Exported for testing. */
export function toWireBody(state, classState) {
  const out = { coder: null, reviewer: null };
  for (const p of PROVIDERS) {
    if (state[p] === "coder") out.coder = p;
    else if (state[p] === "reviewer") out.reviewer = p;
  }
  const cs = classState || {};
  out.coderClass = HIGH_END_CLASSES.includes(cs.coder) ? cs.coder : DEFAULT_HIGH_END_CLASS;
  out.reviewerClass = HIGH_END_CLASSES.includes(cs.reviewer) ? cs.reviewer : DEFAULT_HIGH_END_CLASS;
  return out;
}

/**
 * Pure constraint-propagation cascade.
 *
 * State: { [provider]: "coder" | "reviewer" | "none" }
 * Never mutates the input; returns a new state object.
 *
 * On setRole(p, "none"):  clear p only; no cascade (AC 6).
 * On setRole(p, r) where r ∈ {coder, reviewer} (AC 5):
 *   - find pOld != p with state[pOld] === r;
 *   - set state[p] = r;
 *   - if pOld exists: let rOther be the other role; if no provider currently
 *     holds rOther, set state[pOld] = rOther; else set state[pOld] = "none".
 */
export function applyRoleChange(state, provider, role) {
  const next = { ...state };
  if (role === "none") {
    next[provider] = "none";
    return next;
  }
  const rOther = role === "coder" ? "reviewer" : "coder";
  // pOld is the (at most one) other provider that currently holds `role`.
  let pOld = null;
  for (const p of Object.keys(next)) {
    if (p !== provider && next[p] === role) {
      pOld = p;
      break;
    }
  }
  next[provider] = role;
  if (pOld === null) return next;
  // Does any provider (other than pOld, after we update it) currently hold rOther?
  let rOtherHolder = null;
  for (const p of Object.keys(next)) {
    if (p !== pOld && next[p] === rOther) {
      rOtherHolder = p;
      break;
    }
  }
  next[pOld] = rOtherHolder === null ? rOther : "none";
  return next;
}

/**
 * Construct a `.role-switcher` element with one `<select>` per role.
 *
 * Each select shows `<prefix>: <provider>` (e.g. "C: claude-code") or
 * `<prefix>: —` when no provider holds the role. The same cascade
 * `applyRoleChange` runs whether the user picks a provider (assign) or "—"
 * (release) — the ≤1-coder / ≤1-reviewer invariant is preserved either way.
 *
 * `initialState` shape: { [provider]: "coder" | "reviewer" | "none" }
 * `onSubmit(newState)` is called after each change; should return a Promise
 * that resolves to the server-confirmed state (or throws on failure).
 * Pessimistic update: on rejection, the local state is restored and a
 * compact error message is surfaced via the element's `title` attribute.
 *
 * Returns the constructed element. Pure DOM construction — no document
 * mutation outside the returned subtree.
 */
export function createRoleSwitcherElement(initialState, onSubmit, initialClasses) {
  let state = { ...initialState };
  // Per-role high-end class, tracked separately from the provider role-state so
  // the value is preserved even while a role is held by codex/none (AC4 reload).
  const ic = initialClasses || {};
  const classState = {
    coder: HIGH_END_CLASSES.includes(ic.coder) ? ic.coder : DEFAULT_HIGH_END_CLASS,
    reviewer: HIGH_END_CLASSES.includes(ic.reviewer) ? ic.reviewer : DEFAULT_HIGH_END_CLASS,
  };
  const root = document.createElement("div");
  root.className = "role-switcher";

  const selects = {}; // role -> provider <select>
  const classSelects = {}; // role -> class <select>

  function holderOf(role, st) {
    for (const p of PROVIDERS) {
      if (st[p] === role) return p;
    }
    return "";
  }

  function syncSelects() {
    for (const r of ROLES) {
      const sel = selects[r];
      if (sel) sel.value = holderOf(r, state);
      const csel = classSelects[r];
      if (csel) {
        csel.value = classState[r];
        // The class sub-select is only relevant for a claude-code-held role.
        csel.disabled = !roleHeldByClaudeCode(r, state);
      }
    }
  }

  for (const role of ROLES) {
    const sel = document.createElement("select");
    sel.className = "role-select";
    sel.dataset.role = role;
    sel.setAttribute("aria-label", role === "coder" ? "Coder" : "Reviewer");
    const prefix = ROLE_PREFIX[role];

    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = `${prefix}: —`;
    sel.appendChild(noneOpt);

    for (const p of PROVIDERS) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = `${prefix}: ${p}`;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => handleChange(role, sel.value));
    selects[role] = sel;
    root.appendChild(sel);

    // High-end class sub-select (Opus/Fable) for this role.
    const csel = document.createElement("select");
    csel.className = "class-select";
    csel.dataset.role = role;
    csel.setAttribute("aria-label", `${role === "coder" ? "Coder" : "Reviewer"} high-end class`);
    for (const cls of HIGH_END_CLASSES) {
      const opt = document.createElement("option");
      opt.value = cls;
      opt.textContent = cls === "claude-fable" ? "Fable" : "Opus";
      csel.appendChild(opt);
    }
    csel.addEventListener("change", () => handleClassChange(role, csel.value));
    classSelects[role] = csel;
    root.appendChild(csel);
  }

  const sequencer = createInFlightSequencer();

  async function submit(prevState, prevClasses) {
    syncSelects();
    root.removeAttribute("title");
    const myId = sequencer.begin();
    try {
      const confirmed = await onSubmit(toWireBody(state, classState));
      // Drop stale responses: if a newer change started after this one,
      // its response (or its failure) is authoritative — not ours.
      if (!sequencer.isLatest(myId)) return;
      if (confirmed && typeof confirmed === "object") {
        state = fromWireBody(confirmed);
        if (HIGH_END_CLASSES.includes(confirmed.coderClass)) classState.coder = confirmed.coderClass;
        if (HIGH_END_CLASSES.includes(confirmed.reviewerClass)) classState.reviewer = confirmed.reviewerClass;
        syncSelects();
      }
    } catch (err) {
      if (!sequencer.isLatest(myId)) return;
      // Pessimistic rollback: server rejected or network failed.
      state = prevState;
      classState.coder = prevClasses.coder;
      classState.reviewer = prevClasses.reviewer;
      syncSelects();
      root.setAttribute("title", `Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleChange(role, chosenProvider) {
    const prev = state;
    const prevClasses = { ...classState };
    let next;
    if (chosenProvider === "") {
      const holder = holderOf(role, prev);
      if (!holder) return; // no-op release
      next = applyRoleChange(prev, holder, "none");
    } else {
      next = applyRoleChange(prev, chosenProvider, role);
    }
    state = next;
    await submit(prev, prevClasses);
  }

  async function handleClassChange(role, chosenClass) {
    if (!HIGH_END_CLASSES.includes(chosenClass)) return;
    const prev = state;
    const prevClasses = { ...classState };
    classState[role] = chosenClass;
    await submit(prev, prevClasses);
  }

  syncSelects();
  return root;
}

/**
 * Per-instance in-flight request sequencer. Each click obtains a fresh
 * monotonic id via `begin()`; after the POST resolves the handler checks
 * `isLatest(id)` and drops stale responses. Without this, rapid clicks
 * whose responses resolve out of order would let an older response
 * overwrite a newer state mutation (Codex P2 review on PR #523).
 */
export function createInFlightSequencer() {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isLatest(id) {
      return id === latest;
    },
  };
}

export function fromWireBody(body) {
  const state = {};
  for (const p of PROVIDERS) state[p] = "none";
  if (body && typeof body === "object") {
    if (body.coder && PROVIDERS.includes(body.coder)) state[body.coder] = "coder";
    if (body.reviewer && PROVIDERS.includes(body.reviewer)) state[body.reviewer] = "reviewer";
  }
  return state;
}
