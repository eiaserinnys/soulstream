import { afterEach, describe, expect, it, vi } from "vitest";
import type { FolderContentSql } from "../src/board/folder_content_sql.js";
import { calculateSessionStatisticsDay, type QuietTickMemory } from "../src/usage/session_statistics_daily_calculator.js";
import { SessionStatisticsDailyRepository } from "../src/usage/session_statistics_daily_repository.js";
import { SessionStatisticsDailyService } from "../src/usage/session_statistics_daily_service.js";
import { createSessionStatisticsDailyState, type SessionStatisticsDailyState } from "../src/usage/session_statistics_daily_state.js";
import type { SessionStatisticsReadRequest, SessionStatisticsReadResult } from "../src/usage/session_statistics_types.js";
import { read, usageRow } from "./fixtures/session_statistics_aggregation.fixtures.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

const catalog = repositoryModelCatalog();
const CATALOG = catalog.snapshot();

const services: SessionStatisticsDailyService[] = [];
afterEach(() => services.splice(0).forEach(service => service.close()));

function fixture() {
  const metadata: SessionStatisticsReadResult = read([usageRow()]);
  const input: SessionStatisticsReadRequest = { query: metadata.query, timezone: "Asia/Seoul", asOf: metadata.asOf,
    access: { restricted: false, allowedFolderIds: [] }, visibleFolders: [], day: null };
  const saved = { ...createSessionStatisticsDailyState(metadata, "2026-10-19", CATALOG), sourceMaxEventId: "20" };
  const daily = { load: vi.fn(async () => [saved]), sourceMax: vi.fn(async () => new Map([["2026-10-19", "20"]])),
    factsChangedSince: vi.fn(async (_since: string, _before: string, _receiptsSince: Date | null) =>
      ({ changed: true, probedAt: new Date("2026-10-20T00:00:00.000Z") })),
    save: vi.fn(async (_state: SessionStatisticsDailyState, _maximum: string) => {}),
    withLock: vi.fn(async (work: () => Promise<void>) => { await work(); return true; }) };
  const repository = { daily, readMetadata: vi.fn(async () => ({ ...metadata, rows: [] as SessionStatisticsReadResult["rows"] })),
    readSlice: vi.fn(async (_input: SessionStatisticsReadRequest, _day: string) => metadata), read: vi.fn(async () => metadata) };
  return { metadata, input, daily, repository };
}

const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"),
  { name: "PostgresError", code: "57014", query: "SELECT secret_column FROM event_ingress_receipts", parameters: ["secret-binding"] });

describe("daily statistics probe", () => {
  it("falls back to the full scan and finishes the tick when the probe throws", async () => {
    const f = fixture();
    f.daily.factsChangedSince.mockRejectedValue(timeout());
    f.daily.sourceMax.mockResolvedValue(new Map([["2026-10-19", "21"]]));
    const failures: unknown[] = [];
    const quiet: { memory: QuietTickMemory } = { memory: undefined };

    expect(await calculateSessionStatisticsDay(f.repository, f.input, CATALOG, quiet, error => failures.push(error))).toBe(true);

    expect(failures).toHaveLength(1);
    expect(f.daily.sourceMax).toHaveBeenCalledTimes(1);
    expect(f.daily.save.mock.calls[0]?.[1]).toBe("21");
    expect(quiet.memory).toBeUndefined();
  });

  it("asks for a fresh full scan on the next tick after a failed probe on an idle day", async () => {
    const f = fixture();
    f.daily.factsChangedSince.mockRejectedValueOnce(timeout());
    const quiet: { memory: QuietTickMemory } = { memory: undefined };

    expect(await calculateSessionStatisticsDay(f.repository, f.input, CATALOG, quiet, () => {})).toBe(false);
    expect(quiet.memory).toBeUndefined();
    expect(await calculateSessionStatisticsDay(f.repository, f.input, CATALOG, quiet, () => {})).toBe(false);

    expect(f.daily.factsChangedSince.mock.calls.map(call => call[2])).toEqual([null, null]);
    expect(f.daily.sourceMax).toHaveBeenCalledTimes(2);
  });

  it("reads no receipts and calls the full scan when there is no receiptsSince", async () => {
    const probedAt = new Date("2026-10-20T00:00:00.000Z");
    const statements: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return [{ probed_at: probedAt }];
    });
    const repository = new SessionStatisticsDailyRepository(sql as unknown as FolderContentSql);

    expect(await repository.factsChangedSince("2026-10-13", "2026-10-20", null)).toEqual({ changed: true, probedAt });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toMatch(/event_ingress_receipts|events/);

    const f = fixture();
    f.daily.factsChangedSince.mockImplementation(async (since, before, receiptsSince) =>
      repository.factsChangedSince(since, before, receiptsSince));
    await calculateSessionStatisticsDay(f.repository, f.input, CATALOG);
    expect(f.daily.sourceMax).toHaveBeenCalledTimes(1);
    expect(statements.every(text => !/event_ingress_receipts/.test(text))).toBe(true);
  });

  it("logs the site and SQLSTATE of a failed probe without the query text, bindings, or stack", async () => {
    const f = fixture();
    f.daily.factsChangedSince.mockRejectedValue(timeout());
    const warn = vi.fn();
    const service = new SessionStatisticsDailyService(async () => f.repository, catalog, () => new Date(f.metadata.asOf), warn);
    services.push(service);

    await service.getOverview(f.input);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toEqual({
      cause_code: "SESSION_STATISTICS_DAILY_REFRESH_FAILED",
      site: "probe",
      error_name: "PostgresError",
      error_code: "57014",
      message: "canceling statement due to statement timeout",
    });
    const line = JSON.stringify([fields, message]);
    expect(line).not.toContain("secret_column");
    expect(line).not.toContain("secret-binding");
    expect(line).not.toContain("event_ingress_receipts");
    expect(warn.mock.calls.filter(([entry]) => (entry as { site: string }).site === "tick")).toEqual([]);
  });

  it("truncates a long message", async () => {
    const f = fixture();
    f.daily.factsChangedSince.mockRejectedValue(new Error("x".repeat(1000)));
    const warn = vi.fn();
    const service = new SessionStatisticsDailyService(async () => f.repository, catalog, () => new Date(f.metadata.asOf), warn);
    services.push(service);

    await service.getOverview(f.input);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect((warn.mock.calls[0]![0] as { message: string }).message).toHaveLength(200);
  });
});
