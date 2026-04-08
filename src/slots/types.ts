// Slot data types

export interface SlotData {
  slot: number;
  process: string;
  task: string | null;
  mode: string | null;
  session: string | null;
  path: string | null;
  started: string | null;
  adapterArgs: string | null;
  machine: string | null;
  sessionStarted: string | null;
  liveness: string | null;
  terminals: string;
  runtime: string;
  git: string;
}
