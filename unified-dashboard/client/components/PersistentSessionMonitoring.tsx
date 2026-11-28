import { intlLocale, resolveLanguage } from "@soulstream/i18n";
import { adminTranslation, dashboardLanguage } from "./config/admin-translation";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, FrameLoading } from "@seosoyoung/soul-ui";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";
import { pairTurnUsage } from "@seosoyoung/soul-ui/lib/persistent-turn-usage";
import { formatTurnUsageCaptionTitle } from "@seosoyoung/soul-ui/lib/turn-usage-format";
import { HISTORY_PAGE_SIZE } from "@seosoyoung/soul-ui/components/chat/useMessageHistoryBuffer";
import { asRecord } from "../../../packages/wire-schema/src/json_record";
import type { PersistentSession } from "../lib/persistent-sessions";
import { fetchNodeModelPresets } from "@seosoyoung/soul-ui/shared/model-presets";
import { SettingFieldWidget, type SettingField } from "./config/SettingFieldWidget";
import { SettingsAlert, SettingsGroupBox } from "./config/SettingsListDetail";

type TimelineEvent = {
  id: number | string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type TimelinePage = { messages: TimelineEvent[]; next_cursor: string | null };
type ReadState = "loading" | "ready" | "error";

type MonitoringState = {
  state: ReadState;
  events: TimelineEvent[];
  nextCursor: string | null;
  error: string | null;
  loadingMore: boolean;
};

const HISTORY_EVENT_TYPES = "generation_started,complete,context_usage,error,user_message,intervention_sent";
const DISPLAY_EVENT_TYPES = new Set(["generation_started", "complete", "context_usage"]);
type Translate = ReturnType<typeof useTranslation>["t"];

export function usePersistentSessionMonitoring({
  sessionId,
  nodeId,
  request = fetch,
}: {
  sessionId: string;
  nodeId: string;
  request?: typeof fetch;
}) {
  const { i18n } = useTranslation();
  const [generationState, setGenerationState] = useState<ReadState>("loading");
  const [generation, setGeneration] = useState<TimelineEvent | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [latestDecision, setLatestDecision] = useState<TimelineEvent | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [history, setHistory] = useState<MonitoringState>({
    state: "loading",
    events: [],
    nextCursor: null,
    error: null,
    loadingMore: false,
  });
  const [modelPresets, setModelPresets] = useState<ModelPresetAvailability[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setGenerationState("loading");
    setGeneration(null);
    setGenerationError(null);
    setLatestDecision(null);
    setDecisionError(null);
    setHistory({ state: "loading", events: [], nextCursor: null, error: null, loadingMore: false });

    void readTimeline(i18n.t, request, sessionId, {
      event_types: "generation_started",
      limit: "1",
    }).then((page) => {
      if (!active) return;
      setGeneration(page.messages[0] ?? null);
      setGenerationState("ready");
    }).catch((caught: unknown) => {
      if (!active) return;
      setGenerationError(errorMessage(caught));
      setGenerationState("error");
    });

    void readTimeline(i18n.t, request, sessionId, {
      event_types: "debug",
      debug_kinds: "persistent_decision",
      limit: "1",
    }).then((page) => {
      if (!active) return;
      setLatestDecision(latestPersistentDecision(page.messages));
      setDecisionError(null);
    }).catch((caught: unknown) => {
      if (!active) return;
      setLatestDecision(null);
      setDecisionError(errorMessage(caught));
    });

    void readTimeline(i18n.t, request, sessionId, {
      event_types: HISTORY_EVENT_TYPES,
      limit: String(HISTORY_PAGE_SIZE),
    }).then((page) => {
      if (!active) return;
      setHistory({ state: "ready", events: normalizeTimelineEvents(page.messages), nextCursor: page.next_cursor, error: null, loadingMore: false });
    }).catch((caught: unknown) => {
      if (!active) return;
      setHistory({ state: "error", events: [], nextCursor: null, error: errorMessage(caught), loadingMore: false });
    });

    return () => { active = false; };
  }, [i18n, nodeId, reload, request, sessionId]);

  useEffect(() => {
    let active = true;
    if (!nodeId) {
      setModelPresets([]);
      return () => { active = false; };
    }
    void fetchNodeModelPresets(nodeId, request)
      .then((presets) => { if (active) setModelPresets(presets); })
      .catch(() => { if (active) setModelPresets([]); });
    return () => { active = false; };
  }, [nodeId, request]);

  const retry = useCallback(() => setReload((value) => value + 1), []);
  const loadMore = useCallback(async () => {
    if (!history.nextCursor || history.loadingMore) return;
    setHistory((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const page = await readTimeline(i18n.t, request, sessionId, {
        event_types: HISTORY_EVENT_TYPES,
        limit: String(HISTORY_PAGE_SIZE),
        before: history.nextCursor,
      });
      setHistory((current) => ({
        ...current,
        state: "ready",
        events: normalizeTimelineEvents([...current.events, ...page.messages]),
        nextCursor: page.next_cursor,
        loadingMore: false,
        error: null,
      }));
    } catch (caught) {
      setHistory((current) => ({ ...current, loadingMore: false, error: errorMessage(caught) }));
    }
  }, [history.loadingMore, history.nextCursor, i18n, request, sessionId]);

  return { generationState, generation, generationError, history, latestDecision, decisionError, loadMore, retry, modelPresets };
}

export function PersistentSessionMonitoring({
  sessionId,
  nodeId,
  request,
}: {
  sessionId: string;
  nodeId: string;
  request?: typeof fetch;
}) {
  const state = usePersistentSessionMonitoring({ sessionId, nodeId, request });
  return <PersistentSessionMonitoringView state={state} />;
}

export function PersistentSessionMonitoringView({
  state,
}: {
  state: ReturnType<typeof usePersistentSessionMonitoring>;
}) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(resolveLanguage(i18n.resolvedLanguage, []));
  const { generationState, generation, generationError, history, latestDecision, decisionError, loadMore, retry } = state;
  const usageByTerminalId = useMemo(() => turnUsageByTerminalId(history.events, t, locale), [history.events, t, locale]);
  const isLoading = generationState === "loading" || history.state === "loading";
  const error = generationError ?? history.error;
  const hasError = generationState === "error" || history.state === "error";
  const visibleEvents = useMemo(
    () => displayHistoryEvents(history.events, generation, usageByTerminalId, t),
    [generation, history.events, usageByTerminalId, t],
  );
  const latestDecisionAction = latestDecision ? asString(latestDecision.payload.action) : null;
  const latestDecisionReason = latestDecision ? asString(latestDecision.payload.reason) : null;
  const latestDecisionText = latestDecision && latestDecisionAction && latestDecisionReason
    ? `${displayTime(latestDecision.created_at, locale)} · ${latestDecisionAction} · ${latestDecisionReason}`
    : null;
  const generationText = generation
    ? typeof generation.payload.generation === "number"
      ? t("jobs.monitoring.generation", { number: generation.payload.generation })
      : displayTime(generation.created_at, locale)
    : t("jobs.monitoring.noGeneration");
  const hasAnyDisplayedRecord = Boolean(generation) || visibleEvents.length > 0;

  return <div data-testid="persistent-session-monitoring" className="space-y-4">
    {isLoading ? <FrameLoading inline label={t("jobs.common.loading")} /> : null}
    {!isLoading && hasError ? <div className="space-y-2">
      <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.common.fetchError", { detail: error ?? t("jobs.monitoring.loadError") })}</span></SettingsAlert>
      <Button type="button" size="sm" variant="outline" onClick={retry}>{t("jobs.common.retry")}</Button>
    </div> : null}
    {!isLoading && !hasError ? <>
      {hasAnyDisplayedRecord ? <SettingFieldWidget field={readField("generation", t("jobs.monitoring.currentGeneration"), generationText)} value={generationText} onChange={() => undefined} /> : <p className="text-sm text-muted-foreground">{t("jobs.monitoring.noGeneration")}</p>}
      {decisionError ? <div className="space-y-2">
        <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.common.fetchError", { detail: decisionError })}</span></SettingsAlert>
        <Button type="button" size="sm" variant="outline" onClick={retry}>{t("jobs.common.retry")}</Button>
      </div> : null}
      {latestDecisionText ? <SettingFieldWidget field={readField("last-decision", t("jobs.monitoring.lastDecision"), latestDecisionText)} value={latestDecisionText} onChange={() => undefined} /> : null}
      {hasAnyDisplayedRecord || history.nextCursor ? <section className="space-y-2" aria-label={t("jobs.monitoring.recentActivity")}>
        <h3 className="text-sm font-medium">{t("jobs.monitoring.recentActivity")}</h3>
        {visibleEvents.length > 0 ? <ol className="space-y-2" aria-label={t("jobs.monitoring.sessionHistory")}>
          {visibleEvents.map(({ event, detail }) => <li key={String(event.id)} data-testid="persistent-session-history-row" data-event-id={String(event.id)} className="min-w-0">
            <time dateTime={event.created_at} className="block text-xs text-muted-foreground" data-v3-selectable-content="true">{displayTime(event.created_at, locale)}</time>
            <p className="break-words text-sm text-foreground" data-v3-selectable-content="true">{detail}</p>
          </li>)}
        </ol> : generation ? <p className="text-sm text-muted-foreground">{t("jobs.monitoring.noHistory")}</p> : null}
        {history.nextCursor ? <Button type="button" size="sm" variant="outline" disabled={history.loadingMore} onClick={() => void loadMore()}>
          {history.loadingMore ? t("jobs.common.loading") : t("jobs.monitoring.loadMore")}
        </Button> : null}
        {history.error ? <div className="space-y-2">
          <SettingsAlert><span data-v3-selectable-content="true">{t("jobs.common.fetchError", { detail: history.error })}</span></SettingsAlert>
        </div> : null}
      </section> : null}
    </> : null}
  </div>;
}

