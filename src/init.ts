// Init command — idempotent setup/update for the full ludics environment

import { existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync, symlinkSync, unlinkSync, chmodSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";
import { ludicsRoot, pointerConfigPath, harnessDir } from "./config.ts";
import { dashboardInstall, dashboardStop, dashboardServe } from "./dashboard.ts";
import { triggersInstall } from "./triggers.ts";

const POINTER_CONFIG_TEMPLATE = `# ludics pointer config — edit state_repo, then run: ludics init
state_repo: your-username/your-private-repo
state_path: harness
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function runInit(args: string[]): Promise<void> {
  const noHooks = args.includes("--no-hooks");
  const noDashboard = args.includes("--no-dashboard");
  const noTriggers = args.includes("--no-triggers");

  const root = ludicsRoot();

  // 1. Symlink binary
  symlinkBinary(root);

  // 2. Config file
  const configOk = ensureConfig();

  // 3. State repo
  const { repoDir, statePath } = cloneStateRepo();

  // 4. Harness directory
  if (repoDir) {
    ensureHarness(root, repoDir, statePath);
  }

  // 5. Mag directory
  if (repoDir) {
    ensureMag(root, repoDir, statePath);
  }

  // 6. Skills
  if (!noHooks && repoDir) {
    installSkills(root, repoDir, statePath);
  }

  // 7. Stop hook
  if (!noHooks) {
    installStopHook(root);
  }

  // 8. Dashboard
  if (!noDashboard && repoDir) {
    console.log("\n--- Dashboard ---");
    try {
      dashboardInstall();
      // Restart the dashboard server if it was running (picks up new binary)
      const pgrep = Bun.spawnSync(["pgrep", "-f", "ludics dashboard serve"], { stdout: "pipe", stderr: "pipe" });
      const pids = pgrep.exitCode === 0 ? pgrep.stdout.toString().trim().split("\n").filter((p) => p.trim() !== String(process.pid)) : [];
      if (pids.length > 0) {
        console.log("  restarting dashboard server...");
        dashboardStop();
        // Spawn as detached background process — dashboardServe() blocks
        const proc = Bun.spawn(["ludics", "dashboard", "serve"], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        proc.unref();
      }
    } catch (err) {
      console.warn(`warning: dashboard install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 9. Backend-specific setup
  {
    const { globalAdapter } = await import("./config.ts");
    const adapter = globalAdapter();
    if (adapter === "tmux") {
      console.log("\n--- tmux backend ---");
      const hasTmux = Bun.spawnSync(["which", "tmux"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
      if (!hasTmux) {
        console.error("error: tmux adapter requires tmux to be installed");
        process.exit(1);
      }
      console.log("  tmux: available");
      const hasTtyd = Bun.spawnSync(["which", "ttyd"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
      if (!hasTtyd) {
        console.error(
          "error: tmux adapter requires ttyd to be installed.\n" +
          "  Install from https://github.com/nicely/ttyd\n" +
          "  macOS: brew install ttyd\n" +
          "  Linux: see https://github.com/nicely/ttyd#installation"
        );
        process.exit(1);
      }
      console.log("  ttyd: available");
      // Pre-create the ludics tmux session if not already running
      const { tmuxHasSession, tmuxNewSession } = await import("./adapters/tmux.ts");
      if (!tmuxHasSession("ludics")) {
        tmuxNewSession("ludics");
        // Disable mouse to prevent copy-mode lockups
        Bun.spawnSync(["tmux", "set-option", "-t", "ludics", "mouse", "off"], {
          stdout: "pipe", stderr: "pipe",
        });
        console.log("  created tmux session 'ludics'");
      } else {
        console.log("  tmux session 'ludics' already exists");
      }
    }
  }

  // 10. Triggers
  if (!noTriggers && configOk) {
    console.log("\n--- Triggers ---");
    try {
      triggersInstall();
    } catch (err) {
      console.warn(`warning: triggers install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\nludics init complete.");
}

function symlinkBinary(root: string): void {
  console.log("--- Binary symlink ---");
  const binSource = join(root, "bin", "ludics");
  const localBin = join(process.env.HOME!, ".local", "bin");
  const binTarget = join(localBin, "ludics");

  mkdirSync(localBin, { recursive: true });

  // Check if symlink already correct
  try {
    const stat = lstatSync(binTarget);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(binTarget);
      if (target === binSource) {
        console.log(`symlink already correct: ${binTarget} -> ${binSource}`);
        checkPath(localBin);
        return;
      }
    }
    // Wrong target or not a symlink — remove and recreate
    unlinkSync(binTarget);
  } catch {
    // Doesn't exist — will create below
  }

  symlinkSync(binSource, binTarget);
  console.log(`symlinked ${binTarget} -> ${binSource}`);
  checkPath(localBin);
}

function checkPath(dir: string): void {
  const pathDirs = (process.env.PATH ?? "").split(":");
  if (!pathDirs.includes(dir)) {
    console.warn(`warning: ${dir} is not in $PATH — add it to your shell profile`);
  }
}

function ensureConfig(): boolean {
  console.log("\n--- Config ---");

  // Migrate legacy pai-lite config to new location
  const newPath = join(process.env.HOME!, ".config", "ludics", "config.yaml");
  const legacyPath = join(process.env.HOME!, ".config", "pai-lite", "config.yaml");
  if (!existsSync(newPath) && existsSync(legacyPath)) {
    mkdirSync(dirname(newPath), { recursive: true });
    copyFileSync(legacyPath, newPath);
    console.log(`migrated config: ${legacyPath} -> ${newPath}`);
  }

  const configPath = pointerConfigPath();
  const configDir = dirname(configPath);

  if (existsSync(configPath)) {
    console.log(`config already exists: ${configPath}`);
    // Warn if placeholder
    const content = readFileSync(configPath, "utf-8");
    if (content.includes("your-username/your-private-repo")) {
      console.warn("warning: state_repo still has placeholder value — edit the config file");
      return false;
    }
    return true;
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, POINTER_CONFIG_TEMPLATE);
  console.log(`created config: ${configPath}`);
  console.warn("warning: edit state_repo in the config file, then re-run: ludics init");
  return false;
}

function cloneStateRepo(): { repoDir: string | null; statePath: string } {
  console.log("\n--- State repo ---");
  const configPath = pointerConfigPath();

  if (!existsSync(configPath)) {
    console.log("no config file — skipping state repo");
    return { repoDir: null, statePath: "harness" };
  }

  const content = readFileSync(configPath, "utf-8");
  const parsed: unknown = YAML.parse(content);
  const data = isRecord(parsed) ? parsed : {};
  const stateRepo = (data.state_repo as string) ?? "";
  const statePath = (data.state_path as string) || "harness";

  if (!stateRepo || stateRepo.includes("your-username")) {
    console.log("state_repo not configured — skipping clone");
    return { repoDir: null, statePath };
  }

  const repoName = stateRepo.split("/").pop()!;
  const repoDir = join(process.env.HOME!, repoName);

  if (existsSync(repoDir)) {
    console.log(`state repo already exists: ${repoDir}`);
  } else {
    console.log(`cloning git@github.com:${stateRepo}.git to ${repoDir}...`);
    const result = Bun.spawnSync(["git", "clone", `git@github.com:${stateRepo}.git`, repoDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      console.error("error: git clone failed");
      return { repoDir: null, statePath };
    }
  }

  return { repoDir, statePath };
}

function ensureHarness(root: string, repoDir: string, statePath: string): void {
  console.log("\n--- Harness directory ---");
  const harnessDir = join(repoDir, statePath);
  mkdirSync(harnessDir, { recursive: true });

  const templateDir = join(root, "templates", "harness");
  const templateFiles = ["config.yaml", "slots.md", "CLAUDE.md"];

  for (const file of templateFiles) {
    const dest = join(harnessDir, file);
    if (existsSync(dest)) {
      console.log(`  ${file} already exists`);
    } else {
      const src = join(templateDir, file);
      if (existsSync(src)) {
        copyFileSync(src, dest);
        console.log(`  copied ${file}`);
      } else {
        console.warn(`  warning: template not found: ${src}`);
      }
    }
  }

  // Create subdirectories
  for (const dir of ["tasks", "journal"]) {
    const dirPath = join(harnessDir, dir);
    mkdirSync(dirPath, { recursive: true });
    console.log(`  ${dir}/ ensured`);
  }
}

function ensureMag(root: string, repoDir: string, statePath: string): void {
  console.log("\n--- Mag directory ---");
  const harnessDir = join(repoDir, statePath);
  mkdirSync(join(harnessDir, "mag", "memory", "projects"), { recursive: true });

  const templateDir = join(root, "templates", "mag");
  const magFiles = [
    { src: "context.md", dest: "mag/context.md" },
    { src: "memory/corrections.md", dest: "mag/memory/corrections.md" },
    { src: "memory/tools.md", dest: "mag/memory/tools.md" },
    { src: "memory/workflows.md", dest: "mag/memory/workflows.md" },
  ];

  for (const { src, dest } of magFiles) {
    const destPath = join(harnessDir, dest);
    if (existsSync(destPath)) {
      console.log(`  ${dest} already exists`);
    } else {
      const srcPath = join(templateDir, src);
      if (existsSync(srcPath)) {
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
        console.log(`  copied ${dest}`);
      } else {
        console.warn(`  warning: template not found: ${srcPath}`);
      }
    }
  }
}

function installSkills(root: string, repoDir: string, statePath: string): void {
  console.log("\n--- Skills ---");
  const skillsDir = join(root, "skills");
  const harnessDir = join(repoDir, statePath);
  const destDir = join(harnessDir, ".claude", "commands");
  mkdirSync(destDir, { recursive: true });

  if (!existsSync(skillsDir)) {
    console.warn("warning: skills directory not found");
    return;
  }

  const files = readdirSync(skillsDir).filter(f => f.endsWith(".md"));
  let count = 0;
  for (const file of files) {
    copyFileSync(join(skillsDir, file), join(destDir, file));
    count++;
  }
  console.log(`copied ${count} skill(s) to ${destDir}`);
}

function installStopHook(root: string): void {
  console.log("\n--- Stop hook ---");
  const hookSrc = join(root, "templates", "hooks", "ludics-on-stop.sh");
  const hookDest = join(process.env.HOME!, ".local", "bin", "ludics-on-stop");

  if (!existsSync(hookSrc)) {
    console.warn("warning: stop hook template not found");
    return;
  }

  mkdirSync(dirname(hookDest), { recursive: true });
  copyFileSync(hookSrc, hookDest);
  chmodSync(hookDest, 0o755);
  console.log(`installed stop hook: ${hookDest}`);

  // Configure Claude settings.json
  const settingsPath = join(process.env.HOME!, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
      settings = isRecord(parsed) ? parsed : {};
    } catch {
      console.warn("warning: could not parse ~/.claude/settings.json — skipping hook config");
      return;
    }
  }

  if (settings.hooks) {
    console.log("hooks already configured in ~/.claude/settings.json — not overwriting");
  } else {
    settings.hooks = {
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: hookDest,
            },
          ],
        },
      ],
    };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("configured stop hook in ~/.claude/settings.json");
  }
}
