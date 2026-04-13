// Adapter dispatch — direct TypeScript dispatch (replaces bash bridge)

import type { AdapterContext, Adapter } from "./types.ts";

export type { AdapterContext } from "./types.ts";

import * as agentClaude from "./agent-claude.ts";
import * as agentCodex from "./agent-codex.ts";
import * as claudeAi from "./claude-ai.ts";
import * as chatgptCom from "./chatgpt-com.ts";
import * as manual from "./manual.ts";
import * as t3code from "./t3code.ts";
import * as tmuxAdapter from "./tmux-adapter.ts";

const adapters: Record<string, Adapter> = {
  "agent-claude": agentClaude,
  "agent-codex": agentCodex,
  "claude-ai": claudeAi,
  "chatgpt-com": chatgptCom,
  "manual": manual,
  "t3code": t3code,
  "tmux": tmuxAdapter,
};

export const ADAPTER_NAMES = Object.keys(adapters);

function getAdapter(mode: string): Adapter {
  const adapter = adapters[mode];
  if (!adapter) throw new Error(`adapter not found: ${mode}`);
  return adapter;
}

export async function runAdapterAction(
  action: string, ctx: AdapterContext,
  options?: { preserveState?: boolean },
): Promise<string> {
  const adapter = getAdapter(ctx.mode);
  switch (action) {
    case "start":
      return await adapter.start(ctx);
    case "stop":
      return await adapter.stop(ctx, options);
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
