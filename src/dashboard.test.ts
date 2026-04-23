import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

function writeConfig(homeDir: string): string {
  const configDir = join(homeDir, ".config", "ludics");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(configPath, `state_repo: owner/ludics-state
state_path: harness
slots:
  count: 2
`);
  return configPath;
}

function harnessDir(): string {
  return join(TMP, "harness");
}

function writeT3codeSlotState(slot: number, state: object): void {
  const dir = join(harnessDir(), "t3code");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `slot-${slot}.json`), JSON.stringify(state));
}

function writeTmuxSlotState(slot: number, state: object): void {
  const dir = join(harnessDir(), "orchestration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `tmux-slot-${slot}.json`), JSON.stringify(state));
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-dashboard-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfig(TMP);
  process.env.LUDICS_HARNESS_DIR = harnessDir();
  mkdirSync(harnessDir(), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_CONFIG === undefined) {
    delete process.env.LUDICS_CONFIG;
  } else {
    process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  }
  if (ORIGINAL_HARNESS_DIR === undefined) {
    delete process.env.LUDICS_HARNESS_DIR;
  } else {
    process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("computeSlotLiveness", () => {
  // Dynamic import to pick up env changes
  async function getLiveness(slot: number, mode: string | null) {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    return computeSlotLiveness({ slotNum: slot, mode });
  }

  test("t3code slot with alive PID returns 'alive'", async () => {
    writeT3codeSlotState(1, {
      slot: 1,
      threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair", pid: process.pid },
    });
    expect(await getLiveness(1, "t3code")).toBe("alive");
  });

  test("t3code slot with dead PID returns 'interrupted'", async () => {
    writeT3codeSlotState(1, {
      slot: 1,
      threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair", pid: 99999999 },
    });
    expect(await getLiveness(1, "t3code")).toBe("interrupted");
  });

  test("tmux slot with alive PID returns 'alive'", async () => {
    writeTmuxSlotState(1, {
      slot: 1,
      ttydPids: {},
      orchestration: { stateFile: "orch.json", mode: "duo", pid: process.pid },
    });
    expect(await getLiveness(1, "tmux")).toBe("alive");
  });

  test("tmux slot with dead PID returns 'interrupted'", async () => {
    writeTmuxSlotState(1, {
      slot: 1,
      ttydPids: {},
      orchestration: { stateFile: "orch.json", mode: "duo", pid: 99999999 },
    });
    expect(await getLiveness(1, "tmux")).toBe("interrupted");
  });

  test("no slot state file returns null", async () => {
    expect(await getLiveness(1, "t3code")).toBe(null);
  });

  test("orchestration present but no pid returns null", async () => {
    writeT3codeSlotState(1, {
      slot: 1,
      threads: [],
      orchestration: { stateFile: "orch.json", mode: "pair" },
    });
    expect(await getLiveness(1, "t3code")).toBe(null);
  });

  test("null mode returns null", async () => {
    expect(await getLiveness(1, null)).toBe(null);
  });

  test("unknown mode returns null", async () => {
    expect(await getLiveness(1, "manual")).toBe(null);
  });

  test("explicit Liveness field 'interrupted' in slot data returns 'interrupted'", async () => {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    const { emptySlotData } = await import("./slots/json.ts");
    const slotData = { ...emptySlotData(1), process: "test", liveness: "interrupted" };
    expect(computeSlotLiveness({ slotNum: 1, mode: null, slotData })).toBe("interrupted");
  });

  test("explicit Liveness field null in slot data falls through to PID check", async () => {
    const { computeSlotLiveness } = await import("./dashboard.ts");
    const { emptySlotData } = await import("./slots/json.ts");
    const slotData = { ...emptySlotData(1), process: "test", liveness: null };
    expect(computeSlotLiveness({ slotNum: 1, mode: null, slotData })).toBe(null);
  });
});

describe("generateHealthData", () => {
  async function getHealthData() {
    const { generateHealthData, _resetDoctorCache } = await import("./dashboard.ts");
    _resetDoctorCache();
    return generateHealthData();
  }

  test("missing health report returns exists=false", async () => {
    const data = await getHealthData() as any;
    expect(data.healthReport.exists).toBe(false);
    expect(data.healthReport.content).toBe("");
    expect(data.healthReport.date).toBeNull();
  });

  test("present health report returns exists=true with content and date", async () => {
    const magDir = join(harnessDir(), "mag");
    mkdirSync(magDir, { recursive: true });
    const content = "# Health Check - 2026-04-09 12:00\n\nAll systems operational.\n";
    writeFileSync(join(magDir, "health-report.md"), content);

    const data = await getHealthData() as any;
    expect(data.healthReport.exists).toBe(true);
    expect(data.healthReport.content).toBe(content);
    expect(data.healthReport.date).toBe("2026-04-09 12:00");
  });

  test("health report without date header returns date=null", async () => {
    const magDir = join(harnessDir(), "mag");
    mkdirSync(magDir, { recursive: true });
    const content = "## Some other header\n\nNo date here.\n";
    writeFileSync(join(magDir, "health-report.md"), content);

    const data = await getHealthData() as any;
    expect(data.healthReport.exists).toBe(true);
    expect(data.healthReport.date).toBeNull();
    expect(data.healthReport.content).toBe(content);
  });

  test("doctor output has output and timestamp fields", async () => {
    const data = await getHealthData() as any;
    expect(typeof data.doctor.output).toBe("string");
    expect(typeof data.doctor.timestamp).toBe("string");
    // timestamp should be a valid ISO date
    expect(new Date(data.doctor.timestamp).toISOString()).toBe(data.doctor.timestamp);
  });

  test("doctor cache prevents re-spawn within TTL", async () => {
    const { generateHealthData, _resetDoctorCache } = await import("./dashboard.ts");
    _resetDoctorCache();

    const first = generateHealthData() as any;
    const second = generateHealthData() as any;

    // Same cached result
    expect(second.doctor.output).toBe(first.doctor.output);
    expect(second.doctor.timestamp).toBe(first.doctor.timestamp);
  });
});

describe("generateNotifications shape guard", () => {
  test("non-object JSONL lines are excluded from notifications output", async () => {
    const journalDir = join(harnessDir(), "journal");
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, "notifications.jsonl"),
      [
        '"just a string"',
        "[1,2,3]",
        "null",
        "42",
        '{"message":"valid notification","ts":"2026-04-10T00:00:00Z"}',
        "{bad json",
      ].join("\n") + "\n",
    );

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "notifications.json");
    const notifications = JSON.parse(readFileSync(outFile, "utf-8")) as unknown[];
    // Only the single valid object should appear
    expect(notifications.length).toBe(1);
    expect((notifications[0] as Record<string, unknown>).message).toBe("valid notification");
  });
});