export function PersistentSessionAvailability({
  resource,
  presets,
}: {
  resource: PersistentSession;
  presets: readonly ModelPresetAvailability[];
}) {
  const { t, i18n } = useTranslation();
  const rows = persistentSessionQuotaRows(resource, presets, t, resolveLanguage(i18n.resolvedLanguage, []));
  if (rows.length === 0) return null;
  return <SettingsGroupBox title={t("jobs.monitoring.headroom")}>
    <div className="persistent-session-quota-rows space-y-1">
      {rows.map((row) => <SettingFieldWidget
        key={row.key}
        field={readField(row.key, row.label, row.value, row.description)}
        value={row.value}
        onChange={() => undefined}
      />)}
    </div>
  </SettingsGroupBox>;
}

export function persistentSessionQuotaRows(resource: PersistentSession, presets: readonly ModelPresetAvailability[], t: Translate = adminTranslation(), language = dashboardLanguage() ?? "ko") {
  const locale = intlLocale(language);
  const percentFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const groups = new Map<string, {
    backend: string;
    roles: string[];
    headroom: number;
    resetsAt: string | null;
    observedAt: string | null;
    quotaLabel: string | null;
  }>();
  const references = [
    { role: t("jobs.monitoring.current"), presetId: resource.runtime.current_model.model_preset },
    { role: t("jobs.monitoring.default"), presetId: resource.settings.default_model.model_preset },
    ...(resource.settings.fallback_models ?? []).map((model, index, models) => ({
      role: models.length === 1 ? t("jobs.monitoring.fallback") : t("jobs.defaults.fallbackNumber", { number: index + 1 }),
      presetId: model.model_preset,
    })),
  ];
  for (const reference of references) {
    if (!reference.presetId) continue;
    const preset = presets.find((item) => item.id === reference.presetId);
    const weekly = preset?.weekly_headroom;
    if (!preset || !weekly || weekly.status === "unavailable" || typeof weekly.headroom !== "number") continue;
    const key = JSON.stringify([preset.backend, weekly.headroom, weekly.resets_at, weekly.observed_at, weekly.quota_label]);
    const group = groups.get(key) ?? {
      backend: preset.backend,
      roles: [],
      headroom: weekly.headroom,
      resetsAt: weekly.resets_at,
      observedAt: weekly.observed_at,
      quotaLabel: weekly.quota_label,
    };
    group.roles.push(reference.role);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => {
    const provider = group.backend === "claude" ? "Claude" : group.backend === "codex" ? "Codex" : group.backend === "antigravity" ? "Antigravity" : group.backend;
    const metadata = [
      group.resetsAt ? t("jobs.monitoring.resets", { time: displayTime(group.resetsAt, locale) }) : null,
      group.observedAt ? t("jobs.monitoring.observed", { time: displayTime(group.observedAt, locale) }) : null,
    ].filter(Boolean).join(" · ");
    return {
      key,
      label: `${provider} · ${group.roles.join("·")}`,
      value: t("jobs.monitoring.quotaHeadroom", { window: group.quotaLabel ?? t("jobs.monitoring.sevenDays"), percent: percentFormat.format(group.headroom) }),
      description: metadata,
    };
  });
}

