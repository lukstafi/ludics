// Adapter dispatch — direct TypeScript dispatch (replaces bash bridge)

import type { AdapterContext, Adapter } from "./types.ts";

export type { AdapterContext } from "./types.ts";

import * as agentClaude from "./agent-claude.ts";
import * as agentCodex from "./agent-codex.ts";
import * as agentDuo from "./agent-duo.ts";
import * as agentPairCodex from "./agent-pair-codex.ts";
import * as agentPairClaude from "./agent-pair-claude.ts";
import * as claudeAi from "./claude-ai.ts";
import * as chatgptCom from "./chatgpt-com.ts";
import * as manual from "./manual.ts";

const adapters: Record<string, Adapter> = {
  "agent-claude": agentClaude,
  "agent-codex": agentCodex,
  "agent-duo": agentDuo,
  "agent-pair-codex": agentPairCodex,
  "agent-pair-claude": agentPairClaude,
  "claude-ai": claudeAi,
  "chatgpt-com": chatgptCom,
  "manual": manual,
};

function getAdapter(mode: string): Adapter {
  const adapter = adapters[mode];
  if (!adapter) throw new Error(`adapter not found: ${mode}`);
  return adapter;
}

export async function runAdapterAction(action: string, ctx: AdapterContext): Promise<string> {
  const adapter = getAdapter(ctx.mode);
  switch (action) {
    case "start":
      return await adapter.start(ctx);
    case "stop":
      return await adapter.stop(ctx);
    case "read_state":
      return (await adapter.readState(ctx)) ?? "";
    default:
      throw new Error(`unknown adapter action: ${action}`);
  }
}

export async function readAdapterState(ctx: AdapterContext): Promise<string | null> {
  const adapter = adapters[ctx.mode];
  if (!adapter) return null;
  return await adapter.readState(ctx);
}

export async function readAdapterLastActivity(ctx: AdapterContext): Promise<string | null> {
  const adapter = adapters[ctx.mode];
  if (!adapter) return null;
  return await adapter.lastActivity(ctx);
}
