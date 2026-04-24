// Slot data types

/** Canonical slot-liveness enum.
 *  - `"alive"`:       orchestrator running normally (set from runtime PID checks; rarely persisted).
 *  - `"interrupted"`: orchestration setup failed, or runtime exited abnormally — needs `slot N resume`.
 *  - `"escalated"`:   agent wrote `escalate` to its status file (task-4cd94043); user-resumed via `slot N resume`.
 *  - `null`:          no explicit liveness marker (default, empty, or just-resumed slot). */
export type SlotLiveness = "alive" | "interrupted" | "escalated" | null;

/** Narrow an untrusted string (legacy markdown migration, HTTP body, etc.)
 *  to a valid {@link SlotLiveness}. Unknown or empty values collapse to `null`
 *  — the safest default, since `null` means "no explicit marker" and callers
 *  that need a stronger signal will re-derive it from runtime state. */
export function parseSlotLiveness(raw: unknown): SlotLiveness {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (s === "alive" || s === "interrupted" || s === "escalated") return s;
  return null;
}

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
  liveness: SlotLiveness;
  terminals: string;
  runtime: string;
  git: string;
}