async function readTimeline(t: Translate, request: typeof fetch, sessionId: string, parameters: Record<string, string>): Promise<TimelinePage> {
  const query = new URLSearchParams(parameters);
  const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}/timeline?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(t("jobs.monitoring.requestError", { status: response.status }));
  return await response.json() as TimelinePage;
}

function normalizeTimelineEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const byId = new Map<string, TimelineEvent>();
  for (const event of events) {
    const key = String(event.id);
    if (!byId.has(key)) byId.set(key, event);
  }
  return [...byId.values()].sort((a, b) => compareEventIds(b.id, a.id));
}

function compareEventIds(a: string | number, b: string | number): number {
  const numberA = Number(a);
  const numberB = Number(b);
  if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
  return String(a).localeCompare(String(b));
}

function latestPersistentDecision(events: readonly TimelineEvent[]): TimelineEvent | null {
  return [...events]
    .filter((event) => event.event_type === "debug" && event.payload.kind === "persistent_decision")
    .sort((a, b) => {
      const timeA = Date.parse(a.created_at);
      const timeB = Date.parse(b.created_at);
      if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA;
      return compareEventIds(b.id, a.id);
    })[0] ?? null;
}

function turnUsageByTerminalId(events: readonly TimelineEvent[], t: Translate, locale: string): Map<string, string> {
  const chronological = [...events].sort((a, b) => compareEventIds(a.id, b.id)).map((event) => ({
    id: event.id,
    type: event.event_type,
    data: event.payload,
  }));
  return new Map(pairTurnUsage(chronological).flatMap((pair) => {
    if (pair.terminalType !== "complete" || !pair.complete) return [];
    const context = pair.contextUsage;
    const terminal = pair.complete;
    const detail = formatTurnUsageCaptionTitle({
      percent: context?.percent,
      estimated: context?.estimated,
      usage: terminal.usage,
      turnCostUsd: terminal.turn_cost_usd,
    }, locale);
    return [[String(pair.terminalId), detail ?? t("jobs.monitoring.turnComplete")]];
  }));
}

