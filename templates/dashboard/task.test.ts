/**
 * Regression tests for the task.html renderer and dashboard.js task links.
 *
 * These tests re-implement the frontmatter handling inline (like
 * dashboard.test.ts does for the pending-action badge) so the same logic
 * can be verified without a browser. They also guard the dashboard.js
 * template against reintroducing raw task-files/ links.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function parseFrontmatter(yaml: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  if (!yaml) return result;
  const lines = yaml.split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (!/^["']/.test(value)) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    if (value === "") continue;
    if (value === "null" || value === "~") {
      result[key] = null;
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

describe("splitFrontmatter", () => {
  test("extracts YAML frontmatter and returns body without it", () => {
    const input = "---\nid: task-1\nstatus: in-progress\n---\n\n# Title\n\nBody text\n";
    const { frontmatter, body } = splitFrontmatter(input);
    expect(frontmatter).toBe("id: task-1\nstatus: in-progress");
    expect(body).toBe("# Title\n\nBody text\n");
  });

  test("returns empty frontmatter and original body when no fence is present", () => {
    const input = "# Just markdown\n\nNo frontmatter here.\n";
    const { frontmatter, body } = splitFrontmatter(input);
    expect(frontmatter).toBe("");
    expect(body).toBe(input);
  });

  test("handles CRLF line endings", () => {
    const input = "---\r\nid: task-crlf\r\n---\r\nBody\r\n";
    const { frontmatter, body } = splitFrontmatter(input);
    expect(frontmatter).toBe("id: task-crlf");
    expect(body).toBe("Body\r\n");
  });

  test("does not strip a --- that appears only mid-document", () => {
    const input = "# Heading\n\n---\n\nSome text after hr\n";
    const { frontmatter, body } = splitFrontmatter(input);
    expect(frontmatter).toBe("");
    expect(body).toBe(input);
  });
});

describe("parseFrontmatter", () => {
  test("extracts scalar keys used by the renderer", () => {
    const yaml = 'id: task-1\nstatus: in-progress\npriority: B\nproject: Ludics\nproposal: docs/proposals/task-1.md';
    const meta = parseFrontmatter(yaml);
    expect(meta.status).toBe("in-progress");
    expect(meta.priority).toBe("B");
    expect(meta.project).toBe("Ludics");
    expect(meta.proposal).toBe("docs/proposals/task-1.md");
  });

  test("strips surrounding single and double quotes", () => {
    const yaml = `title: "Task with spaces"\ncontext: 'Ludics'`;
    const meta = parseFrontmatter(yaml);
    expect(meta.title).toBe("Task with spaces");
    expect(meta.context).toBe("Ludics");
  });

  test("recognises null and ~ as null", () => {
    const yaml = "deadline: null\ncompleted: ~";
    const meta = parseFrontmatter(yaml);
    expect(meta.deadline).toBeNull();
    expect(meta.completed).toBeNull();
  });

  test("skips nested block children (indented lines)", () => {
    const yaml = "dependencies:\n  blocks: []\n  blocked_by: []\nstatus: ready";
    const meta = parseFrontmatter(yaml);
    // The `dependencies:` line has no scalar value (opens a block) and is skipped.
    expect(meta.dependencies).toBeUndefined();
    expect(meta.blocks).toBeUndefined();
    expect(meta.blocked_by).toBeUndefined();
    expect(meta.status).toBe("ready");
  });

  test("ignores comment and blank lines", () => {
    const yaml = "# header comment\n\nstatus: ready\n# trailing comment";
    const meta = parseFrontmatter(yaml);
    expect(meta.status).toBe("ready");
  });

  test("round-trip: split then parse yields the expected fields", () => {
    const raw = [
      "---",
      "id: task-round-trip",
      'title: "Round trip"',
      "status: in-progress",
      "priority: A",
      "project: Ludics",
      "proposal: docs/proposals/task-round-trip.md",
      "dependencies:",
      "  blocks: []",
      "  blocked_by: []",
      "---",
      "",
      "# Round trip",
      "",
      "Body content.",
      "",
    ].join("\n");

    const { frontmatter, body } = splitFrontmatter(raw);
    const meta = parseFrontmatter(frontmatter);
    expect(meta.id).toBe("task-round-trip");
    expect(meta.title).toBe("Round trip");
    expect(meta.status).toBe("in-progress");
    expect(meta.priority).toBe("A");
    expect(meta.project).toBe("Ludics");
    expect(meta.proposal).toBe("docs/proposals/task-round-trip.md");
    expect(body).toContain("# Round trip");
    expect(body).toContain("Body content.");
    // The frontmatter fence itself must not leak into the body.
    expect(body.startsWith("---")).toBe(false);
  });
});

describe("task.html template", () => {
  const templatePath = join(import.meta.dir, "task.html");
  const template = readFileSync(templatePath, "utf-8");

  test("fetches from the /task-files/ endpoint", () => {
    expect(template).toContain("/task-files/${encodeURIComponent(taskId)}.md");
  });

  test("calls markdownToHtml on the stripped body", () => {
    expect(template).toContain("markdownToHtml(body)");
  });

  test("renders status, priority, and project badges", () => {
    expect(template).toContain("meta.status");
    expect(template).toContain("meta.priority");
    expect(template).toContain("meta.project");
  });

  test("links back to the proposal renderer when frontmatter has a proposal field", () => {
    expect(template).toContain("proposalLink(taskId)");
    expect(template).toContain("meta.proposal");
  });

  test("sets the document title to include the task ID", () => {
    expect(template).toContain("ludics Task: ${taskId}");
  });

  test("fetches data/milestone-projects.json for project gating", () => {
    expect(template).toContain("data/milestone-projects.json");
    expect(template).toContain("milestoneProjects");
  });

  test("renders milestone badge gated by milestoneProjects with case-insensitive project check", () => {
    expect(template).toContain("meta.milestone");
    expect(template).toContain("milestoneProjects.includes(meta.project.toLowerCase())");
  });
});

describe("parseFrontmatter milestone field", () => {
  test("extracts milestone as a plain value", () => {
    const yaml = "id: task-1\nstatus: ready\nmilestone: v1.0";
    const meta = parseFrontmatter(yaml);
    expect(meta.milestone).toBe("v1.0");
  });

  test("strips surrounding double-quotes from milestone value", () => {
    const yaml = 'milestone: "v0.7.1"';
    const meta = parseFrontmatter(yaml);
    expect(meta.milestone).toBe("v0.7.1");
  });

  test("strips surrounding single-quotes from milestone value", () => {
    const yaml = "milestone: 'v0.7.1'";
    const meta = parseFrontmatter(yaml);
    expect(meta.milestone).toBe("v0.7.1");
  });

  test("null milestone value is parsed as null", () => {
    const yaml = "milestone: null";
    const meta = parseFrontmatter(yaml);
    expect(meta.milestone).toBeNull();
  });
});

describe("dashboard.js task links", () => {
  const templatePath = join(import.meta.dir, "dashboard.js");
  const template = readFileSync(templatePath, "utf-8");

  test("needs-confirmation link uses taskLink helper", () => {
    expect(template).toContain('needs-confirm-link" href="${taskLink(task.id)}"');
  });

  test("unanswered-questions link uses taskLink helper", () => {
    expect(template).toContain('unanswered-q-link" href="${taskLink(task.id)}"');
  });

  test("deferred-launch fallback uses taskLink/proposalLink helpers", () => {
    expect(template).toContain("proposalLink(task.id)");
    expect(template).toContain("taskLink(task.id)");
  });

  test("task-link query params use encodeURIComponent, never escapeHtml", () => {
    // Regression guard: escapeHtml(id) protects against attribute injection
    // but does NOT percent-encode URL-delimiter characters like `&`, `#`,
    // `?`, or `+`. A task id containing any of those would break query-param
    // parsing on task.html. Only encodeURIComponent is safe here (now routed
    // through the taskLink/proposalLink helpers in links.js). Both approaches
    // are safe for attribute-escaping because encodeURIComponent also
    // percent-encodes `"`, `'`, `<`, `>`, and `&`.
    expect(template).not.toMatch(/task\.html\?task=\$\{escapeHtml\(task\.id\)\}/);
    // Also guard that the inline `task.html?task=${...}` pattern has been
    // fully replaced with the helper — a regression where a new call site
    // spells the URL inline would slip past the helper's centralization.
    expect(template).not.toMatch(/task\.html\?task=\$\{/);
    expect(template).not.toMatch(/proposal\.html\?task=\$\{/);
  });

  test("no raw task-files/ links remain in client-side rendering", () => {
    // Regression guard: the original plan moved all three link patterns off
    // `task-files/` to `task.html`. If a new link is introduced later, this
    // test flags it so the migration stays exhaustive.
    expect(template).not.toMatch(/href="task-files\//);
    expect(template).not.toMatch(/`task-files\//);
  });
});

describe("links.js taskLink / proposalLink helpers", () => {
  const linksPath = join(import.meta.dir, "links.js");
  const linksSource = readFileSync(linksPath, "utf-8");

  // links.js is a classic <script> file with no exports. Evaluate its source
  // in a fresh Function scope and return the helpers out for direct testing.
  // This is the same readFileSync + new Function pattern used by other
  // template-asset tests.
  const helpers = new Function(
    `${linksSource}\nreturn { taskLink, proposalLink };`,
  )() as { taskLink: (id: string) => string; proposalLink: (id: string) => string };

  const ids = ["plain", "task&x", "task#x", "task?x", "task+x", "task with space", "tâsk-ünîcödé"];

  for (const id of ids) {
    test(`taskLink(${JSON.stringify(id)}) round-trips through URL`, () => {
      const url = new URL(helpers.taskLink(id), "http://x/");
      expect(url.pathname).toBe("/task.html");
      expect(url.searchParams.get("task")).toBe(id);
    });

    test(`proposalLink(${JSON.stringify(id)}) round-trips through URL`, () => {
      const url = new URL(helpers.proposalLink(id), "http://x/");
      expect(url.pathname).toBe("/proposal.html");
      expect(url.searchParams.get("task")).toBe(id);
    });
  }

  test("both helpers return absolute paths with a leading slash", () => {
    expect(helpers.taskLink("t").startsWith("/")).toBe(true);
    expect(helpers.proposalLink("t").startsWith("/")).toBe(true);
  });

  test("index.html, task.html, and retrospective.html load links.js", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "index.html"), "utf-8");
    const taskSrc = readFileSync(join(import.meta.dir, "task.html"), "utf-8");
    const retroSrc = readFileSync(join(import.meta.dir, "retrospective.html"), "utf-8");
    expect(indexSrc).toContain('<script src="links.js"></script>');
    expect(taskSrc).toContain('<script src="links.js"></script>');
    expect(retroSrc).toContain('<script src="links.js"></script>');
  });
});