describe("generateRecentlyCompleted shape guards", () => {
  function writeCompletedTask(id: string, title: string): void {
    const tasksDir = join(harnessDir(), "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Use a recent date so the task falls within the dashboard's 7-day window
    const completedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const startedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const createdDate = startedAt.slice(0, 10);
    writeFileSync(
      join(tasksDir, `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\nstatus: done\npriority: C\ncompleted: "${completedAt}"\nstarted: "${startedAt}"\ncreated: "${createdDate}"\neffort: small\ncontext: ludics\n---\n\n# ${title}\n`,
    );
  }

  test("non-object event lines do not create false pr_merged state", async () => {
    writeCompletedTask("task-test-1", "Test task");
    // generateRecentlyCompleted requires a retrospective file to include the task
    const retroDir = join(harnessDir(), "retrospectives");
    mkdirSync(retroDir, { recursive: true });
    writeFileSync(join(retroDir, "task-test-1.json"), '{"summary":"test"}');

    const journalDir = join(harnessDir(), "journal");
    mkdirSync(journalDir, { recursive: true });
    // Write events JSONL with non-object lines plus a real pr_merged event
    writeFileSync(
      join(journalDir, "events.jsonl"),
      [
        '"not an object"',
        "[1,2]",
        "null",
        // Only this valid line should be picked up
        JSON.stringify({ event_type: "pr_merged", task: "task-test-1", ts: "2026-04-10T00:00:00Z", epoch: 1775952000 }),
      ].join("\n") + "\n",
    );

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "recently-completed.json");
    const recent = JSON.parse(readFileSync(outFile, "utf-8")) as Record<string, unknown>[];
    const task = recent.find((t) => t.id === "task-test-1");
    expect(task).toBeDefined();
    expect(task!.prStatus).toBe("merged");
  });

  test("non-object retrospective JSON is silently ignored", async () => {
    writeCompletedTask("task-retro-1", "Retro test");
    const retroDir = join(harnessDir(), "retrospectives");
    mkdirSync(retroDir, { recursive: true });
    // The retrospective file must exist for the task to appear in recently-completed,
    // but we write non-object content to test the prUrl extraction guard
    writeFileSync(join(retroDir, "task-retro-1.json"), '"just a string"');

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "recently-completed.json");
    const recent = JSON.parse(readFileSync(outFile, "utf-8")) as Record<string, unknown>[];
    const task = recent.find((t) => t.id === "task-retro-1");
    expect(task).toBeDefined();
    // No PR URL should be set from the malformed retrospective
    expect(task!.prUrl).toBeNull();
  });
});

describe("generateT3code shape guard", () => {
  test("non-object starting marker does not produce false starting:true", async () => {
    const t3Dir = join(harnessDir(), "t3code");
    mkdirSync(t3Dir, { recursive: true });
    // Write a non-object starting marker
    writeFileSync(join(t3Dir, "starting.json"), '"hello"');

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "t3code.json");
    const t3code = JSON.parse(readFileSync(outFile, "utf-8")) as Record<string, unknown>;
    expect(t3code.starting).toBe(false);
  });
});

