// task-7476a03a — slot ttyd flap-suppression recovery hook.
//
// Posts /api/ttyd-reset?slot=<n> for each active slot exactly once per
// page lifetime. Cmd-Shift-R reloads the document → re-evaluates the
// module → fresh closure with resetSent=false → reset re-fires once.
// The 30-s setInterval in terminals.html keeps the same module instance,
// so resetSent stays true and the reset does NOT re-fire on routine
// refreshes. This is what turns "force reload" into the recovery gesture.
//
// Failure modes (both warn-only — never reject the returned promise so
// the calling render path is unblocked):
//   1. fetch() rejects (network unreachable / CORS / abort)
//   2. fetch() resolves with !resp.ok (4xx/5xx)
let resetSent = false;

// Test-only escape hatch — module-private state needs a way to be reset
// between unit tests so each can observe the once-only invariant.
export function __resetForTests() { resetSent = false; }

/**
 * @param {number[]} activeSlots
 * @param {typeof fetch} [fetchImpl]
 */
export async function maybeResetTtydCounters(activeSlots, fetchImpl) {
  if (resetSent) return;
  resetSent = true;
  const f = fetchImpl ?? fetch;
  await Promise.allSettled(
    (activeSlots || []).map(async (slot) => {
      try {
        const resp = await f(`/api/ttyd-reset?slot=${slot}`, { method: 'POST' });
        if (!resp.ok) {
          console.warn('ttyd-reset non-2xx', slot, resp.status, resp.statusText);
        }
      } catch (err) {
        console.warn('ttyd-reset failed', slot, err);
      }
    }),
  );
}