function displayHistoryEvents(events: readonly TimelineEvent[], latestGeneration: TimelineEvent | null, usageByTerminalId: ReadonlyMap<string, string>, t: Translate) {
  return [...events]
    .filter((event) => DISPLAY_EVENT_TYPES.has(event.event_type))
    .filter((event) => event.event_type !== "context_usage")
    .filter((event) => event.event_type !== "generation_started" || String(event.id) !== String(latestGeneration?.id))
    .map((event) => ({
      event,
      detail: event.event_type === "complete"
        ? usageByTerminalId.get(String(event.id)) ?? t("jobs.monitoring.turnComplete")
        : generationSummary(event, t),
    }));
}

function generationSummary(event: TimelineEvent, t: Translate): string {
  const current = asRecord(event.payload.current);
  const model = asString(current?.model) ?? asString(current?.model_preset);
  const reason = asString(event.payload.reason);
  const reasonLabel = generationReasonLabel(reason, t);
  return [reasonLabel, model].filter(Boolean).join(" · ") || t("jobs.monitoring.generationChanged");
}

function generationReasonLabel(reason: string | null, t: Translate): string {
  switch (reason) {
    case "weekly_headroom": return t("jobs.monitoring.weeklyHeadroom");
    case "settings": return t("jobs.monitoring.settingsChanged");
    case "target model preset unavailable": return t("jobs.monitoring.modelUnavailable");
    default: return t("jobs.monitoring.generationChanged");
  }
}

function readField(key: string, label: string, value: string, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "str", sensitive: false, hot_reloadable: true, read_only: true, read_only_display: true };
}

function displayTime(value: string, locale: string | undefined): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value); }
