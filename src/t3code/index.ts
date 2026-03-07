import { harnessDir } from "../config.ts";
import { ensureServer, serverStatus, stopServer, t3codeServerPath } from "./server.ts";

export async function runT3Code(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const harness = harnessDir();

  switch (sub) {
    case "":
    case "status": {
      const status = await serverStatus({ harnessDir: harness });
      if (!status.record) {
        console.log("t3code: stopped");
        return;
      }

      console.log(status.running ? "t3code: running" : "t3code: unavailable");
      console.log(`pid: ${status.record.pid}`);
      console.log(`web: ${status.record.webUrl}`);
      console.log(`ws: ${status.record.wsUrl}`);
      console.log(`state: ${status.record.stateDir}`);
      console.log(`record: ${t3codeServerPath(harness)}`);
      if (status.reason) console.log(`reason: ${status.reason}`);
      if (status.snapshot) {
        console.log(`projects: ${status.snapshot.projects.length}`);
        console.log(`threads: ${status.snapshot.threads.length}`);
      }
      return;
    }

    case "start": {
      const record = await ensureServer({ harnessDir: harness });
      console.log(record.webUrl);
      return;
    }

    case "stop": {
      const stopped = await stopServer({ harnessDir: harness });
      console.log(stopped ? "t3code: stopped" : "t3code: not running");
      return;
    }

    default:
      throw new Error(`unknown t3code subcommand: ${sub} (use: status, start, stop)`);
  }
}
