import { existsSync, readFileSync, writeFileSync } from "fs";
import { safeSyncOutput } from "../spawn.ts";

/** Returns true if value looks like a GitHub PR URL. */
export function isPrUrl(value: string): boolean {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(value.trim());
}

/** Parse a GitHub PR URL into repo slug and PR number. */
function parsePrUrl(prUrl: string): { repo: string; prNumber: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { repo: match[1], prNumber: match[2] };
}

/**
 * Run `gh api --paginate <endpoint> --jq <jqFilter>`, sum the per-page
 * integers from stdout, and return the total.  Returns 0 on any error.
 * Appends `per_page=100` to reduce pagination round-trips.
 */
function paginatedGhApiCount(endpoint: string, jqFilter: string): number {
  const sep = endpoint.includes("?") ? "&" : "?";
  const fullEndpoint = `${endpoint}${sep}per_page=100`;
  const r = safeSyncOutput(
    ["gh", "api", "--paginate", fullEndpoint, "--jq", jqFilter],
  );
  if (!r.ok) return 0;
  // --paginate + --jq outputs one number per page; sum them
  return r.stdout.split("\n").reduce((sum, line) => sum + (parseInt(line, 10) || 0), 0);
}

/** Returns the count of new comments/reviews on a PR since sinceEpoch (Unix seconds). */
export function fetchNewPrCommentCount(prUrl: string, sinceEpoch: number): number {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return 0;
  const { repo, prNumber } = parsed;
  const since = new Date(sinceEpoch * 1000).toISOString();

  const reviewComments = paginatedGhApiCount(
    `repos/${repo}/pulls/${prNumber}/comments`,
    `[.[] | select(.created_at > "${since}")] | length`,
  );
  const issueComments = paginatedGhApiCount(
    `repos/${repo}/issues/${prNumber}/comments`,
    `[.[] | select(.created_at > "${since}")] | length`,
  );
  const reviews = paginatedGhApiCount(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    `[.[] | select(.submitted_at > "${since}")] | length`,
  );

  return reviewComments + issueComments + reviews;
}

/** Check if a GitHub PR has been merged. */
export function isPrMerged(prUrl: string): boolean {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return false;
  const { repo, prNumber } = parsed;
  const r = safeSyncOutput(
    ["gh", "api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".merged"],
  );
  return r.ok && r.stdout === "true";
}

/**
 * Returns true if the PR has a submitted (non-PENDING) review from
 * `chatgpt-codex-connector[bot]`.  Used to detect whether the repo-level
 * auto-triggered Codex review succeeded, so we can skip the explicit fallback.
 * Fails closed: returns false on API failure so the fallback still fires.
 */
export function hasCodexSubmittedReview(prUrl: string): boolean {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return false;
  const { repo, prNumber } = parsed;
  return paginatedGhApiCount(
    `repos/${repo}/pulls/${prNumber}/reviews`,
    '[.[] | select(.state != "PENDING" and .user.login == "chatgpt-codex-connector[bot]")] | length',
  ) > 0;
}

/**
 * If the pr file contains markdown/text rather than a GitHub PR URL, use the content as the
 * PR body to auto-create a PR via `gh pr create`, then rewrite the file with just the URL.
 * Returns the final PR URL (unchanged if already a URL), or null on failure.
 */
export function validateAndFixPrFile(
  prFile: string,
  worktreePath: string,
  branch: string,
): string | null {
  if (!existsSync(prFile)) return null;
  const content = readFileSync(prFile, "utf-8").trim();
  if (!content) return null;

  if (isPrUrl(content)) return content;

  // Content looks like a PR description — try to create the PR automatically.
  // First ensure the branch is pushed (coder may have committed but not pushed).
  safeSyncOutput(["git", "push", "-u", "origin", branch], { cwd: worktreePath });
  // best-effort — gh pr create will fail if push fails

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : `feat: ${branch}`;

  const result = safeSyncOutput(
    ["gh", "pr", "create", "--title", title, "--body", content, "--head", branch],
    { cwd: worktreePath },
  );
  if (!result.ok) return null;
  const url = result.stdout;
  if (!isPrUrl(url)) return null;
  writeFileSync(prFile, url + "\n");
  return url;
}

export interface PrVerification {
  exists: boolean;
  state?: "open" | "closed";
  merged?: boolean;
  mergeableState?: string | null;
  reason: string;
}

/**
 * Inspect a GitHub PR via the API. Returns structured info for both
 * pr-create (does it exist?) and final-merge (is it merged?) gates.
 */
export function getPrVerification(prUrl: string): PrVerification {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return { exists: false, reason: "malformed PR URL" };
  const { repo, prNumber } = parsed;
  const result = safeSyncOutput(
    ["gh", "api", `repos/${repo}/pulls/${prNumber}`, "--jq",
     "[.state, .merged, .mergeable_state] | @tsv"],
  );
  if (!result.ok) {
    const is404 = result.stderr.includes("404") || result.stderr.includes("Not Found");
    return {
      exists: false,
      reason: is404 ? "PR not found on GitHub" : `GitHub API error: ${result.stderr.slice(0, 120)}`,
    };
  }
  const parts = result.stdout.split("\t");
  const [prState, mergedStr, mergeableState] = parts;
  return {
    exists: true,
    state: prState as "open" | "closed",
    merged: mergedStr === "true",
    mergeableState: mergeableState === "null" ? null : (mergeableState ?? null),
    reason: "ok",
  };
}

/** Default focus prompt for the @codex review PR comment. */
export const DEFAULT_CODEX_REVIEW_PROMPT =
  "Focus on bugs, correctness issues, and edge cases. Do not check adherence to a spec or plan.";

/**
 * Post `@codex review` as a PR comment to trigger the GitHub-native Codex
 * review integration.  Returns true on success, false on failure.
 * Best-effort: failures do not abort orchestration.
 */
export function postCodexReviewComment(
  prUrl: string,
  prompt?: string,
): boolean {
  const trimmed = prompt?.trim();
  const body = trimmed
    ? `@codex review ${trimmed}`
    : `@codex review ${DEFAULT_CODEX_REVIEW_PROMPT}`;
  return safeSyncOutput(["gh", "pr", "comment", prUrl, "--body", body]).ok;
}
