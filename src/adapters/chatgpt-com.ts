// ChatGPT bookmark tracker — delegates to shared bookmark module

import { bookmarkReadState, bookmarkStop, bookmarkLastActivity, type BookmarkConfig } from "./bookmark.ts";
import type { AdapterContext, Adapter } from "./types.ts";

const config: BookmarkConfig = {
  adapterName: "chatgpt-com",
  urlPattern: /chat\.openai\.com\/c\/([a-zA-Z0-9-]+)/,
  defaultLabel: "ChatGPT conversation",
  defaultModel: "gpt-4",
};

export const readState = (ctx: AdapterContext) => bookmarkReadState(config, ctx);
// `start` is intentionally unimplemented: chatgpt-com stays registered so
// legacy bookmark slots still read state, but launching a session is not
// supported.
export const start = (_ctx: AdapterContext): string => {
  throw new Error(`${config.adapterName}: NOT IMPLEMENTED YET`);
};
export const stop = (ctx: AdapterContext) => bookmarkStop(config, ctx);
export const lastActivity = (ctx: AdapterContext) => bookmarkLastActivity(config, ctx);

export default { readState, start, stop, lastActivity } satisfies Adapter;
