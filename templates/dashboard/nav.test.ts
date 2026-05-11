// task-b43bd578 — source-level pins for nav.js role-switcher wiring
// and the .role-switcher CSS rules in style.css.
//
// nav.js runs in the browser; we can't unit-test the actual DOM
// injection here (the live HTTP smoke probe (AC 19) does that). What we
// CAN pin is that the nav.js source contains the required wiring (the
// dynamic import, the insertBefore against the live theme switcher
// reference, the fetch URLs, the POST shape) and that style.css carries
// the required selectors. Drift in these literals would break the
// browser-side behaviour silently.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const navJsPath = join(__dirname, "nav.js");
const styleCssPath = join(__dirname, "style.css");
const navJs = readFileSync(navJsPath, "utf-8");
const styleCss = readFileSync(styleCssPath, "utf-8");

describe("nav.js — role-switcher wiring (task-b43bd578)", () => {
  test("dynamically imports ./role-switcher.js (avoids HTML edits)", () => {
    expect(navJs).toMatch(/import\(['"]\.\/role-switcher\.js['"]\)/);
  });

  test("fetches data/orchestration-defaults.json on page load", () => {
    expect(navJs).toMatch(/fetch\(['"]data\/orchestration-defaults\.json['"]/);
  });

  test("POSTs to /api/orchestration-defaults", () => {
    expect(navJs).toMatch(/['"]\/api\/orchestration-defaults['"]/);
    expect(navJs).toMatch(/method:\s*['"]POST['"]/);
  });

  test("inserts role-switcher BEFORE the live theme-switcher reference (AC 1)", () => {
    // Use the in-scope `switcher` variable that's already assigned the
    // theme-switcher element; re-querying after insertion would mis-order.
    expect(navJs).toMatch(/statusBar\.insertBefore\(roleSwitcher,\s*switcher\)/);
  });

  test("guards on statusBar AND switcher before injecting", () => {
    // Theme-switcher block can fail or be skipped; role-switcher must
    // not insert against a null reference.
    expect(navJs).toMatch(/if\s*\(statusBar\s*&&\s*switcher\)/);
  });

  test("negative control: nav.js does NOT use localStorage for role state", () => {
    // Theme uses localStorage (THEME_KEY = 'ludics-theme'). The role
    // toggle MUST NOT, because the auto-fill code reads config keys —
    // localStorage would diverge from the actual auto-fill path.
    const lines = navJs.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip pure-comment lines (negative-control should pin code, not docs).
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (!/localStorage/.test(line)) continue;
      // Allow only theme-related localStorage uses.
      if (/THEME_KEY|ludics-theme|theme/i.test(line)) continue;
      throw new Error(`unexpected localStorage use in nav.js: ${line.trim()}`);
    }
  });

  test("uses .catch / try-style error handling for the dynamic-import block", () => {
    // Network or import rejection must NOT brick the rest of nav.js.
    expect(navJs).toMatch(/\.catch\(function/);
  });
});

describe("style.css — role-switcher selectors (task-b43bd578)", () => {
  test(".role-switcher rule is defined", () => {
    expect(styleCss).toMatch(/\.role-switcher\s*\{/);
  });

  test(".role-btn rule is defined", () => {
    expect(styleCss).toMatch(/\.role-btn\s*\{/);
  });

  test(".role-btn.active rule (active-state visual marking, AC 3) is defined", () => {
    expect(styleCss).toMatch(/\.role-btn\.active\s*\{/);
  });

  test(".role-section-label rule (Defaults for new sessions hint) is defined", () => {
    expect(styleCss).toMatch(/\.role-section-label\s*\{/);
  });
});
