import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Safety net: all tests get an isolated harness directory by default.
// Individual test files can override this in their own beforeAll/beforeEach.
if (!process.env.LUDICS_HARNESS_DIR) {
  process.env.LUDICS_HARNESS_DIR = mkdtempSync(join(tmpdir(), "ludics-test-"));
}
