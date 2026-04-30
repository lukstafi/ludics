import { describe, expect, test } from "bun:test";
import { parseSourceKind } from "./types.ts";

describe("parseSourceKind", () => {
  test("accepts all 7 valid SourceKind values unchanged", () => {
    expect(parseSourceKind("cli")).toBe("cli");
    expect(parseSourceKind("vscode")).toBe("vscode");
    expect(parseSourceKind("exec")).toBe("exec");
    expect(parseSourceKind("appServer")).toBe("appServer");
    expect(parseSourceKind("app")).toBe("app");
    expect(parseSourceKind("web")).toBe("web");
    expect(parseSourceKind("unknown")).toBe("unknown");
  });

  test("trims surrounding whitespace before whitelist match", () => {
    expect(parseSourceKind("  vscode  ")).toBe("vscode");
    expect(parseSourceKind("\tcli\n")).toBe("cli");
  });

  test("collapses null/undefined/empty inputs to \"unknown\"", () => {
    expect(parseSourceKind(null)).toBe("unknown");
    expect(parseSourceKind(undefined)).toBe("unknown");
    expect(parseSourceKind("")).toBe("unknown");
    expect(parseSourceKind("   ")).toBe("unknown");
  });

  test("collapses unrecognized strings to \"unknown\"", () => {
    expect(parseSourceKind("bogus")).toBe("unknown");
    expect(parseSourceKind("CLI")).toBe("unknown"); // case-sensitive whitelist
    expect(parseSourceKind("complete")).toBe("unknown"); // typo case
  });

  test("collapses non-string inputs to \"unknown\"", () => {
    expect(parseSourceKind(42)).toBe("unknown");
    expect(parseSourceKind(true)).toBe("unknown");
    expect(parseSourceKind({})).toBe("unknown");
    expect(parseSourceKind([])).toBe("unknown");
  });
});
