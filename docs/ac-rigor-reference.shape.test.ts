// Shape probe for gh-ludics-534 — pins AC1/AC4/AC5/AC6 invariants of
// docs/ac-rigor-reference.md and the new
// `### Pre-existing-state compatibility — name the recovery path for each
// rejectable shape` clause under `## Falsifier-shape family`.
//
// Mirrors docs/swe-textbook.shape.test.ts harness style; range slices use
// the awk-safe slice helper per
// feedback_awk_range_degenerate_when_start_matches_close.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ludicsRoot } from "./../src/config.ts";

const REFERENCE_PATH = "docs/ac-rigor-reference.md";
const NEW_HEADING =
  "### Pre-existing-state compatibility — name the recovery path for each rejectable shape";

function read(rel: string): string {
  return readFileSync(join(ludicsRoot(), rel), "utf-8");
}

// Range-scoped slice between opener and closer regexes; awk-safe
// semantics: skip the opener line, accumulate until (but not including)
// the closer line. Avoids the degenerate `/start/,/end/` trap when the
// start regex matches the closer.
function slice(body: string, opener: RegExp, closer: RegExp): string {
  const lines = body.split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      if (opener.test(line)) inside = true;
      continue;
    }
    if (closer.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n");
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("docs/ac-rigor-reference.md shape (gh-ludics-534)", () => {
  const body = read(REFERENCE_PATH);

  test("AC1 — total clause count is exactly 25 (^### lines)", () => {
    // Mutation: add or remove any `### ` clause anywhere in the doc and
    // the count moves off 25, failing this assertion. Harness: read the
    // whole file body, regex-count `^### ` lines.
    const matches = body.match(/^### /gm);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(25);
  });

  test("AC1/AC2 — new H3 literal present with em-dash separator", () => {
    // Mutation: rename the heading, delete it, or substitute the em-dash
    // (U+2014) with a hyphen-minus or colon → assertion fails because the
    // literal NEW_HEADING string would no longer appear in the body.
    expect(body).toContain(NEW_HEADING);
  });

  test("AC4/AC6 — clause body carries the five content-fingerprint literals", () => {
    // Slice from the new H3 to the next `### ` or `## ` heading using
    // awk-safe semantics. The new clause is the last `### ` in
    // `## Falsifier-shape family`, so the closer that actually fires is
    // the `## Verification-evidence family` H2.
    //
    // Mutation: empty the clause body or paraphrase any of the five
    // literals → at least one assertion below fails. The slice is
    // body-scoped, so the same literals appearing in unrelated paragraphs
    // elsewhere in the doc do not satisfy this fingerprint.
    const region = slice(
      body,
      new RegExp("^" + escapeRegex(NEW_HEADING)),
      /^(### |## )/,
    );
    expect(region).toContain("PERSISTED_TYPES");
    expect(region).toContain("gh-ludics-524");
    expect(region).toContain("slotRestore");
    expect(region).toContain("previousMode");
    expect(region).toContain("consistent rejection");
  });

  test("AC5 — preamble clause count updated from twenty-four to twenty-five", () => {
    // Mutation: revert the count word or leave both literals present →
    // one of these two assertions fails.
    expect(body).toContain("twenty-five clauses");
    expect(body).not.toContain("twenty-four clauses");
  });
});
