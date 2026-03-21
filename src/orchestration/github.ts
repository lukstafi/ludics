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
