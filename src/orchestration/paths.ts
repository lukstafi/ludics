import { join } from "path";
import { harnessDir as defaultHarnessDir } from "../config.ts";

/** Resolve the absolute path to a task spec file under a specific harness. */
export function taskFilePath(taskId: string, harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "tasks", `${taskId}.md`);
}
