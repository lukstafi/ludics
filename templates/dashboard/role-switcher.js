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
 * Construct a `.role-switcher` element with three buttons per provider.
 *
 * `initialState` shape: { [provider]: "coder" | "reviewer" | "none" }
 * `onSubmit(newState)` is called after each click; should return a Promise
 * that resolves to the server-confirmed state (or throws on failure).
 * Pessimistic update: on rejection, the local state is restored and a
 * compact error message is surfaced via the element's `title` attribute.
 *
 * Returns the constructed element. Pure DOM construction — no document
 * mutation outside the returned subtree.
 */
export function createRoleSwitcherElement(initialState, onSubmit) {
  let state = { ...initialState };
  const root = document.createElement("div");
  root.className = "role-switcher";
  root.setAttribute("aria-label", "Defaults for new sessions");

  const label = document.createElement("span");
  label.className = "role-section-label";
  label.textContent = "Defaults for new sessions";
  root.appendChild(label);

  const buttonRefs = {}; // provider -> { coder, reviewer, none }

  function syncActive() {
    for (const p of PROVIDERS) {
      const refs = buttonRefs[p];
      if (!refs) continue;
      const current = state[p] ?? "none";
      refs.coder.classList.toggle("active", current === "coder");
      refs.reviewer.classList.toggle("active", current === "reviewer");
      refs.none.classList.toggle("active", current === "none");
    }
  }

  for (const provider of PROVIDERS) {
    const row = document.createElement("div");
    row.className = "role-row";
    row.dataset.provider = provider;

    const name = document.createElement("span");
    name.className = "role-provider-name";
    name.textContent = provider;
    row.appendChild(name);

    const group = document.createElement("div");
    group.className = "role-btn-group";
    const refs = {};
    for (const r of ["coder", "reviewer", "none"]) {
      const btn = document.createElement("button");
      btn.className = "role-btn";
      btn.dataset.role = r;
      btn.dataset.provider = provider;
      btn.textContent = r;
      btn.title = `Set ${provider} as ${r}`;
      btn.addEventListener("click", () => handleClick(provider, r));
      group.appendChild(btn);
      refs[r] = btn;
    }
    buttonRefs[provider] = refs;
    row.appendChild(group);
    root.appendChild(row);
  }

  async function handleClick(provider, role) {
    const prev = state;
    const next = applyRoleChange(prev, provider, role);
    state = next;
    syncActive();
    root.removeAttribute("title");
    try {
      const confirmed = await onSubmit(toWireBody(next));
      if (confirmed && typeof confirmed === "object") {
        state = fromWireBody(confirmed);
        syncActive();
      }
    } catch (err) {
      // Pessimistic rollback: server rejected or network failed.
      state = prev;
      syncActive();
      root.setAttribute("title", `Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  syncActive();
  return root;
}

/** Map internal `none` ↔ wire-body `null`. */
function toWireBody(state) {
  const out = { coder: null, reviewer: null };
  for (const p of PROVIDERS) {
    if (state[p] === "coder") out.coder = p;
    else if (state[p] === "reviewer") out.reviewer = p;
  }
  return out;
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
