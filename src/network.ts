// Network configuration — hostname detection and URL helpers

import { loadConfigSync } from "./config.ts";
import { safeSyncOutput } from "./spawn.ts";

export function networkMode(): string {
  const config = loadConfigSync();
  return config.cluster?.transport ?? "localhost";
}

function hostnameFromConfig(): string {
  const config = loadConfigSync();
  return config.network?.hostname ?? "";
}

function findTailscaleCli(): string | null {
  const which = safeSyncOutput(["which", "tailscale"]);
  if (which.ok) return which.stdout;
  // macOS: Tailscale app bundle CLI
  const macosPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  try { if (Bun.file(macosPath).size > 0) return macosPath; } catch { /* not installed */ }
  return null;
}

export function hostnameTailscale(): string | null {
  const tsCli = findTailscaleCli();
  if (!tsCli) return null;

  const result = safeSyncOutput([tsCli, "status", "--json"]);
  if (!result.ok) return null;

  try {
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    const self = data.Self as Record<string, unknown> | undefined;
    if (!self) return null;

    const dnsName = self.DNSName as string | undefined;
    if (dnsName) return dnsName.replace(/\.$/, "");

    const hostName = self.HostName as string | undefined;
    if (hostName) return hostName;
  } catch {
    // parse failure
  }
  return null;
}

export function networkHostname(): string {
  const mode = networkMode();

  if (mode === "localhost") return "localhost";

  if (mode === "tailscale") {
    const tsHost = hostnameTailscale();
    if (tsHost) return tsHost;

    const configHost = hostnameFromConfig();
    if (configHost) return configHost;

    // Fallback: use cluster machine host field (works from launchd where Tailscale CLI is unavailable)
    try {
      const { clusterCurrentMachine } = require("./cluster.ts");
      const machine = clusterCurrentMachine();
      if (machine?.host) return machine.host;
    } catch { /* cluster not available */ }

    console.error("ludics: tailscale mode enabled but cannot determine hostname");
    return "localhost";
  }

  return "localhost";
}

export function getUrl(port: number | string, protocol: string = "http"): string {
  return `${protocol}://${networkHostname()}:${port}`;
}


export function networkStatus(): void {
  const mode = networkMode();
  console.log("=== Network Status ===");
  console.log("");
  console.log(`Mode: ${mode}`);

  if (mode === "tailscale") {
    const hasTailscale = safeSyncOutput(["which", "tailscale"]).ok;
    if (hasTailscale) {
      console.log("Tailscale CLI: available");
      const tsHost = hostnameTailscale();
      if (tsHost) {
        console.log(`Tailscale hostname: ${tsHost}`);
      } else {
        console.log("Tailscale hostname: (not connected or unavailable)");
      }
    } else {
      console.log("Tailscale CLI: not installed");
    }

    const configHost = hostnameFromConfig();
    if (configHost) {
      console.log(`Config hostname: ${configHost}`);
    }
  }

  const effectiveHost = networkHostname();
  console.log("");
  console.log(`Effective hostname: ${effectiveHost}`);
  console.log(`Example URL: ${getUrl(7679)}`);
  console.log("");
  console.log("For multi-machine status, use: ludics cluster status");
}

export async function runNetwork(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (sub === "status" || sub === "") {
    networkStatus();
  } else {
    throw new Error(`unknown network command: ${sub} (use: status)`);
  }
}
