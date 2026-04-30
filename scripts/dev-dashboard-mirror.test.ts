import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(import.meta.dir, "dev-dashboard-mirror.ts");
const SOURCE = readFileSync(SOURCE_PATH, "utf-8");

describe("dev-dashboard-mirror.ts /tmp prefix invariant", () => {
  // AC7 of gh-ludics-441 requires the mirror to land at
  // /tmp/ludics-dash-mirror-<random>/, not the platform tmpdir, which on
  // macOS resolves to /var/folders/.../T. The playbook example transcript
  // and reviewer probes both depend on this prefix.
  test("mkdtempSync uses the literal /tmp/ludics-dash-mirror- prefix", () => {
    expect(SOURCE).toContain('mkdtempSync("/tmp/ludics-dash-mirror-")');
  });

  test("does not import tmpdir from node:os", () => {
    expect(SOURCE).not.toMatch(/from\s+["']node:os["']/);
    expect(SOURCE).not.toMatch(/\btmpdir\s*\(/);
  });
});
