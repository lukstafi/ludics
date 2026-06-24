/**
 * Regression tests for the dashboard JS template rendering.
 *
 * These tests exercise the pendingAction badge logic from dashboard.js by
 * re-implementing the same rendering snippet and verifying it produces the
 * expected HTML. This catches regressions if the badge is accidentally removed
 * or the label format changes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Minimal escapeHtml matching the one in dashboard.js
function escapeHtml(text: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Replicate the pendingAction badge rendering logic from dashboard.js renderSlots().
 * If the template logic changes, this test will need to be updated — that is intentional.
 */
function renderPendingActionBadge(slot: { pendingAction?: string | null }): string | null {
  if (slot.pendingAction) {
    const label = slot.pendingAction.charAt(0).toUpperCase() + slot.pendingAction.slice(1) + "...";
    return `<span class="pending-action-badge">${escapeHtml(label)}</span>`;
  }
  return null;
}

describe("pendingAction badge rendering", () => {
  test("renders Starting... badge for 'starting' action", () => {
    const html = renderPendingActionBadge({ pendingAction: "starting" });
    expect(html).toBe('<span class="pending-action-badge">Starting...</span>');
  });

  test("renders Stopping... badge for 'stopping' action", () => {
    const html = renderPendingActionBadge({ pendingAction: "stopping" });
    expect(html).toBe('<span class="pending-action-badge">Stopping...</span>');
  });

  test("renders Resuming... badge for 'resuming' action", () => {
    const html = renderPendingActionBadge({ pendingAction: "resuming" });
    expect(html).toBe('<span class="pending-action-badge">Resuming...</span>');
  });

  test("returns null when pendingAction is null", () => {
    expect(renderPendingActionBadge({ pendingAction: null })).toBe(null);
  });

  test("returns null when pendingAction is undefined", () => {
    expect(renderPendingActionBadge({})).toBe(null);
  });
});

describe("dashboard.js template contains pendingAction badge code", () => {
  const templatePath = join(import.meta.dir, "dashboard.js");
  const template = readFileSync(templatePath, "utf-8");

  test("template includes pending-action-badge class", () => {
    expect(template).toContain("pending-action-badge");
  });

  test("template reads slot.pendingAction", () => {
    expect(template).toContain("slot.pendingAction");
  });

  test("template title-cases the label with ellipsis", () => {
    // Verify the charAt(0).toUpperCase() + slice(1) + '...' pattern
    expect(template).toContain(".charAt(0).toUpperCase()");
    expect(template).toContain("+ '...'");
  });
});

describe("style.css contains pending-action-badge class", () => {
  const stylePath = join(import.meta.dir, "style.css");
  const style = readFileSync(stylePath, "utf-8");

  test("style includes .pending-action-badge rule", () => {
    expect(style).toContain(".pending-action-badge");
  });

  test("pending-action-badge uses amber/yellow color", () => {
    // The badge should be styled with the warning palette (amber/yellow).
    // Style consolidation moved the rule to CSS variables (--warning / --warning-dim),
    // so verify the rule references those rather than a specific RGB literal.
    const ruleMatch = style.match(/\.slot-details \.pending-action-badge\s*\{[^}]*\}/);
    expect(ruleMatch).not.toBeNull();
    const rule = ruleMatch![0];
    expect(rule).toContain("var(--warning");
  });
});

