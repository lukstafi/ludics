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
