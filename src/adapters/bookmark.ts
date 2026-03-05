// Shared bookmark tracker for claude-ai and chatgpt-com adapters
//
// These two adapters are ~95% identical: track browser-based conversations
// via a bookmarks file (URL + label) and per-conversation metadata files.
// This module provides the shared logic, parameterized by BookmarkConfig.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { readStateFile, writeStateFile, isoTimestamp, latestMtime } from "./base.ts";
import { MarkdownBuilder } from "./markdown.ts";
import type { AdapterContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookmarkConfig {
  adapterName: string; // "claude-ai" | "chatgpt-com"
  urlPattern: RegExp; // e.g. /claude\.ai\/chat\/([a-zA-Z0-9-]+)/
  defaultLabel: string;
  defaultModel: string;
}

interface BookmarkEntry {
  url: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bookmarksFilePath(config: BookmarkConfig, ctx: AdapterContext): string {
  return join(ctx.harnessDir, `${config.adapterName}.urls`);
}

function stateDir(config: BookmarkConfig, ctx: AdapterContext): string {
  return join(ctx.harnessDir, config.adapterName);
}

function metadataFilePath(config: BookmarkConfig, ctx: AdapterContext, convId: string): string {
  return join(stateDir(config, ctx), `${convId}.meta`);
}

function parseBookmarks(path: string): BookmarkEntry[] {
  if (!existsSync(path)) return [];
  const entries: BookmarkEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match) {
      entries.push({ url: match[1]!, label: match[2]! });
    } else if (line.trim()) {
      entries.push({ url: line.trim(), label: "" });
    }
  }
  return entries;
}

function extractConvId(config: BookmarkConfig, url: string): string | null {
  const m = url.match(config.urlPattern);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Adapter interface functions
// ---------------------------------------------------------------------------

/** Read state for a bookmark-based adapter. Returns Markdown or null. */
export function bookmarkReadState(config: BookmarkConfig, ctx: AdapterContext): string | null {
  const bmPath = bookmarksFilePath(config, ctx);
  const entries = parseBookmarks(bmPath);
  if (entries.length === 0) return null;

  const md = new MarkdownBuilder();
  md.keyValue("Mode", config.adapterName);

  md.section("Conversations");
  for (const entry of entries) {
    if (entry.label) {
      md.bullet(`[${entry.label}](${entry.url})`);
    } else {
      md.bullet(entry.url);
    }

    const convId = extractConvId(config, entry.url);
    if (convId) {
      const metaPath = metadataFilePath(config, ctx, convId);
      const meta = readStateFile(metaPath);
      if (meta.size > 0) {
        const model = meta.get("model");
        const task = meta.get("task");
        const updated = meta.get("updated");
        if (model) md.detail(`Model: ${model}`);
        if (task) md.detail(`Task: ${task}`);
        if (updated) md.detail(`Updated: ${updated}`);
      }
    }
  }

  // Stats
  const sd = stateDir(config, ctx);
  if (existsSync(sd)) {
    const metaCount = readdirSync(sd).filter((f) => f.endsWith(".meta")).length;
    if (metaCount > 0) {
      md.section("Stats");
      md.bullet(`Tracked conversations: ${metaCount}`);
    }
  }

  return md.toString();
}

/** Start tracking a bookmark-based conversation. */
export function bookmarkStart(config: BookmarkConfig, ctx: AdapterContext): string {
  const bmPath = bookmarksFilePath(config, ctx);
  const sd = stateDir(config, ctx);
  mkdirSync(dirname(bmPath), { recursive: true });
  mkdirSync(sd, { recursive: true });

  // ctx.session carries the URL, ctx.process carries the label
  const url = ctx.session;
  const label = ctx.process || config.defaultLabel;
  const taskId = ctx.taskId;

  if (!url) {
    return `${config.adapterName} start: provide a conversation URL to track`;
  }

  // Append to bookmarks file
  const entry = label ? `${url} ${label}` : url;
  const existing = existsSync(bmPath) ? readFileSync(bmPath, "utf-8") : "";
  writeFileSync(bmPath, existing + entry + "\n");

  // Create metadata if we can extract a conversation ID
  const convId = extractConvId(config, url);
  if (convId) {
    const metaPath = metadataFilePath(config, ctx, convId);
    const now = isoTimestamp();
    const meta = new Map<string, string>();
    meta.set("conversation_id", convId);
    meta.set("url", url);
    meta.set("label", label);
    meta.set("started", now);
    meta.set("updated", now);
    meta.set("model", config.defaultModel);
    if (taskId) meta.set("task", taskId);
    writeStateFile(metaPath, meta);
  }

  return `Added ${config.adapterName} conversation: ${label}\nOpen in browser: ${url}`;
}

/** Return last activity timestamp for a bookmark-based adapter. */
export function bookmarkLastActivity(config: BookmarkConfig, ctx: AdapterContext): string | null {
  const bmPath = bookmarksFilePath(config, ctx);
  const entries = parseBookmarks(bmPath);
  // Check metadata file mtimes for tracked conversations
  const paths: string[] = [];
  for (const entry of entries) {
    const convId = extractConvId(config, entry.url);
    if (convId) paths.push(metadataFilePath(config, ctx, convId));
  }
  if (paths.length === 0) paths.push(bmPath);
  return latestMtime(paths);
}

/** Stop tracking a bookmark-based conversation. */
export function bookmarkStop(config: BookmarkConfig, ctx: AdapterContext): string {
  const bmPath = bookmarksFilePath(config, ctx);
  const identifier = ctx.session;

  if (!identifier) {
    return `${config.adapterName} stop: no conversation identifier provided`;
  }
  if (!existsSync(bmPath)) {
    return `${config.adapterName} stop: no bookmarks file found`;
  }

  const content = readFileSync(bmPath, "utf-8");
  const kept: string[] = [];
  let removed = false;

  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) {
      kept.push(line);
      continue;
    }
    if (line.includes(identifier)) {
      removed = true;
      // Remove metadata too
      const convId = extractConvId(config, line);
      if (convId) {
        const metaPath = metadataFilePath(config, ctx, convId);
        if (existsSync(metaPath)) {
          unlinkSync(metaPath);
        }
      }
    } else {
      kept.push(line);
    }
  }

  // Atomic write
  const tmp = bmPath + ".tmp";
  writeFileSync(tmp, kept.join("\n"));
  renameSync(tmp, bmPath);

  if (removed) {
    return `${config.adapterName} conversation removed from tracking.`;
  }
  return `${config.adapterName} stop: conversation not found matching '${identifier}'`;
}