// task-44558ae0: the Stale panel's task-title link previously had no CSS rule,
// so the <a class="task-title stale-link"> fell back to the browser-default
// blue anchor color — theme-invariant and unreadable on Night/OLED. These
// tests pin the theme-aware, non-blue title color and the warm-accent hover,
// mirroring the sibling .needs-confirm-link / .unanswered-q-link rules.
describe("style.css — Stale panel theme-aware link (task-44558ae0)", () => {
  const stylePath = join(import.meta.dir, "style.css");
  const style = readFileSync(stylePath, "utf-8");

  function ruleFor(selector: string): string {
    // Escape selector for a regex, then match its declaration block.
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = style.match(new RegExp(`${esc}\\s*\\{[^}]*\\}`));
    expect(m).not.toBeNull();
    return m![0];
  }

  test(".stale-link base color is the load-bearing theme token, never blue", () => {
    const rule = ruleFor(".stale-link");
    // Load-bearing title color resolves to --text-primary (#e8e6e3 / #1c1917 /
    // #ffffff across Night/Day/OLED) — high-contrast and non-blue on all three.
    expect(rule).toContain("color: var(--text-primary)");
    // At rest the link is not underlined (matches siblings).
    expect(rule).toContain("text-decoration: none");
    // Guard against any blue literal / UA-default anchor color creeping back.
    expect(rule.toLowerCase()).not.toContain("blue");
    expect(rule).not.toMatch(/#(?:3b82f6|2563eb|0000ff|00f\b)/i);
  });

  test(".stale-link:hover mirrors siblings: warm accent + underline", () => {
    const rule = ruleFor(".stale-link:hover");
    // --accent is warm red/orange (#e85d4a / #c9362c / #ff4040) — never blue.
    expect(rule).toContain("color: var(--accent)");
    expect(rule).toContain("text-decoration: underline");
  });

  test(".stale-item is a flex row and .stale-actions right-aligns the buttons", () => {
    const item = ruleFor(".stale-item");
    expect(item).toContain("display: flex");
    expect(item).toContain("align-items: center");
    const actions = ruleFor(".stale-actions");
    expect(actions).toContain("margin-left: auto");
    expect(actions).toContain("flex-shrink: 0");
  });

  // Positive control: the matcher distinguishes presence from absence — the
  // sibling link this fix mirrors must still pin --text-primary. If this
  // assertion ever fails, the test infra (not just the Stale rule) is broken.
  test("sibling .needs-confirm-link base color is still var(--text-primary)", () => {
    expect(ruleFor(".needs-confirm-link")).toContain("color: var(--text-primary)");
  });
});

// task-44558ae0 (AC4/AC5): the priority chip geometry (fixed box, centering,
// radius) was scoped to `.ready-queue .priority`, so the same badge span in
// the Stale / Needs-Confirmation / Unanswered / Deferred panels rendered as a
// bare inline letter. The geometry selector is broadened to bare `.priority`
// (values unchanged) so every badge gets the chip; Ready Queue is unchanged.
describe("style.css — priority chip geometry is global (task-44558ae0)", () => {
  const stylePath = join(import.meta.dir, "style.css");
  const style = readFileSync(stylePath, "utf-8");

  test("geometry lives on an unscoped .priority rule with the fixed-chip box", () => {
    const m = style.match(/(^|[^a-zA-Z-])\.priority\s*\{[^}]*\}/m);
    expect(m).not.toBeNull();
    const rule = m![0];
    expect(rule).toContain("display: inline-flex");
    expect(rule).toContain("width: 20px");
    expect(rule).toContain("height: 20px");
    expect(rule).toContain("border-radius: var(--radius-sm)");
    expect(rule).toContain("justify-content: center");
  });

  test("the chip geometry is no longer scoped to .ready-queue .priority", () => {
    // Mutation guard: reverting the selector to `.ready-queue .priority` makes
    // this assertion fail, which is the whole point of the broadening.
    expect(style).not.toContain(".ready-queue .priority");
  });
});

