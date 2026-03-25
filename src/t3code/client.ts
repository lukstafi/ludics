import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type T3Command,
  type T3CommandResult,
  type T3DomainEvent,
  type T3Snapshot,
  type T3ThreadMessage,
  type T3WsPush,
  type T3WsResponse,
} from "./types.ts";

export { threadModel, projectModel } from "./types.ts";

type PushListener = (data: unknown) => void;

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface T3CodeClientOptions {
  url: string;
  token?: string;
  requestTimeoutMs?: number;
  reconnectDelaysMs?: number[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000];

export class T3CodeClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly requestTimeoutMs: number;
  private readonly reconnectDelaysMs: number[];
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<PushListener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  constructor(options: T3CodeClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("t3code client is closed");
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    const url = this.websocketUrl();
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        reject(new Error(message));
      };

      ws.addEventListener("open", () => {
        settled = true;
        this.ws = ws;
        this.connectPromise = null;
        this.reconnectAttempt = 0;
        resolve();
      });

      ws.addEventListener("message", (event) => {
        void this.handleMessage(event.data);
      });

      ws.addEventListener("close", () => {
        const wasActive = this.ws === ws;
        if (wasActive) this.ws = null;
        if (!settled) {
          fail(`unable to connect to t3code at ${url}`);
          return;
        }
        this.rejectPending(new Error("t3code connection closed"));
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        if (!settled) fail(`unable to connect to t3code at ${url}`);
      });
    });

    return this.connectPromise;
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error("t3code client closed"));
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
  }

  subscribe(channel: string, listener: PushListener): () => void {
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listeners.delete(channel);
    };
  }

  onDomainEvent(listener: (event: T3DomainEvent) => void): () => void {
    return this.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (data) => {
      if (!isRecord(data) || typeof data.type !== "string") return;
      listener({
        type: data.type,
        payload: isRecord(data.payload) ? data.payload : undefined,
        sequence: typeof data.sequence === "number" ? data.sequence : undefined,
        eventId: typeof data.eventId === "string" ? data.eventId : undefined,
      });
    });
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("t3code connection is not open");
    }

    const id = String(this.nextId++);
    const body = params ? { ...params, _tag: method } : { _tag: method };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`t3code request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      ws.send(JSON.stringify({ id, body }));
    });
  }

  async getSnapshot(): Promise<T3Snapshot> {
    return await this.request<T3Snapshot>(ORCHESTRATION_WS_METHODS.getSnapshot);
  }

  async dispatchCommand(command: T3Command): Promise<T3CommandResult | undefined> {
    return await this.request<T3CommandResult | undefined>(
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      { command },
    );
  }

  /**
   * Get thread messages by extracting them from the snapshot.
   * The server no longer has a separate getThreadMessages RPC;
   * messages are embedded in the snapshot's thread objects.
   */
  async getThreadMessages(threadId: string, limit?: number): Promise<T3ThreadMessage[]> {
    const snapshot = await this.getSnapshot();
    const thread = snapshot.threads.find((t) => t.id === threadId);
    if (!thread) return [];
    const messages = thread.messages ?? [];
    if (limit !== undefined && limit > 0) {
      return messages.slice(-limit);
    }
    return messages;
  }

  private websocketUrl(): string {
    if (!this.token) return this.url;
    const url = new URL(this.url);
    url.searchParams.set("token", this.token);
    return url.toString();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelaysMs[
      Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
    ] ?? this.reconnectDelaysMs[this.reconnectDelaysMs.length - 1]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const text = await rawToText(raw);
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (isPush(parsed)) {
      const listeners = this.listeners.get(parsed.channel);
      if (!listeners) return;
      for (const listener of listeners) {
        try {
          listener(parsed.data);
        } catch {
          // ignore listener failures
        }
      }
      return;
    }

    if (!isResponse(parsed)) return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(parsed.id);

    if (parsed.error?.message) {
      pending.reject(new Error(parsed.error.message));
      return;
    }

    pending.resolve(parsed.result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPush(value: unknown): value is T3WsPush {
  return isRecord(value)
    && value.type === "push"
    && typeof value.channel === "string";
}

function isResponse(value: unknown): value is T3WsResponse {
  return isRecord(value)
    && typeof value.id === "string";
}

async function rawToText(raw: unknown): Promise<string> {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  if (typeof Blob !== "undefined" && raw instanceof Blob) return await raw.text();
  return "";
}
