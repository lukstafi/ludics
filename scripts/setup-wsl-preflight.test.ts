// Regression test for the WSL2 worker-persistence preflight wired into setup.sh
// (AC 8). The "detect or fail loud" requirement is a sequence of shell side
// effects, not prose: onboarding must detect WSL, require systemd PID 1, enable
// linger, install the (role-gated) triggers, and verify with `cluster doctor`
// before declaring the node ready. Prose can't be enforced — the ordered command
// pipeline can. Mutation: removing the `cluster doctor` gate, dropping the
// enable-linger call, or reordering install-after-verify all fail an assertion.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SETUP = readFileSync(join(import.meta.dir, "..", "setup.sh"), "utf8");

describe("setup.sh WSL2 worker persistence preflight (AC 8)", () => {
  test("runs only on WSL Linux, after init, before repo clone", () => {
    const initIdx = SETUP.indexOf("ludics init --no-triggers");
    const preflightIdx = SETUP.indexOf("Configuring WSL2 worker persistence");
    const cloneIdx = SETUP.indexOf("Checking t3code-ludics");
    expect(initIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeGreaterThan(initIdx); // after onboarding init
    expect(cloneIdx).toBeGreaterThan(preflightIdx);
    // Gated behind a WSL + Linux guard, not run unconditionally.
    expect(SETUP).toMatch(/if is_linux && is_wsl; then\s*\n\s*step "Configuring WSL2 worker persistence"/);
  });

  test("detects WSL via env or osrelease (mirrors isWsl in src/cluster.ts)", () => {
    expect(SETUP).toMatch(/is_wsl\(\)\s*\{[\s\S]*WSL_DISTRO_NAME[\s\S]*microsoft\|wsl[\s\S]*osrelease/);
  });

  test("fails loud when systemd is not PID 1 (cannot auto-fix)", () => {
    // Must `fail` (exit 1), not warn, and cite the wsl.conf remediation.
    expect(SETUP).toMatch(/ps -p 1 -o comm=[\s\S]*?!= "systemd"[\s\S]*?fail "WSL2 systemd is not PID 1/);
  });

  test("configures linger then installs triggers then verifies — in order, all gating", () => {
    // The ordered side-effect chain. Each step `fail`s on error so a red check
    // aborts onboarding rather than declaring a dead worker ready.
    const seq =
      /loginctl enable-linger "\$USER" \|\| fail[\s\S]*?bin\/ludics triggers install\s*\n\s*bin\/ludics cluster doctor \|\| fail/;
    expect(SETUP).toMatch(seq);
  });

  test("missing loginctl fails loud rather than silently skipping linger", () => {
    expect(SETUP).toMatch(/else\s*\n\s*fail "loginctl not available/);
  });
});
