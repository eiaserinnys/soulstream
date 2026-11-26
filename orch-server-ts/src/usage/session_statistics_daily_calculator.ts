import type { ModelCatalogConfig } from "@soulstream/model-catalog";
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

/** Receipts are stamped with the transaction start, so a commit may land this long after its stamp. */
const RECEIPT_COMMIT_LAG_MS = 5 * 60_000;

/** Receives the error of a failed probe; the tick carries on as if the facts had changed. */
export type ProbeFailureSink = (error: unknown) => void;

/** What the last idle tick saw: the recent-days window and the database clock before it read the facts. */
export type QuietTickMemory = { window: string; probedAt: Date } | undefined;

/**
 * One invocation computes at most one date; no ingestion changes or dependency invalidation.
 * The recent-days max-event scan is skipped while the previous tick found nothing to do and no
 * receipt of a late event in that window has arrived since. A probe that throws counts as
 * "changed" and leaves no memory, so the next tick starts from a full scan again.
 */
export async function calculateSessionStatisticsDay(repository: SessionStatisticsRepositoryPort,
  input: SessionStatisticsReadRequest, catalog: ModelCatalogConfig,
  quiet: { memory: QuietTickMemory } = { memory: undefined },
  onProbeFailure: ProbeFailureSink = () => {}): Promise<boolean> {
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
    const window = `${recentSince}|${before}`;
    const remembered = quiet.memory?.window === window ? quiet.memory : undefined;
    const receiptsSince = remembered === undefined ? null : new Date(remembered.probedAt.getTime() - RECEIPT_COMMIT_LAG_MS);
    let probe: { changed: boolean; probedAt?: Date };
    try {
      probe = await daily.factsChangedSince(recentSince, before, receiptsSince);
    } catch (error) {
      onProbeFailure(error);
      probe = { changed: true };
    }
    quiet.memory = undefined;
    const maxima = probe.changed ? await daily.sourceMax(recentSince, before) : undefined;
    let selected: string | undefined;
    for (let date = statisticsShiftDay(before, -1); date >= metadata.range.since; date = statisticsShiftDay(date, -1)) {
      const prior = byDay.get(date);
      if (prior === undefined || (date >= recentSince && BigInt(maxima?.get(date) ?? "0") > BigInt(prior.sourceMaxEventId))) {
        selected = date;
        break;
      }
    }
    if (selected === undefined) {
      if (probe.probedAt !== undefined) quiet.memory = { window, probedAt: probe.probedAt };
      computed = await daily.regroupNext?.(metadata.range.since, before, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION) ?? false;
      return;
    }
    const maximum = selected >= recentSince && maxima !== undefined ? maxima.get(selected) ?? "0"
      : (await daily.sourceMax(selected, statisticsShiftDay(selected, 1))).get(selected) ?? "0";
    const read = await readSlice(globalInput, selected);
    await daily.save(createSessionStatisticsDailyState(read, selected, catalog), maximum);
    computed = true;
  });
  return computed;
}
