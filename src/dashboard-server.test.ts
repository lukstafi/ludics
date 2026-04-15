import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { startDashboardServer } from "./dashboard-server.ts";

describe("startDashboardServer", () => {
  let serveSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    serveSpy?.mockRestore();
  });

  test("binds to 127.0.0.1 explicitly", () => {
    serveSpy = spyOn(Bun, "serve").mockReturnValue({
      port: 12345,
      stop: () => {},
    } as any);

    startDashboardServer(0, "/tmp/nonexistent-dashboard", 999);

    expect(serveSpy).toHaveBeenCalledTimes(1);
    const opts = serveSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.hostname).toBe("127.0.0.1");
  });
});
