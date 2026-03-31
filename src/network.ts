// Network configuration — hostname detection and URL helpers

import { loadConfigSync, harnessDir } from "./config.ts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

export function networkMode(): string {
  // Check federation.transport (new config), then legacy network.mode
  try {
    const configPath = join(harnessDir(), "config.yaml");
    if (existsSync(configPath)) {
      const raw = YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const transport = (raw.federation as Record<string, unknown> | undefined)?.transport as string | undefined;
      if (transport && transport !== "local") return transport;
    }
  } catch { /* fall through */ }
  const config = loadConfigSync();
  return config.network?.mode ?? "localhost";
}

function hostnameFromConfig(): string {
  const config = loadConfigSync();
  return (config.network as Record<string, unknown> | undefined)?.hostname as string ?? "";
}

export function hostnameTailscale(): string | null {
  // Check if tailscale is available first
  const which = Bun.spawnSync(["which", "tailscale"], { stdout: "pipe", stderr: "pipe" });
  if (which.exitCode !== 0) return null;

  try {
    const result = Bun.spawnSync(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return null;

    const data = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
    const self = data.Self as Record<string, unknown> | undefined;
    if (!self) return null;

    const dnsName = self.DNSName as string | undefined;
    if (dnsName) return dnsName.replace(/\.$/, "");

    const hostName = self.HostName as string | undefined;
    if (hostName) return hostName;
  } catch {
    // parse failure or command not found
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

    console.error("ludics: tailscale mode enabled but cannot determine hostname");
    return "localhost";
  }

  return "localhost";
}

export function getUrl(port: number | string, protocol: string = "http"): string {
  return `${protocol}://${networkHostname()}:${port}`;
}

interface NodeConfig {
  name: string;
  tailscale_hostname?: string;
}

export function networkNodes(): NodeConfig[] {
  const config = loadConfigSync();
  const nodes = config.network?.nodes as NodeConfig[] | undefined;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => n && n.name);
}

export function networkNodeHostname(nodeName: string): string {
  const nodes = networkNodes();
  const node = nodes.find((n) => n.name === nodeName);
  return node?.tailscale_hostname ?? "";
}

export function networkCurrentNode(): string | null {
  const tsHost = hostnameTailscale();
  if (!tsHost) return null;

  const nodes = networkNodes();
  const normalizedCurrent = tsHost.replace(/\.$/, "");

  for (const node of nodes) {
    const normalizedNode = (node.tailscale_hostname ?? "").replace(/\.$/, "");
    if (normalizedNode === normalizedCurrent) return node.name;
  }

  return null;
}

export function networkStatus(): void {
  const mode = networkMode();
  console.log("=== Network Status ===");
  console.log("");
  console.log(`Mode: ${mode}`);

  if (mode === "tailscale") {
    const hasTailscale = Bun.spawnSync(["which", "tailscale"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
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

  const nodes = networkNodes();
  console.log("");
  console.log("Configured nodes (by seniority):");
  if (nodes.length === 0) {
    console.log("  (no nodes configured)");
  } else {
    for (let i = 0; i < nodes.length; i++) {
      console.log(`  ${i + 1}. ${nodes[i]!.name} -> ${nodes[i]!.tailscale_hostname ?? "(not set)"}`);
    }
  }

  const currentNode = networkCurrentNode();
  if (currentNode) {
    const rank = nodes.findIndex((n) => n.name === currentNode) + 1;
    console.log("");
    console.log(`This machine: ${currentNode} (seniority: ${rank})`);
  }
}

export async function runNetwork(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (sub === "status" || sub === "") {
    networkStatus();
  } else {
    throw new Error(`unknown network command: ${sub} (use: status)`);
  }
}
