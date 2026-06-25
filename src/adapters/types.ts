// Adapter type definitions

export interface AdapterContext {
  slot: number;
  mode: string;
  session: string;
  path: string;
  taskId: string | undefined;
  adapterArgs: string;
  started?: string;
  process: string;
  machine?: string;
  harnessDir: string;
  stateRepoDir: string;
  startTtyd?: boolean;
  /** Controller-supplied task-content freshness fingerprint (gh-ludics-609 (b)/AC2):
   *  the `taskFileIntroCommit` of the controller's authoritative harness checkout,
   *  threaded from the start intent via the worker's per-slot fingerprint override.
   *  When set, the adapter setup refuses on a local task file whose intro-commit
   *  differs (present-but-stale). Unset on controller-local / standalone runs, where
   *  the local harness is authoritative and only existence is checked (AC1). */
  expectedTaskIntroCommit?: string;
}

/** Allow adapter methods to return sync or async results. */
export type MaybePromise<T> = T | Promise<T>;

export interface Adapter {
  readState(ctx: AdapterContext): MaybePromise<string | null>;
  start(ctx: AdapterContext): MaybePromise<string>;
  stop(ctx: AdapterContext, options?: { preserveState?: boolean }): MaybePromise<string>;
  /** Return ISO timestamp of last real work activity, or null if unknown. */
  lastActivity(ctx: AdapterContext): MaybePromise<string | null>;
}

export interface AgentStatus {
  status: string; // working|paused|done|error|interrupted
  epoch: number;
  message: string;
}
