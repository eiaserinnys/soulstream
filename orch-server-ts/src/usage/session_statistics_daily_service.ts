import { buildDailyDay, buildDailyOverview } from "./session_statistics_daily_merge.js";
import { createSessionStatisticsDailyState, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION,
  type SessionStatisticsDailyState } from "./session_statistics_daily_state.js";
import { calculateSessionStatisticsDay, statisticsLiveDays, statisticsShiftDay } from "./session_statistics_daily_calculator.js";
import { resolveSessionStatisticsDay } from "./session_statistics_period.js";
import { SessionStatisticsService } from "./session_statistics_service.js";
import type { SessionStatisticsReadRequest, SessionStatisticsReadResult, SessionStatisticsRepositoryPort } from "./session_statistics_types.js";

type LiveEntry = { value?: SessionStatisticsDailyState; refreshing?: Promise<SessionStatisticsDailyState> };

/** Persistence + a 60-second stale-while-revalidate live tail; public DTOs stay unchanged. */
export class SessionStatisticsDailyService extends SessionStatisticsService {
  private readonly live = new Map<string, LiveEntry>();
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private closed = false;

  constructor(private readonly dailyRepositoryProvider: () => Promise<SessionStatisticsRepositoryPort>,
    private readonly now: () => Date = () => new Date()) {
    super(dailyRepositoryProvider);
  }

  override async getOverview(input: SessionStatisticsReadRequest) {
    const prepared = await this.prepare(input);
    return prepared === null ? super.getOverview(input) : buildDailyOverview(prepared.read, prepared.days);
  }

  override async getDay(input: SessionStatisticsReadRequest & { day: string }) {
    const prepared = await this.prepare(input);
    return prepared === null ? super.getDay(input) : buildDailyDay(prepared.read, prepared.days, input.day);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private async prepare(input: SessionStatisticsReadRequest): Promise<{
    read: SessionStatisticsReadResult; days: SessionStatisticsDailyState[];
  } | null> {
    const repository = await this.dailyRepositoryProvider();
    if (!repository.daily || !repository.readMetadata || !repository.readSlice) return null;
    const read = await repository.readMetadata(input);
    if (input.day !== null) resolveSessionStatisticsDay(input.day, read.range, input.asOf);
    this.startCalculator(input);
    const liveDays = statisticsLiveDays(input.asOf);
    const storedBefore = liveDays[0]! < read.range.effective_until ? liveDays[0]! : read.range.effective_until;
    const sessionIds = read.sessions.map(session => session.sessionId);
    const stored = read.range.since >= storedBefore ? [] : input.day === null && repository.daily.loadOverview
      ? await repository.daily.loadOverview(read.range.since, storedBefore, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION, input, sessionIds)
      : await repository.daily.load(read.range.since, storedBefore, SESSION_STATISTICS_DAILY_AGGREGATION_VERSION, sessionIds);
    const available = new Set(stored.map(day => day.day));
    for (let date = read.range.since; date < storedBefore; date = statisticsShiftDay(date, 1)) {
      if (!available.has(date)) return null;
    }
    const days: SessionStatisticsDailyState[] = [...stored];
    for (const day of liveDays) {
      if (day < read.range.since || day >= read.range.effective_until) continue;
      days.push(await this.liveDay(repository, input, day));
    }
    // Prune yesterday's transient entries after the KST live boundary moves.
    for (const day of this.live.keys()) if (!liveDays.includes(day)) this.live.delete(day);
    const liveAsOf = days.filter(day => liveDays.includes(day.day)).map(day => day.asOf).sort()[0];
    return { read: liveAsOf === undefined ? read : { ...read, asOf: liveAsOf }, days };
  }

  private liveDay(repository: SessionStatisticsRepositoryPort, input: SessionStatisticsReadRequest,
    day: string): Promise<SessionStatisticsDailyState> {
    let entry = this.live.get(day);
    if (entry === undefined) { entry = {}; this.live.set(day, entry); }
    const target = entry;
    if (target.value && Date.parse(target.value.asOf) > Date.parse(input.asOf)) {
      // Historical verification must not consume a snapshot from its future.
      return repository.readSlice!({ ...input, query: { period: "all", anchor: day } }, day)
        .then(read => createSessionStatisticsDailyState(read, day));
    }
    if (!target.value || Date.parse(input.asOf) - Date.parse(target.value.asOf) >= 60_000) {
      target.refreshing ??= repository.readSlice!({ ...input, day: null,
        query: { period: "all", anchor: day }, access: { restricted: false, allowedFolderIds: [] } }, day)
        .then(read => { const value = createSessionStatisticsDailyState(read, day); target.value = value; return value; })
        .finally(() => { target.refreshing = undefined; });
      if (target.value) void target.refreshing.catch(() => this.reportFailure());
    }
    return target.value ? Promise.resolve(target.value) : target.refreshing!;
  }

  private startCalculator(input: SessionStatisticsReadRequest): void {
    if (this.started || this.closed) return;
    this.started = true;
    const tick = async () => {
      if (this.closed) return;
      let computed = false;
      try {
        computed = await calculateSessionStatisticsDay(await this.dailyRepositoryProvider(), {
          ...input, day: null, asOf: this.now().toISOString(),
        });
      } catch { this.reportFailure(); }
      if (!this.closed) {
        this.timer = setTimeout(() => { void tick(); }, computed ? 0 : 60_000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { void tick(); }, 0);
    this.timer.unref();
  }

  private reportFailure(): void {
    console.warn({ cause_code: "SESSION_STATISTICS_DAILY_REFRESH_FAILED" });
  }
}
