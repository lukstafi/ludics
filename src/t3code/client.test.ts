import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { T3CodeClient } from "./client.ts";
import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./types.ts";
import { canBindSocket } from "../test-utils.ts";

setDefaultTimeout(15_000);

type RequestEnvelope = {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
};

const servers: Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function startServer(handler: {
  onOpen?: (ws: ServerWebSocket<undefined>) => void;
  onMessage: (ws: ServerWebSocket<undefined>, request: RequestEnvelope) => void;
}) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        handler.onOpen?.(ws);
      },
      message(ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        handler.onMessage(ws, JSON.parse(text) as RequestEnvelope);
      },
    },
  });
  servers.push(server);
  return server;
}

describe.if(canBindSocket)("T3CodeClient", () => {
  test("requests orchestration snapshots", async () => {
    let seenTag = "";
    const server = startServer({
      onMessage(ws, request) {
        seenTag = request.body._tag;
        ws.send(JSON.stringify({
          id: request.id,
          result: {
            snapshotSequence: 1,
            projects: [],
            threads: [],
            updatedAt: "2026-03-07T00:00:00Z",
          },
        }));
      },
    });

    const client = new T3CodeClient({
      url: `ws://127.0.0.1:${server.port}`,
      requestTimeoutMs: 5_000,
    });

    const snapshot = await client.getSnapshot();
    client.close();

    expect(seenTag).toBe(ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshot.snapshotSequence).toBe(1);
  });

  test("subscribes to orchestration domain push events", async () => {
    const server = startServer({
      onOpen(ws) {
        ws.send(JSON.stringify({
          type: "push",
          channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
          data: {
            type: "thread.message-sent",
            payload: { threadId: "thread-1" },
          },
        }));
      },
      onMessage(ws, request) {
        ws.send(JSON.stringify({ id: request.id, result: undefined }));
      },
    });

    const client = new T3CodeClient({
      url: `ws://127.0.0.1:${server.port}`,
      requestTimeoutMs: 5_000,
    });

    const seen: string[] = [];
    client.onDomainEvent((event) => {
      seen.push(event.type);
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.close();

    expect(seen).toEqual(["thread.message-sent"]);
  });

  test("reconnects after the socket closes", async () => {
    let connectionCount = 0;
    const server = startServer({
      onOpen() {
        connectionCount += 1;
      },
      onMessage(ws, request) {
        ws.send(JSON.stringify({ id: request.id, result: undefined }));
        ws.close();
      },
    });

    const client = new T3CodeClient({
      url: `ws://127.0.0.1:${server.port}`,
      requestTimeoutMs: 5_000,
      reconnectDelaysMs: [100, 100],
    });

    await client.dispatchCommand({
      type: "thread.delete",
      commandId: "cmd-1",
      threadId: "thread-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.getSnapshot().catch(() => undefined);
    client.close();

    expect(connectionCount).toBeGreaterThanOrEqual(2);
  });
});
