// Network tests — verify hostname fallback chain and networkStatus output

import { describe, it, expect, spyOn } from "bun:test";
import * as network from "./network.ts";
import * as config from "./config.ts";

describe("networkHostname", () => {
  it("returns localhost when mode is localhost", () => {
    const spy = spyOn(config, "loadConfigSync").mockReturnValue({} as any);
    try {
      expect(network.networkHostname()).toBe("localhost");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not use hostnameFromConfig in the fallback chain", () => {
    // After removing hostnameFromConfig, the fallback chain in tailscale mode is:
    // tailscale CLI → cluster machine host → localhost
    // Verify no config.network.hostname lookup exists
    const src = require("fs").readFileSync(require.resolve("./network.ts"), "utf8");
    expect(src).not.toContain("hostnameFromConfig");
    expect(src).not.toContain("config.network");
  });

  it("uses tailscale hostname when available", () => {
    const configSpy = spyOn(config, "loadConfigSync").mockReturnValue({ cluster: { transport: "tailscale" } } as any);
    const tsSpy = spyOn(network, "hostnameTailscale").mockReturnValue("myhost.tailnet.ts.net");
    try {
      expect(network.networkHostname()).toBe("myhost.tailnet.ts.net");
    } finally {
      configSpy.mockRestore();
      tsSpy.mockRestore();
    }
  });
});

describe("networkStatus", () => {
  it("does not print a Config hostname line", () => {
    const configSpy = spyOn(config, "loadConfigSync").mockReturnValue({ cluster: { transport: "tailscale" } } as any);
    const tsSpy = spyOn(network, "hostnameTailscale").mockReturnValue("host.ts.net");
    const findSpy = spyOn(network, "findTailscaleCli").mockReturnValue("/usr/bin/tailscale");
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      network.networkStatus();
      const configLine = lines.find((l) => l.includes("Config hostname"));
      expect(configLine).toBeUndefined();
    } finally {
      configSpy.mockRestore();
      tsSpy.mockRestore();
      findSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
