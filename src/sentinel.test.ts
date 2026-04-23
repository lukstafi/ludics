import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  sentinelFresh,
  readSentinelEpoch,
  touchSentinel,
  clearSentinel,
  sentinelExists,
} from "./sentinel.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ludics-sentinel-"));
}

describe("sentinel", () => {
  test("sentinelFresh: true when mtime is within window", () => {
    const dir = tmp();
    const file = join(dir, "x.epoch");
    writeFileSync(file, "0");
    const now = new Date();
    expect(sentinelFresh(file, now, 3600)).toBe(true);
  });

  test("sentinelFresh: false when mtime is past window", () => {
    const dir = tmp();
    const file = join(dir, "x.epoch");
    writeFileSync(file, "0");
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(file, old, old);
    expect(sentinelFresh(file, new Date(), 3600)).toBe(false);
  });

  test("sentinelFresh: false when file is missing", () => {
    const dir = tmp();
    expect(sentinelFresh(join(dir, "missing.epoch"), new Date(), 3600)).toBe(false);
  });

  test("readSentinelEpoch: returns stored integer", () => {
    const dir = tmp();
    const file = join(dir, "x.epoch");
    writeFileSync(file, "1700000000\n");
    expect(readSentinelEpoch(file)).toBe(1700000000);
  });

  test("readSentinelEpoch: returns null for missing file", () => {
    expect(readSentinelEpoch(join(tmp(), "missing.epoch"))).toBeNull();
  });

  test("readSentinelEpoch: returns null for non-positive epoch (conservative policy)", () => {
    const dir = tmp();
    const zero = join(dir, "zero.epoch");
    writeFileSync(zero, "0");
    expect(readSentinelEpoch(zero)).toBeNull();
    const negative = join(dir, "neg.epoch");
    writeFileSync(negative, "-1");
    expect(readSentinelEpoch(negative)).toBeNull();
    const garbage = join(dir, "garbage.epoch");
    writeFileSync(garbage, "not-a-number");
    expect(readSentinelEpoch(garbage)).toBeNull();
  });

  test("touchSentinel: creates parent dir and writes epoch", () => {
    const dir = tmp();
    const file = join(dir, "nested", "deep", "x.epoch");
    const when = new Date(1700000000 * 1000);
    touchSentinel(file, when);
    expect(existsSync(file)).toBe(true);
    expect(readSentinelEpoch(file)).toBe(1700000000);
  });

  test("touchSentinel: defaults `now` to current time when omitted", () => {
    const dir = tmp();
    const file = join(dir, "x.epoch");
    const before = Math.floor(Date.now() / 1000);
    touchSentinel(file);
    const epoch = readSentinelEpoch(file);
    expect(epoch).not.toBeNull();
    expect(epoch!).toBeGreaterThanOrEqual(before);
  });

  test("clearSentinel: removes existing file", () => {
    const dir = tmp();
    const file = join(dir, "x.epoch");
    touchSentinel(file, new Date());
    expect(existsSync(file)).toBe(true);
    clearSentinel(file);
    expect(existsSync(file)).toBe(false);
  });

  test("clearSentinel: swallows errors when file is absent", () => {
    const dir = tmp();
    expect(() => clearSentinel(join(dir, "never-existed.epoch"))).not.toThrow();
  });

  test("sentinelExists: boolean presence check (no freshness)", () => {
    const dir = tmp();
    const file = join(dir, "settled");
    expect(sentinelExists(file)).toBe(false);
    writeFileSync(file, "");
    expect(sentinelExists(file)).toBe(true);
  });

  test("round-trip: touch → readSentinelEpoch yields the written epoch (stable under serialize/deserialize)", () => {
    const dir = tmp();
    const file = join(dir, "round-trip.epoch");
    const when = new Date(1_700_000_042 * 1000);
    touchSentinel(file, when);
    expect(readSentinelEpoch(file)).toBe(1_700_000_042);
    expect(sentinelFresh(file, when, 10)).toBe(true);
  });
});