// gh-ludics-535: the Mag queue renderer must surface unresolved deliveries
// as an "Unresolved deliveries" panel between Pending and Recent. `inFlight`
// is always an array (possibly empty). These tests extract the real
// renderQueue / escapeHtml from mag.html and drive them against a minimal
// document stub.
describe("mag.html renderQueue — Unresolved deliveries section (gh-ludics-535)", () => {
  const magSrc = readFileSync(join(import.meta.dir, "mag.html"), "utf-8");
  const renderQueueSrc = magSrc.slice(
    magSrc.indexOf("function renderQueue("),
    magSrc.indexOf("async function promoteQueueItem"),
  );
  const escapeHtmlSrc = magSrc.slice(
    magSrc.indexOf("function escapeHtml("),
    magSrc.indexOf("function setConnectionStatus"),
  );

  type InFlightRow = { requestId: string; command: string; deliveredAt: string };

  // Minimal document stub: getElementById returns the live list element;
  // createElement('div') backs escapeHtml's textContent → innerHTML escaping.
  function makeRenderQueue(listEl: { innerHTML: string }): (p: unknown[], r: unknown[], i: InFlightRow[]) => void {
    const documentStub = {
      getElementById: () => listEl,
      createElement: () => {
        let text = "";
        return {
          set textContent(v: string) { text = String(v); },
          get innerHTML() {
            return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          },
        };
      },
    };
    return new Function(
      "document",
      `${escapeHtmlSrc}\n${renderQueueSrc}\nreturn renderQueue;`,
    )(documentStub) as (p: unknown[], r: unknown[], i: InFlightRow[]) => void;
  }

  test("renders 'Unresolved deliveries' between 'Pending' and 'Recent'", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    renderQueue(
      [{ id: "req-p", action: "elaborate" }],
      [{ id: "req-r", status: "ok" }],
      [{ requestId: "req-if", command: "/ludics-briefing", deliveredAt: "2026-05-14T08:06:28Z" }],
    );
    const html = listEl.innerHTML;
    const pendingIdx = html.indexOf("Pending");
    const unresolvedIdx = html.indexOf("Unresolved deliveries");
    const recentIdx = html.indexOf("Recent");
    // The invariant: an unresolved delivery is visible and ordered between
    // the durable queue and completed results. If the section were missing
    // or misplaced, this ordering chain would break.
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(unresolvedIdx).toBeGreaterThan(pendingIdx);
    expect(recentIdx).toBeGreaterThan(unresolvedIdx);
    expect(html).toContain("/ludics-briefing");
    expect(html).toContain("2026-05-14T08:06:28Z");
  });

  test("escapes the unresolved-delivery command (XSS guard)", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    renderQueue([], [], [{ requestId: "req-x", command: "<script>evil</script>", deliveredAt: "" }]);
    expect(listEl.innerHTML).toContain("&lt;script&gt;evil&lt;/script&gt;");
    expect(listEl.innerHTML).not.toContain("<script>evil");
  });

  test("suppresses 'No activity' while at least one unresolved delivery exists", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    // Harness condition: pending AND results empty — only the unresolved set
    // is non-empty. Without inFlight.length === 0 in the empty-state guard,
    // this would render "No activity".
    renderQueue([], [], [{ requestId: "req-x", command: "/ludics-briefing", deliveredAt: "2026-05-14T08:06:28Z" }]);
    expect(listEl.innerHTML).not.toContain("No activity");
    expect(listEl.innerHTML).toContain("Unresolved deliveries");
  });

  test("still shows 'No activity' when pending, results, and inFlight are all empty", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    renderQueue([], [], []);
    expect(listEl.innerHTML).toContain("No activity");
  });

  test("renders multiple unresolved deliveries in server-provided order", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    // Server sorts ascending by deliveredAt; the renderer preserves order.
    renderQueue([], [], [
      { requestId: "req-A", command: "/ludics-briefing", deliveredAt: "2026-05-14T08:00:00Z" },
      { requestId: "req-B", command: "/ludics-learn", deliveredAt: "2026-05-14T09:00:00Z" },
    ]);
    const html = listEl.innerHTML;
    expect(html.indexOf("/ludics-briefing")).toBeLessThan(html.indexOf("/ludics-learn"));
  });

  test("renders Re-fire and Discard buttons per row", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    renderQueue([], [], [
      { requestId: "req-A", command: "/ludics-briefing", deliveredAt: "" },
      { requestId: "req-B", command: "/ludics-learn", deliveredAt: "" },
    ]);
    const html = listEl.innerHTML;
    // Two of each — one per row. The presence of these onclick handlers is
    // load-bearing: they are the only path to /api/in-flight-{refire,discard}
    // from the dashboard UI.
    const refireMatches = html.match(/onclick="refireInFlight\(/g) ?? [];
    const discardMatches = html.match(/onclick="discardInFlight\(/g) ?? [];
    expect(refireMatches).toHaveLength(2);
    expect(discardMatches).toHaveLength(2);
  });

  test("renders a count badge with the array length", () => {
    const listEl = { innerHTML: "" };
    const renderQueue = makeRenderQueue(listEl);
    renderQueue([], [], [
      { requestId: "req-A", command: "/x", deliveredAt: "" },
      { requestId: "req-B", command: "/y", deliveredAt: "" },
      { requestId: "req-C", command: "/z", deliveredAt: "" },
    ]);
    expect(listEl.innerHTML).toContain('<span class="mag-queue-badge">3</span>');
  });
});
