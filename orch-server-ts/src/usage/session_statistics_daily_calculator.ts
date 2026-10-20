import { createSessionStatisticsDailyState, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION } from "./session_statistics_daily_state.js";
import { sessionStatisticsDate } from "./session_statistics_scope.js";
import type { SessionStatisticsReadRequest, SessionStatisticsRepositoryPort } from "./session_statistics_types.js";

export function statisticsShiftDay(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function statisticsLiveDays(asOf: string): string[] {
  const today = sessionStatisticsDate(asOf)!;
  const kstHour = new Date(Date.parse(asOf) + 9 * 60 * 60 * 1000).getUTCHours();
  return kstHour < 2 ? [statisticsShiftDay(today, -1), today] : [today];
}

/** One invocation computes at most one date; no ingestion changes or dependency invalidation. */
export async function calculateSessionStatisticsDay(repository: SessionStatisticsRepositoryPort,
  input: SessionStatisticsReadRequest): Promise<boolean> {
  if (!repository.daily || !repository.readMetadata || !repository.readSlice) return false;
  const daily = repository.daily;
  const readMetadata = repository.readMetadata.bind(repository);
  const readSlice = repository.readSlice.bind(repository);
  let computed = false;
  await daily.withLock(async () => {
    const globalInput: SessionStatisticsReadRequest = { ...input, day: null,
      query: { period: "all", anchor: sessionStatisticsDate(input.asOf)! },
      access: { restricted: false, allowedFolderIds: [] } };
    const metadata = await readMetadata(globalInput);
    const before = statisticsLiveDays(input.asOf)[0]!;
    if (metadata.range.since >= before) return;
    const batches = await daily.load(metadata.range.since, before, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION, []);
    const byDay = new Map(batches.map(batch => [batch.day, batch]));
    const recentSince = statisticsShiftDay(sessionStatisticsDate(input.asOf)!, -7);
    const maxima = await daily.sourceMax(recentSince, before);
    let selected: string | undefined;
    for (let date = statisticsShiftDay(before, -1); date >= metadata.range.since; date = statisticsShiftDay(date, -1)) {
      const prior = byDay.get(date);
      if (prior === undefined || (date >= recentSince && BigInt(maxima.get(date) ?? "0") > BigInt(prior.sourceMaxEventId))) {
        selected = date;
        break;
      }
    }
    if (selected === undefined) {
      computed = await daily.regroupNext?.(metadata.range.since, before, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION) ?? false;
      return;
    }
    const maximum = selected >= recentSince ? maxima.get(selected) ?? "0"
      : (await daily.sourceMax(selected, statisticsShiftDay(selected, 1))).get(selected) ?? "0";
    const read = await readSlice(globalInput, selected);
    await daily.save(createSessionStatisticsDailyState(read, selected), maximum);
    computed = true;
  });
  return computed;
}
