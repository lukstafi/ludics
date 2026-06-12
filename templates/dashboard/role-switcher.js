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

// task-13dee93b: per-role high-end Claude model class. NOT a provider —
// PROVIDERS stays exactly [claude-code, codex] (AC7). claude-code is surfaced in
// the role dropdown as these two classes directly (no separate sub-select), so
// picking a class both assigns claude-code AND records the model class.
export const HIGH_END_CLASSES = ["claude-opus", "claude-fable"];
const DEFAULT_HIGH_END_CLASS = "claude-opus";

// The values offered in each role's single dropdown. claude-code expands into
// its two model classes; every other provider appears as itself. PROVIDERS +
// HIGH_END_CLASSES remain the semantic source of truth (AC7) — this is purely
// the display expansion that lets one dropdown cover provider + class.
export const ROLE_OPTION_VALUES = PROVIDERS.flatMap((p) =>
  p === "claude-code" ? [...HIGH_END_CLASSES] : [p],
);

/** Map a dropdown value back to its underlying provider. Both high-end classes
 *  resolve to claude-code; every other value is its own provider. Pure —
 *  exported so the mapping is tested without a DOM. */
export function providerForOptionValue(value) {
  return HIGH_END_CLASSES.includes(value) ? "claude-code" : value;
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
 * Each select shows `<prefix>: <value>` where the value is the model class for
 * a claude-code-held role (e.g. "C: claude-opus" / "C: claude-fable"), the
 * provider for any other (e.g. "R: codex"), or `<prefix>: —` when no provider
 * holds the role. Surfacing claude-code as its two model classes directly means
 * the model choice needs no second dropdown (task-13dee93b). The same cascade
 * `applyRoleChange` runs whether the user picks a value (assign) or "—"
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

  const selects = {}; // role -> <select>

  function holderOf(role, st) {
    for (const p of PROVIDERS) {
      if (st[p] === role) return p;
    }
    return "";
  }

  // The dropdown value for a role encodes BOTH provider and (for claude-code)
  // model class: claude-code → its class (opus/fable), another provider → that
  // provider, unheld → "" (the em-dash option).
  function optionValueFor(role) {
    const holder = holderOf(role, state);
    if (holder === "claude-code") return classState[role];
    return holder; // codex → "codex"; unheld → ""
  }

  function syncSelects() {
    for (const r of ROLES) {
      const sel = selects[r];
      if (sel) sel.value = optionValueFor(r);
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

    for (const v of ROLE_OPTION_VALUES) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = `${prefix}: ${v}`;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => handleChange(role, sel.value));
    selects[role] = sel;
    root.appendChild(sel);
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

  async function handleChange(role, chosenValue) {
    const prev = state;
    const prevClasses = { ...classState };
    let next;
    if (chosenValue === "") {
      const holder = holderOf(role, prev);
      if (!holder) return; // no-op release
      next = applyRoleChange(prev, holder, "none");
    } else {
      // A high-end class value both assigns claude-code to the role AND records
      // which model class that role should use; a plain provider just assigns.
      if (HIGH_END_CLASSES.includes(chosenValue)) classState[role] = chosenValue;
      next = applyRoleChange(prev, providerForOptionValue(chosenValue), role);
    }
    state = next;
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
