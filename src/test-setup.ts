import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Safety net: all tests get an isolated harness directory by default.
// Individual test files can override this in their own beforeAll/beforeEach.
if (!process.env.LUDICS_HARNESS_DIR) {
  process.env.LUDICS_HARNESS_DIR = mkdtempSync(join(tmpdir(), "ludics-test-"));
}

// Safety net: neutralize an ambient cluster-machine override leaked from the
// launching shell. The federation controller exports
// LUDICS_CLUSTER_MACHINE_NAME=<node> into its interactive shell, which bleeds
// into the Bun test process and breaks hostname-based self-match tests
// (clusterCurrentMachine() short-circuits on the override and returns undefined
// when that name is absent from a test's synthetic cluster config). Tests that
// exercise the override set it explicitly in their own bodies after this
// preload runs and restore it in their own afterEach/finally, so they are
// unaffected.
delete process.env.LUDICS_CLUSTER_MACHINE_NAME;

// Mark the process as a test run so safeSyncOutput refuses to execute real
// service-manager commands (`launchctl`/`systemctl`) against the live machine.
// Those binaries address the user's launchd/systemd domain by uid and ignore
// the HOME sandbox that test setups rely on, so a test exercising the trigger
// teardown path (e.g. triggers.test.ts "darwin: deletes com.ludics.dashboard.plist")
// would `launchctl disable`+`bootout` the developer/controller's REAL
// com.ludics.dashboard job — taking the live dashboard down. CI never saw it
// (Linux has no launchctl, so the call failed harmlessly); only a darwin
// controller running the suite was hit. See safeSyncOutput in src/spawn.ts.
process.env.LUDICS_TEST_MODE = "1";
