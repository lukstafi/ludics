// Task types — frontmatter schema for task-*.md files

export interface TaskFrontmatter {
  id: string;
  title: string;
  project: string;
  status: string; // ready, in-progress, preempted, done, abandoned, merged, needs-confirmation
  priority: string; // A, B, C
  deadline: string | null;
  dependencies: {
    blocks: string[];
    blocked_by: string[];
    relates_to: string[];
    subtask_of: string | null;
  };
  effort: string; // small, medium, large
  context: string;
  uses_browser: boolean;
  slot: string | null;
  adapter: string | null;
  created: string;
  started: string | null;
  completed: string | null;
  modified: string | null;
  source: string; // github, watch, manual
  url?: string;
  github_issue?: number;
  github_title?: string;
  github_repo?: string;
  github_labels?: string;
  github_state?: string;
  github_state_reason?: string | null;
  github_updated_at?: string | null;
  github_closed_at?: string | null;
  milestone?: string;
  elaborated?: string;
  merged_into?: string;
  merged_from?: string[];
  t3code_threads?: string[];
}

export interface TaskYamlEntry {
  id: string;
  title: string;
  source: string;
  uses_browser?: boolean;
  repo?: string;
  url?: string;
  labels?: string;
  path?: string;
  line?: number;
}
