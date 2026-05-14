// Claude.ai bookmark tracker — delegates to shared bookmark module

import { bookmarkReadState, bookmarkStop, bookmarkLastActivity, type BookmarkConfig } from "./bookmark.ts";
import type { AdapterContext, Adapter } from "./types.ts";

const config: BookmarkConfig = {
  adapterName: "claude-ai",
  urlPattern: /claude\.ai\/chat\/([a-zA-Z0-9-]+)/,
  defaultLabel: "Claude.ai conversation",
  defaultModel: "claude-sonnet",
};

export const readState = (ctx: AdapterContext) => bookmarkReadState(config, ctx);
// `start` is intentionally unimplemented: claude-ai stays registered so legacy
// bookmark slots still read state, but launching a session is not supported.
export const start = (_ctx: AdapterContext): string => {
  throw new Error(`${config.adapterName}: NOT IMPLEMENTED YET`);
};
export const stop = (ctx: AdapterContext) => bookmarkStop(config, ctx);
export const lastActivity = (ctx: AdapterContext) => bookmarkLastActivity(config, ctx);

export default { readState, start, stop, lastActivity } satisfies Adapter;
