import { describe, expect, test } from "bun:test";
import { ttydPort } from "./transport-tmux.ts";

describe("ttydPort fixed-port mapping", () => {
  test("slot 1 coder → 7681", () => {
    expect(ttydPort(1, "coder")).toBe(7681);
  });

  test("slot 1 reviewer → 7682", () => {
    expect(ttydPort(1, "reviewer")).toBe(7682);
  });

  test("slot 2 coder → 7683", () => {
    expect(ttydPort(2, "coder")).toBe(7683);
  });

  test("slot 2 reviewer → 7684", () => {
    expect(ttydPort(2, "reviewer")).toBe(7684);
  });

  test("slot 3 coder → 7685", () => {
    expect(ttydPort(3, "coder")).toBe(7685);
  });

  test("slot 6 coder → 7691", () => {
    expect(ttydPort(6, "coder")).toBe(7691);
  });

  test("slot 6 reviewer → 7692", () => {
    expect(ttydPort(6, "reviewer")).toBe(7692);
  });

  test("all 12 ports are unique", () => {
    const ports = new Set<number>();
    for (let slot = 1; slot <= 6; slot++) {
      for (const role of ["coder", "reviewer"] as const) {
        ports.add(ttydPort(slot, role));
      }
    }
    expect(ports.size).toBe(12);
  });

  test("no port conflicts with reserved port 7680", () => {
    for (let slot = 1; slot <= 6; slot++) {
      for (const role of ["coder", "reviewer"] as const) {
        expect(ttydPort(slot, role)).not.toBe(7680);
      }
    }
  });

  test("all ports are in range 7681-7692", () => {
    for (let slot = 1; slot <= 6; slot++) {
      for (const role of ["coder", "reviewer"] as const) {
        const port = ttydPort(slot, role);
        expect(port).toBeGreaterThanOrEqual(7681);
        expect(port).toBeLessThanOrEqual(7692);
      }
    }
  });
});

describe("TmuxTransport class", () => {
  test("TmuxTransport is importable and constructable", async () => {
    const { TmuxTransport } = await import("./transport-tmux.ts");
    const transport = new TmuxTransport();
    expect(transport).toBeDefined();
    expect(typeof transport.sendTurn).toBe("function");
    expect(typeof transport.refreshAgentTransportState).toBe("function");
    expect(typeof transport.interruptAgent).toBe("function");
    // No subscribeEvents — pure polling
    const asTransport = transport as import("./transport.ts").OrchestrationTransport;
    expect(asTransport.subscribeEvents).toBeUndefined();
  });
});
