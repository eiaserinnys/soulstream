import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { pairTurnUsage } from "@seosoyoung/soul-ui/lib/persistent-turn-usage";
import {
  formatContextUsageText,
  formatTurnCompleteStats,
  formatTurnUsageCaptionTitle,
} from "@seosoyoung/soul-ui/lib/turn-usage-format";
import { HISTORY_PAGE_SIZE } from "@seosoyoung/soul-ui/components/chat/useMessageHistoryBuffer";

import type { PersistentSession } from "../lib/persistent-sessions";
import { SettingFieldWidget, type SettingField } from "./config/SettingFieldWidget";

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

const HISTORY_EVENT_TYPES = "generation_started,complete,context_usage";

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
      setHistory({ state: "ready", events: page.messages, nextCursor: page.next_cursor, error: null, loadingMore: false });
    }).catch((caught: unknown) => {
      if (!active) return;
      setHistory({ state: "error", events: [], nextCursor: null, error: errorMessage(caught), loadingMore: false });
    });

    return () => { active = false; };
  }, [nodeId, request, sessionId]);

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
        events: [...current.events, ...page.messages],
        nextCursor: page.next_cursor,
        loadingMore: false,
        error: null,
      }));
    } catch (caught) {
      setHistory((current) => ({ ...current, loadingMore: false, error: errorMessage(caught) }));
    }
  }, [history.loadingMore, history.nextCursor, request, sessionId]);

  return { generationState, generation, generationError, history, loadMore };
}

export function PersistentSessionMonitoring({
  sessionId,
  nodeId,
  resource,
  request,
}: {
  sessionId: string;
  nodeId: string;
  resource: PersistentSession;
  request?: typeof fetch;
}) {
  const { generationState, generation, generationError, history, loadMore } = usePersistentSessionMonitoring({ sessionId, nodeId, request });
  return <PersistentSessionMonitoringView
    resource={resource}
    state={{ generationState, generation, generationError, history, loadMore }}
  />;
}

export function PersistentSessionMonitoringView({
  resource,
  state,
}: {
  resource: PersistentSession;
  state: ReturnType<typeof usePersistentSessionMonitoring>;
}) {
  const { generationState, generation, generationError, history, loadMore } = state;
  const latestUsage = useMemo(() => latestTurnUsage(history.events), [history.events]);
  const currentModel = currentModelText(resource);
  const pendingModel = pendingText(resource);
  const generationText = generationState === "loading"
    ? "불러오는 중…"
    : generationState === "error"
      ? `조회 실패: ${generationError ?? "요청 오류"}`
      : generation?.created_at ?? "세대 기록 없음";
  const usageText = history.state === "loading"
    ? "불러오는 중…"
    : history.state === "error"
      ? `조회 실패: ${history.error ?? "요청 오류"}`
      : latestUsage ?? "기록 없음";
  const historyText = history.state === "loading"
    ? "불러오는 중…"
    : history.state === "error"
      ? `조회 실패: ${history.error ?? "요청 오류"}`
      : history.events.length === 0
        ? "기록 없음"
        : `${history.events.length}개`;

  return <div data-testid="persistent-session-monitoring">
    <SettingFieldWidget field={readField("current_model", "현재 실행 모델", currentModel)} value={currentModel} onChange={() => undefined} />
    <SettingFieldWidget field={readField("pending", "대기 중인 변경", pendingModel)} value={pendingModel} onChange={() => undefined} />
    <SettingFieldWidget field={readField("generation", "현재 세대", generationText)} value={generationText} onChange={() => undefined} />
    <SettingFieldWidget field={readField("latest_usage", "최근 턴 사용량", usageText)} value={usageText} onChange={() => undefined} />
    <SettingFieldWidget field={readField("history", "최근 기록", historyText)} value={historyText} onChange={() => undefined} />
    {history.state === "ready" && history.events.length > 0 ? <ol className="space-y-1" aria-label="최근 세션 기록">
      {history.events.map((event) => <li key={`${event.id}-${event.event_type}`} className="text-sm text-muted-foreground">
        <span>{timelineLabel(event.event_type)}</span><span> · </span><time dateTime={event.created_at}>{event.created_at}</time>
      </li>)}
    </ol> : null}
    {history.state === "ready" && history.nextCursor ? <Button type="button" size="sm" variant="outline" disabled={history.loadingMore} onClick={() => void loadMore()}>
      {history.loadingMore ? "불러오는 중…" : "더 읽기"}
    </Button> : null}
    {history.error && history.state === "ready" ? <p role="alert" className="text-sm text-destructive">조회 실패: {history.error}</p> : null}
  </div>;
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

function latestTurnUsage(events: readonly TimelineEvent[]): string | undefined {
  const pairs = pairTurnUsage([...events].reverse().map((event) => ({
    id: event.id,
    type: event.event_type,
    data: event.payload,
  })));
  const latest = pairs[pairs.length - 1];
  if (!latest) return undefined;
  const context = latest.contextUsage;
  const complete = latest.complete;
  const caption = formatTurnUsageCaptionTitle({
    percent: context?.percent,
    estimated: context?.estimated,
    usage: complete?.usage,
    turnCostUsd: complete?.turn_cost_usd,
  });
  const stats = formatTurnCompleteStats({
    usage: complete?.usage,
    turnCostUsd: complete?.turn_cost_usd,
    sessionCostUsd: complete?.session_cost_usd,
    sessionCostPartial: complete?.session_cost_partial,
  });
  const contextText = formatContextUsageText({
    usedTokens: context?.used_tokens,
    maxTokens: context?.max_tokens,
    percent: context?.percent,
    estimated: context?.estimated,
  });
  return [caption, contextText, stats].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ") || undefined;
}

function readField(key: string, label: string, value: string): SettingField {
  return { key, field_name: key, label, description: "", value, value_type: "str", sensitive: false, hot_reloadable: true, read_only: true };
}

function currentModelText(session: PersistentSession): string {
  const { model_preset, model, reasoning_effort } = session.runtime.current_model;
  return [model ?? model_preset, reasoning_effort].filter(Boolean).join(" · ") || "모델 정보 없음";
}

function pendingText(session: PersistentSession): string {
  const pending = session.runtime.pending;
  if (!pending) return "대기 변경 없음";
  return `다음 실행부터 ${pending.target_model_preset}${pending.target_reasoning_effort ? ` · ${pending.target_reasoning_effort}` : ""}`;
}

function timelineLabel(type: string): string {
  if (type === "generation_started") return "새 세대";
  if (type === "complete") return "턴 완료";
  if (type === "context_usage") return "컨텍스트 사용량";
  return type;
}

function errorMessage(value: unknown) { return value instanceof Error ? value.message : String(value); }
