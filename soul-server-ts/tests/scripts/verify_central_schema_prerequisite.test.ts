import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyCentralSchemaPrerequisite } from
  "../../scripts/verify-central-schema-prerequisite.mjs";

const UPSTREAM_URL = "ws://central.test/socket";
const SCHEMA_GENERATION = "20261116_restart_reads:checksum-1";

function healthResponse(
  body: Record<string, unknown> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify({
    status: "ok",
    database_schema: {
      migration_id: "20261116_restart_reads",
      checksum: "checksum-1",
    },
    ...body,
  }), { status, headers: { "content-type": "application/json" } });
}

function fakeClock(): {
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
  sleeps: number[];
} {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
    sleeps,
  };
}

describe("verifyCentralSchemaPrerequisite", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits through 502s and passes once central answers", async () => {
    const clock = fakeClock();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(healthResponse({}, 502))
      .mockResolvedValueOnce(healthResponse({}, 502))
      .mockResolvedValueOnce(healthResponse());

    const schema = await verifyCentralSchemaPrerequisite({
      upstreamUrl: UPSTREAM_URL,
      schemaGeneration: SCHEMA_GENERATION,
      fetchImpl: fetchMock,
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
    });

    expect(schema).toEqual({
      migration_id: "20261116_restart_reads",
      checksum: "checksum-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://central.test/api/health");
    expect(clock.sleeps).toEqual([5_000, 5_000]);
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs))
      .toEqual([10_000, 10_000, 10_000]);
  });

  it("fails with the existing message when central answers 502 for the whole budget", async () => {
    const clock = fakeClock();
    const fetchMock = vi.fn(async () => healthResponse({}, 502));

    await expect(verifyCentralSchemaPrerequisite({
      upstreamUrl: UPSTREAM_URL,
      schemaGeneration: SCHEMA_GENERATION,
      fetchImpl: fetchMock,
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
    })).rejects.toThrow(
      "central database schema prerequisite mismatch: health returned 502",
    );

    expect(fetchMock).toHaveBeenCalledTimes(72);
    expect(clock.sleeps).toHaveLength(72);
    expect(clock.sleeps.at(-1)).toBe(5_000);
    expect(clock.now()).toBe(360_000);
  });

  it("fails right away on a 404", async () => {
    const clock = fakeClock();
    const fetchMock = vi.fn(async () => healthResponse({}, 404));

    await expect(verifyCentralSchemaPrerequisite({
      upstreamUrl: UPSTREAM_URL,
      schemaGeneration: SCHEMA_GENERATION,
      fetchImpl: fetchMock,
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
    })).rejects.toThrow(
      "central database schema prerequisite mismatch: health returned 404",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("retries connection errors and fetch timeouts inside the window", async () => {
    const clock = fakeClock();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("connect ECONNREFUSED 127.0.0.1:3105"),
          { code: "ECONNREFUSED" },
        ),
      }))
      .mockRejectedValueOnce(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      )
      .mockResolvedValueOnce(healthResponse());

    await expect(verifyCentralSchemaPrerequisite({
      upstreamUrl: UPSTREAM_URL,
      schemaGeneration: SCHEMA_GENERATION,
      fetchImpl: fetchMock,
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
    })).resolves.toMatchObject({ migration_id: "20261116_restart_reads" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([5_000, 5_000]);
  });

  it("passes once a rolling schema generation catches up", async () => {
    const clock = fakeClock();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(healthResponse({
        database_schema: {
          migration_id: "20261116_restart_reads",
          checksum: "previous-checksum",
        },
      }))
      .mockResolvedValueOnce(healthResponse());

    await expect(verifyCentralSchemaPrerequisite({
      upstreamUrl: UPSTREAM_URL,
      schemaGeneration: SCHEMA_GENERATION,
      fetchImpl: fetchMock,
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
    })).resolves.toEqual({
      migration_id: "20261116_restart_reads",
      checksum: "checksum-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([5_000]);
  });

  it("keeps the mismatch error when the schema never matches", async () => {
    const clock = fakeClock();
    const fetchMock = vi.fn(async () => healthResponse({
      status: "degraded",
    }));

    await expect(verifyCentralSchemaPrerequisite({
      upstreamUrl: UPSTREAM_URL,
      schemaGeneration: SCHEMA_GENERATION,
      fetchImpl: fetchMock,
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
      totalBudgetMs: 12_000,
    })).rejects.toThrow(
      "central database schema prerequisite mismatch: target migration is not active",
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([5_000, 5_000, 2_000]);
    expect(clock.now()).toBe(12_000);
  });
});
