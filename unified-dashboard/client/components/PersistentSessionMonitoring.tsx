import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, type ModelPresetAvailability } from "@seosoyoung/soul-ui";
import { pairTurnUsage } from "@seosoyoung/soul-ui/lib/persistent-turn-usage";
import { formatTurnUsageCaptionTitle } from "@seosoyoung/soul-ui/lib/turn-usage-format";
import { HISTORY_PAGE_SIZE } from "@seosoyoung/soul-ui/components/chat/useMessageHistoryBuffer";

import type { PersistentSession } from "../lib/persistent-sessions";
import { fetchNodeModelPresets } from "../lib/model-presets";
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
const PERCENT_FORMAT = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

export function usePersistentSessionMonitoring({
  sessionId,
  nodeId,
  request = fetch,
}: {
  sessionId: string;
  nodeId: string;
  request?: typeof fetch;
}) {
  const [generationState, setGenerationState] = useState<ReadState>("loading");
  const [generation, setGeneration] = useState<TimelineEvent | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
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
    setHistory({ state: "loading", events: [], nextCursor: null, error: null, loadingMore: false });

    void readTimeline(request, sessionId, {
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

    void readTimeline(request, sessionId, {
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
  }, [nodeId, reload, request, sessionId]);

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
      const page = await readTimeline(request, sessionId, {
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
  }, [history.loadingMore, history.nextCursor, request, sessionId]);

  return { generationState, generation, generationError, history, loadMore, retry, modelPresets };
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
  const { generationState, generation, generationError, history, loadMore, retry } = state;
  const usageByTerminalId = useMemo(() => turnUsageByTerminalId(history.events), [history.events]);
  const isLoading = generationState === "loading" || history.state === "loading";
  const error = generationError ?? history.error;
  const hasError = generationState === "error" || history.state === "error";
  const visibleEvents = useMemo(
    () => displayHistoryEvents(history.events, generation, usageByTerminalId),
    [generation, history.events, usageByTerminalId],
  );
  const generationText = generation
    ? typeof generation.payload.generation === "number"
      ? `세대 ${generation.payload.generation}`
      : displayTime(generation.created_at)
    : "세대 기록 없음";
  const hasAnyDisplayedRecord = Boolean(generation) || visibleEvents.length > 0;

  return <div data-testid="persistent-session-monitoring" className="space-y-4">
    {isLoading ? <p className="text-sm text-muted-foreground">불러오는 중…</p> : null}
    {!isLoading && hasError ? <div className="space-y-2">
      <SettingsAlert>조회 실패: {error ?? "기록을 불러오지 못했습니다."}</SettingsAlert>
      <Button type="button" size="sm" variant="outline" onClick={retry}>다시 시도</Button>
    </div> : null}
    {!isLoading && !hasError ? <>
      {hasAnyDisplayedRecord ? <SettingFieldWidget field={readField("generation", "현재 세대", generationText)} value={generationText} onChange={() => undefined} /> : <p className="text-sm text-muted-foreground">세대 기록 없음</p>}
      {hasAnyDisplayedRecord || history.nextCursor ? <section className="space-y-2" aria-label="최근 기록">
        <h3 className="text-sm font-medium">최근 기록</h3>
        {visibleEvents.length > 0 ? <ol className="space-y-2" aria-label="최근 세션 기록">
          {visibleEvents.map(({ event, detail }) => <li key={String(event.id)} data-testid="persistent-session-history-row" data-event-id={String(event.id)} className="min-w-0">
            <time dateTime={event.created_at} className="block text-xs text-muted-foreground">{displayTime(event.created_at)}</time>
            <p className="break-words text-sm text-foreground">{detail}</p>
          </li>)}
        </ol> : generation ? <p className="text-sm text-muted-foreground">기록 없음</p> : null}
        {history.nextCursor ? <Button type="button" size="sm" variant="outline" disabled={history.loadingMore} onClick={() => void loadMore()}>
          {history.loadingMore ? "불러오는 중…" : "더 읽기"}
        </Button> : null}
        {history.error ? <div className="space-y-2">
          <SettingsAlert>조회 실패: {history.error}</SettingsAlert>
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
  const rows = useMemo(() => persistentSessionQuotaRows(resource, presets), [presets, resource]);
  if (rows.length === 0) return null;
  return <SettingsGroupBox title="계정 여유">
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

export function persistentSessionQuotaRows(resource: PersistentSession, presets: readonly ModelPresetAvailability[]) {
  const groups = new Map<string, {
    backend: string;
    roles: string[];
    headroom: number;
    resetsAt: string | null;
    observedAt: string | null;
    quotaLabel: string | null;
  }>();
  const references = [
    { role: "현재", presetId: resource.runtime.current_model.model_preset },
    { role: "기본", presetId: resource.settings.default_model.model_preset },
    { role: "대체", presetId: resource.settings.fallback_model?.model_preset ?? null },
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
    const provider = group.backend === "claude" ? "Claude" : group.backend === "codex" ? "Codex" : group.backend;
    const metadata = [
      group.resetsAt ? `초기화 ${displayTime(group.resetsAt)}` : null,
      group.observedAt ? `관측 ${displayTime(group.observedAt)}` : null,
    ].filter(Boolean).join(" · ");
    return {
      key,
      label: `${provider} · ${group.roles.join("·")}`,
      value: `${group.quotaLabel ?? "7일"} 여유 ${PERCENT_FORMAT.format(group.headroom)}%`,
      description: metadata,
    };
  });
}

async function readTimeline(request: typeof fetch, sessionId: string, parameters: Record<string, string>): Promise<TimelinePage> {
  const query = new URLSearchParams(parameters);
  const response = await request(`/api/sessions/${encodeURIComponent(sessionId)}/timeline?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`기록을 불러오지 못했습니다 (${response.status})`);
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

function turnUsageByTerminalId(events: readonly TimelineEvent[]): Map<string, string> {
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
    });
    return [[String(pair.terminalId), detail ?? "턴 완료"]];
  }));
}

function displayHistoryEvents(events: readonly TimelineEvent[], latestGeneration: TimelineEvent | null, usageByTerminalId: ReadonlyMap<string, string>) {
  return [...events]
    .filter((event) => DISPLAY_EVENT_TYPES.has(event.event_type))
    .filter((event) => event.event_type !== "context_usage")
    .filter((event) => event.event_type !== "generation_started" || String(event.id) !== String(latestGeneration?.id))
    .map((event) => ({
      event,
      detail: event.event_type === "complete"
        ? usageByTerminalId.get(String(event.id)) ?? "턴 완료"
        : generationSummary(event),
    }));
}

function generationSummary(event: TimelineEvent): string {
  const current = asRecord(event.payload.current);
  const model = asString(current?.model) ?? asString(current?.model_preset);
  const reason = asString(event.payload.reason);
  const reasonLabel = generationReasonLabel(reason);
  return [reasonLabel, model].filter(Boolean).join(" · ") || "세대 교체";
}

function generationReasonLabel(reason: string | null): string {
  switch (reason) {
    case "weekly_headroom": return "주간 사용 여유";
    case "settings": return "설정 변경";
    case "target model preset unavailable": return "모델 사용 불가";
    default: return "세대 교체";
  }
}

function readField(key: string, label: string, value: string, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "str", sensitive: false, hot_reloadable: true, read_only: true, read_only_display: true };
}

function displayTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value); }