describe("deferred-launch sorting", () => {
  function writeDeferredTask(id: string, title: string, created: string | null): void {
    const tasksDir = join(harnessDir(), "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const createdLine = created ? `created: "${created}"` : "created: null";
    writeFileSync(
      join(tasksDir, `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\nstatus: deferred\npriority: B\n${createdLine}\ncontext: ludics\nproposal: docs/proposals/${id}.md\n---\n\n# ${title}\n`,
    );
  }

  test("tasks sorted by created date descending, null last", async () => {
    writeDeferredTask("task-oldest", "Oldest", "2026-01-01");
    writeDeferredTask("task-newest", "Newest", "2026-04-15");
    writeDeferredTask("task-middle", "Middle", "2026-03-10");
    writeDeferredTask("task-no-date", "No date", null);

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "deferred-launch.json");
    const items = JSON.parse(readFileSync(outFile, "utf-8")) as Record<string, unknown>[];
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(["task-newest", "task-middle", "task-oldest", "task-no-date"]);
    expect(items.find((it) => it.id === "task-newest")).toHaveProperty("created", "2026-04-15");
    expect(items.find((it) => it.id === "task-no-date")).toHaveProperty("created", null);
  });
});

describe("needs-confirmation sorting", () => {
  function writeNeedsConfirmationTask(id: string, title: string, created: string | null): void {
    const tasksDir = join(harnessDir(), "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const createdLine = created ? `created: "${created}"` : "created: null";
    writeFileSync(
      join(tasksDir, `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\nstatus: needs-confirmation\npriority: B\n${createdLine}\ncontext: ludics\n---\n\n# ${title}\n`,
    );
  }

  test("tasks sorted by created date descending, null last", async () => {
    writeNeedsConfirmationTask("task-nc-oldest", "Oldest", "2026-01-01");
    writeNeedsConfirmationTask("task-nc-newest", "Newest", "2026-04-15");
    writeNeedsConfirmationTask("task-nc-middle", "Middle", "2026-03-10");
    writeNeedsConfirmationTask("task-nc-no-date", "No date", null);

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "needs-confirmation.json");
    const items = JSON.parse(readFileSync(outFile, "utf-8")) as Record<string, unknown>[];
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(["task-nc-newest", "task-nc-middle", "task-nc-oldest", "task-nc-no-date"]);
  });
});

describe("tasks-tree link renders task.html", () => {
  function writeTask(id: string, title: string, overrides: string = ""): void {
    const tasksDir = join(harnessDir(), "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, `${id}.md`),
      `---\nid: ${id}\ntitle: "${title}"\nstatus: in-progress\npriority: B\ncreated: "2026-04-10"\ncontext: ludics\n${overrides}---\n\n# ${title}\n`,
    );
  }

  function collectTaskNodes(nodes: unknown[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const walk = (arr: unknown[]): void => {
      for (const n of arr) {
        if (!n || typeof n !== "object") continue;
        const node = n as Record<string, unknown>;
        if (node.kind === "task") out.push(node);
        if (Array.isArray(node.children)) walk(node.children as unknown[]);
      }
    };
    walk(nodes);
    return out;
  }

  test("task tree link points to /task.html?task=ID, not raw markdown", async () => {
    writeTask("task-abc123", "Example task");

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "tasks-tree.json");
    const tree = JSON.parse(readFileSync(outFile, "utf-8")) as unknown[];
    const tasks = collectTaskNodes(tree);
    const task = tasks.find((t) => t.id === "task-abc123");
    expect(task).toBeDefined();
    expect(task!.link).toBe("/task.html?task=task-abc123");
    // Regression guard: must not link to raw markdown endpoint.
    expect(String(task!.link)).not.toContain("/task-files/");
  });

  test("task IDs are URL-encoded in the generated link", async () => {
    writeTask("task-with space", "Needs encoding");

    const { dashboardGenerate } = await import("./dashboard.ts");
    const origErr = console.error;
    console.error = () => {};
    try {
      dashboardGenerate();
    } finally {
      console.error = origErr;
    }

    const outFile = join(harnessDir(), "dashboard", "data", "tasks-tree.json");
    const tree = JSON.parse(readFileSync(outFile, "utf-8")) as unknown[];
    const tasks = collectTaskNodes(tree);
    const task = tasks.find((t) => t.id === "task-with space");
    expect(task).toBeDefined();
    expect(task!.link).toBe("/task.html?task=task-with%20space");
  });
});

// Note: /api/slot-resume follows the exact same pattern as /api/slot-start
// (validate slot 1-6, spawnSync `ludics slot N resume`, return OK/error).
// slotResume() itself is already tested in src/slots/index.test.ts.
