// Integration test: magDoctor prints the cluster onboarding section (AC 9).
//
// On a host that is not part of any cluster (clusterEnabled() false — the case in
// CI and dev boxes), clusterDoctor() short-circuits to "not configured", which is
// deterministic. The invariant: `ludics doctor` always surfaces the cluster
// onboarding group, so worker-onboarding state is legible from the doctor.

import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("magDoctor cluster onboarding section (AC 9)", () => {
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
  const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_MACHINE = process.env.LUDICS_CLUSTER_MACHINE_NAME;
  let TMP = "";

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "ludics-magdoctor-cluster-"));
    process.env.HOME = TMP;
    process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
    // Standalone config (no cluster machines) → clusterDoctor short-circuits.
    const cfgPath = join(TMP, "config.yaml");
    writeFileSync(cfgPath, `state_repo: test/state\nstate_path: harness\n`);
    process.env.LUDICS_CONFIG = cfgPath;
    delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG; else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
    if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR; else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
    if (ORIGINAL_MACHINE === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME; else process.env.LUDICS_CLUSTER_MACHINE_NAME = ORIGINAL_MACHINE;
    rmSync(TMP, { recursive: true, force: true });
  });

  test("doctor output includes the cluster onboarding group", async () => {
    const { magDoctor } = await import("./mag.ts");
    const out: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      magDoctor();
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const output = out.join("\n");
    // Invariant: the cluster onboarding group is always emitted, and the standalone
    // host resolves to "not configured" rather than silently omitting the section.
    expect(output).toContain("Cluster onboarding:");
    expect(output).toContain("Cluster: not configured (standalone)");
  });
});
