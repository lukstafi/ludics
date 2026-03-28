import { existsSync, readFileSync, writeFileSync } from "fs";

/** Returns true if value looks like a GitHub PR URL. */
export function isPrUrl(value: string): boolean {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(value.trim());
}

/** Returns the count of new comments/reviews on a PR since sinceEpoch (Unix seconds). */
export function fetchNewPrCommentCount(prUrl: string, sinceEpoch: number): number {
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return 0;
  const [, repo, prNumber] = match;
  const since = new Date(sinceEpoch * 1000).toISOString();

  function countViaGhApi(args: string[]): number {
    try {
      const result = Bun.spawnSync(["gh", "api", ...args], {
        stdout: "pipe",
        stderr: "ignore",
        env: process.env as Record<string, string>,
      });
      if (result.exitCode !== 0) return 0;
      return parseInt(result.stdout.toString().trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  const reviewComments = countViaGhApi([
    `repos/${repo}/pulls/${prNumber}/comments`,
    "--jq",
    `[.[] | select(.created_at > "${since}")] | length`,
  ]);
  const issueComments = countViaGhApi([
    `repos/${repo}/issues/${prNumber}/comments`,
    "--jq",
    `[.[] | select(.created_at > "${since}")] | length`,
  ]);
  const reviews = countViaGhApi([
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "--jq",
    `[.[] | select(.submitted_at > "${since}")] | length`,
  ]);

  return reviewComments + issueComments + reviews;
}

/** Check if a GitHub PR has been merged. */
export function isPrMerged(prUrl: string): boolean {
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return false;
  const [, repo, prNumber] = match;
  try {
    const result = Bun.spawnSync(
      ["gh", "api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".merged"],
      { stdout: "pipe", stderr: "ignore", env: process.env as Record<string, string> },
    );
    if (result.exitCode !== 0) return false;
    return result.stdout.toString().trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Returns true if the PR has a `+1` (thumbs-up) reaction from the Codex connector bot
 * (`chatgpt-codex-connector[bot]`), indicating automated approval.
 */
export function hasPrApprovalReaction(prUrl: string): boolean {
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return false;
  const [, repo, prNumber] = match;
  try {
    const result = Bun.spawnSync(
      [
        "gh", "api",
        `repos/${repo}/issues/${prNumber}/reactions`,
        "--jq",
        '[.[] | select(.content == "+1" and (.user.login | test("codex")))] | length',
      ],
      { stdout: "pipe", stderr: "ignore", env: process.env as Record<string, string> },
    );
    if (result.exitCode !== 0) return false;
    return parseInt(result.stdout.toString().trim(), 10) > 0;
  } catch {
    return false;
  }
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
  try {
    Bun.spawnSync(
      ["git", "push", "-u", "origin", branch],
      { cwd: worktreePath, stdout: "ignore", stderr: "ignore", env: process.env as Record<string, string> },
    );
  } catch { /* best-effort — gh pr create will fail if push fails */ }

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : `feat: ${branch}`;

  try {
    const result = Bun.spawnSync(
      ["gh", "pr", "create", "--title", title, "--body", content, "--head", branch],
      {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );
    if (result.exitCode !== 0) return null;
    const url = result.stdout.toString().trim();
    if (!isPrUrl(url)) return null;
    writeFileSync(prFile, url + "\n");
    return url;
  } catch {
    return null;
  }
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
  try {
    const result = Bun.spawnSync(
      ["gh", "pr", "comment", prUrl, "--body", body],
      { stdout: "ignore", stderr: "ignore", env: process.env as Record<string, string> },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
