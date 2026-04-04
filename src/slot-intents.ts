// Slot intent files — controller writes one-shot commands consumed by worker keepalive

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { harnessDir } from "./config.ts";

export interface SlotIntent {
  action: "start" | "stop" | "resume";
  epoch: number;
  machine: string;
  preserveState?: boolean;
}

const INTENT_TTL_SECONDS = 600; // 10 minutes

function intentsDir(): string {
  return join(harnessDir(), "federation", "slot-intents");
}

function intentFilePath(slotNum: number): string {
  return join(intentsDir(), `slot-${slotNum}.json`);
}

export function writeSlotIntent(slotNum: number, intent: SlotIntent): void {
  const dir = intentsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(intentFilePath(slotNum), JSON.stringify(intent, null, 2) + "\n");
}

export function readSlotIntent(slotNum: number): SlotIntent | null {
  const file = intentFilePath(slotNum);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SlotIntent;
  } catch {
    return null;
  }
}

export function intentIsFresh(intent: SlotIntent): boolean {
  const now = Math.floor(Date.now() / 1000);
  return (now - intent.epoch) < INTENT_TTL_SECONDS;
}

export function clearSlotIntent(slotNum: number): void {
  const file = intentFilePath(slotNum);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}
