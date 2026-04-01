// Adapter type definitions

export interface AdapterContext {
  slot: number;
  mode: string;
  session: string;
  path: string;
  taskId: string;
  adapterArgs: string;
  started?: string;
  process: string;
  machine?: string;
  harnessDir: string;
  stateRepoDir: string;
}

/** Allow adapter methods to return sync or async results. */
export type MaybePromise<T> = T | Promise<T>;

export interface Adapter {
  readState(ctx: AdapterContext): MaybePromise<string | null>;
  start(ctx: AdapterContext): MaybePromise<string>;
  stop(ctx: AdapterContext): MaybePromise<string>;
  /** Return ISO timestamp of last real work activity, or null if unknown. */
  lastActivity(ctx: AdapterContext): MaybePromise<string | null>;
}

export interface AgentStatus {
  status: string; // working|paused|done|error|interrupted
  epoch: number;
  message: string;
}
