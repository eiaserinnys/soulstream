import { describe, expect, it } from "vitest";

import { comparePositionKeys, generateKeyBetween } from "./fractional-position";

function expectBetween(key: string, lower: string | null, upper: string | null) {
  if (lower !== null) expect(key > lower).toBe(true);
  if (upper !== null) expect(key < upper).toBe(true);
}

describe("generateKeyBetween", () => {
  it("orders keys by the fractional alphabet instead of the runtime locale", () => {
    const first = generateKeyBetween(null, null);
    const after = generateKeyBetween(first, null);

    expect(comparePositionKeys(first, after)).toBeLessThan(0);
    expect([after, first].sort(comparePositionKeys)).toEqual([first, after]);
    expect([first, after]).toEqual(["V", "k"]);
  });

  it("generates a deterministic first key for an empty list", () => {
    expect(generateKeyBetween(null, null)).toBe("V");
  });

  it("generates keys before and after existing bounds", () => {
    const first = generateKeyBetween(null, null);
    const before = generateKeyBetween(null, first);
    const after = generateKeyBetween(first, null);

    expectBetween(before, null, first);
    expectBetween(after, first, null);
  });

  it("generates a key between adjacent top-level digits without integer fallback", () => {
    const key = generateKeyBetween("A", "B");

    expect(key).toBe("AV");
    expectBetween(key, "A", "B");
  });

  it("generates a key when the lower bound is a prefix of the upper bound", () => {
    const key = generateKeyBetween("A", "AV");

    expectBetween(key, "A", "AV");
  });

  it("supports repeated insertion before the current first key", () => {
    const keys = [generateKeyBetween(null, null)];
    for (let count = 0; count < 20; count += 1) {
      keys.unshift(generateKeyBetween(null, keys[0]));
    }

    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("supports repeated insertion after the current last key", () => {
    const keys = [generateKeyBetween(null, null)];
    for (let count = 0; count < 20; count += 1) {
      keys.push(generateKeyBetween(keys[keys.length - 1], null));
    }

    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects unordered and invalid bounds", () => {
    expect(() => generateKeyBetween("B", "A")).toThrow(/sort before/);
    expect(() => generateKeyBetween("A-", "B")).toThrow(/invalid/);
    expect(() => generateKeyBetween("", "B")).toThrow(/non-empty/);
  });

  it("reports exhausted keyspace instead of falling back to integer positions", () => {
    expect(() => generateKeyBetween(null, "0")).toThrow(/minimum key/);
  });
});
