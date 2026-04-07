import { findProjectConfig, loadConfigSync, resolveProjectPath, resolveProposalsPath } from "./config.ts";

export async function runConfigCli(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (sub === "proposals-path") {
    const project = args[1];
    if (!project) {
      console.error("usage: ludics config proposals-path <project>");
      process.exit(1);
    }
    const projectDir = resolveProjectPath(project);
    if (!projectDir) {
      console.error(`project not found: ${project}`);
      process.exit(1);
    }
    const cfg = loadConfigSync();
    const projCfg = findProjectConfig(projectDir, cfg);
    console.log(resolveProposalsPath(projectDir, projCfg?.proposals_path));
  } else {
    console.error(`unknown config subcommand: ${sub} (available: proposals-path)`);
    process.exit(1);
  }
}
