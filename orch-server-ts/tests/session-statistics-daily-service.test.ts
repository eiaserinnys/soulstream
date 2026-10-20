import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatisticsDailyService } from "../src/usage/session_statistics_daily_service.js";
import { calculateSessionStatisticsDay, statisticsLiveDays } from "../src/usage/session_statistics_daily_calculator.js";
import { createSessionStatisticsDailyState, type SessionStatisticsDailyState } from "../src/usage/session_statistics_daily_state.js";
import type { SessionStatisticsReadRequest, SessionStatisticsReadResult } from "../src/usage/session_statistics_types.js";
import { read, usageRow } from "./fixtures/session_statistics_aggregation.fixtures.js";

const services: SessionStatisticsDailyService[] = [];
afterEach(() => services.splice(0).forEach(service => service.close()));

function fixture() {
  const metadata: SessionStatisticsReadResult = read([usageRow()]);
  const input: SessionStatisticsReadRequest = { query: metadata.query, timezone: "Asia/Seoul", asOf: metadata.asOf,
    access: { restricted: false, allowedFolderIds: [] }, visibleFolders: [], day: null };
  const saved = { ...createSessionStatisticsDailyState(metadata, "2026-10-19"), sourceMaxEventId: "20" };
  const daily = { load: vi.fn(async () => [saved]), sourceMax: vi.fn(async () => new Map([["2026-10-19", "20"]])),
    save: vi.fn(async (_state: SessionStatisticsDailyState, _maximum: string) => {}), withLock: vi.fn(async (work: () => Promise<void>) => { await work(); return true; }) };
  const repository = { daily, readMetadata: vi.fn(async () => ({ ...metadata, rows: [] })),
    readSlice: vi.fn(async (_input: SessionStatisticsReadRequest, _day: string) => metadata), read: vi.fn(async () => metadata) };
  return { metadata, input, saved, daily, repository };
}

describe("daily statistics scheduling and live cache", () => {
  it("keeps yesterday live before 02:00 KST and closes it at 02:00", () => {
    expect(statisticsLiveDays("2026-10-19T16:00:00Z")).toEqual(["2026-10-19", "2026-10-20"]);
    expect(statisticsLiveDays("2026-10-19T17:00:00Z")).toEqual(["2026-10-20"]);
  });

  it("waits on a cold live slice, reuses it, and returns stale data while refreshing", async () => {
    const f = fixture();
    let time = Date.parse(f.metadata.asOf);
    const service = new SessionStatisticsDailyService(async () => f.repository, () => new Date(time));
    services.push(service);
    const first = await service.getOverview(f.input);
    const calls = f.repository.readSlice.mock.calls.length;
    await service.getOverview(f.input);
    expect(f.repository.readSlice).toHaveBeenCalledTimes(calls);
    time += 61_000;
    let release!: (value: SessionStatisticsReadResult) => void;
    f.repository.readSlice.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stale = await service.getOverview({ ...f.input, asOf: new Date(time).toISOString() });
    expect(stale.as_of).toBe(first.as_of);
    expect(stale.totals.metrics).toEqual(first.totals.metrics);
    release(f.metadata);
    expect(f.repository.read).not.toHaveBeenCalled();
  });

  it("uses the direct path while a stored day is missing", async () => {
    const f = fixture();
    f.daily.load.mockResolvedValue([]);
    const service = new SessionStatisticsDailyService(async () => f.repository, () => new Date(f.metadata.asOf));
    services.push(service);
    await service.getOverview(f.input);
    expect(f.repository.read).toHaveBeenCalledTimes(1);
  });

  it("recalculates one recent changed date under the advisory lock", async () => {
    const f = fixture();
    f.daily.sourceMax.mockResolvedValue(new Map([["2026-10-19", "21"]]));
    expect(await calculateSessionStatisticsDay(f.repository, f.input)).toBe(true);
    expect(f.daily.withLock).toHaveBeenCalledTimes(1);
    expect(f.daily.save).toHaveBeenCalledTimes(1);
    expect(f.daily.save.mock.calls[0]?.[1]).toBe("21");
  });
});
