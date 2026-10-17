import { describe, expect, it } from "vitest";

import {
  buildEventArchive,
  EVENT_STRING_MAX_BYTES,
  EVENT_TRUNCATION_SUFFIX,
  truncateEventStrings,
} from "../../src/db/event_payload_truncation.js";

describe("truncateEventStrings", () => {
  it("leaves strings below and at the UTF-8 byte limit unchanged", () => {
    const below = "x".repeat(EVENT_STRING_MAX_BYTES - 1);
    const exact = "x".repeat(EVENT_STRING_MAX_BYTES);
    const input = { below, exact };

    const result = truncateEventStrings(input);

    expect(result.payload).toEqual(input);
    expect(result.truncatedFields).toEqual([]);
    expect(input).toEqual({ below, exact });
  });

  it("truncates over-limit nested strings at Unicode code point boundaries", () => {
    const original = `${"한😀".repeat(EVENT_STRING_MAX_BYTES / 5)}tail`;
    const input = {
      content: "small",
      result: [{ output: original }],
      "unchanged-key": "keep",
    };

    const result = truncateEventStrings(input);
    const truncated = result.payload.result[0].output;

    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(EVENT_STRING_MAX_BYTES);
    expect(truncated.endsWith(EVENT_TRUNCATION_SUFFIX)).toBe(true);
    expect(truncated).not.toContain("\uFFFD");
    expect(hasUnpairedSurrogate(truncated)).toBe(false);
    expect(result.payload).toMatchObject({ content: "small", "unchanged-key": "keep" });
    expect(result.truncatedFields).toEqual([{ path: ["result", 0, "output"], original }]);
    expect(input.result[0].output).toBe(original);
  });
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("buildEventArchive", () => {
  it("stores one original field as plain text", () => {
    const fields = [{ path: ["result", "content"] as (string | number)[], original: "full result" }];

    expect(buildEventArchive(fields)).toEqual({
      body: "full result",
      mimeType: "text/plain",
      extension: "txt",
    });
  });

  it("stores multiple originals as a path-keyed JSON object", () => {
    const fields = [
      { path: ["result", 0, "content"] as (string | number)[], original: "first" },
      { path: ["result", 1, "output"] as (string | number)[], original: "second" },
    ];

    expect(buildEventArchive(fields)).toEqual({
      body: JSON.stringify({ "result.0.content": "first", "result.1.output": "second" }),
      mimeType: "application/json",
      extension: "json",
    });
  });
});
