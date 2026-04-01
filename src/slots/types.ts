// Slot block types

export interface SlotBlock {
  slot: number;
  process: string;
  task: string;
  mode: string;
  session: string;
  path: string;
  started: string;
  adapterArgs: string;
  terminals: string;
  machine: string;
  runtime: string;
  git: string;
  raw: string; // full Markdown block
}
