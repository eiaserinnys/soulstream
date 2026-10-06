import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import type { HistoricalMessage } from '../../api/historyTypes';
import type { PersistentSessionResource } from '../../api/persistentSessionEndpoints';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import { pairTurnUsage } from '../../../../packages/soul-ui/src/lib/persistent-turn-usage';
import { formatTurnUsageCaptionTitle } from '../../../../packages/soul-ui/src/lib/turn-usage-format';
import { useTokens } from '../../theme';
import {
  SettingsAction as Action,
  SettingsFormGroup as Group,
  SettingsReadOnlyField as ReadOnlyField,
} from './SettingsFormParts';
import { SettingsSection } from './SettingsSection';
import { PersistentSessionRuntimeFields } from './PersistentSessionSettingsFields';
import { usePersistentSessionApiFactory } from './persistentSessionApi';

const HISTORY_EVENT_TYPES = ['generation_started', 'complete', 'context_usage'];
const HISTORY_PAGE_SIZE = 100;
type ReadState = 'loading' | 'ready' | 'error';

export function PersistentSessionMonitoring({
  serverUrl,
  sessionId,
  session,
  sessionState,
  presets,
}: {
  serverUrl: string;
  sessionId: string;
  session: PersistentSessionResource | null;
  sessionState: ReadState;
  presets: ModelPresetAvailability[];
}) {
  const t = useTokens();
  const createApi = usePersistentSessionApiFactory();
  const [generationState, setGenerationState] = useState<ReadState>('loading');
  const [latestGeneration, setLatestGeneration] = useState<HistoricalMessage | null>(null);
  const [historyState, setHistoryState] = useState<ReadState>('loading');
  const [history, setHistory] = useState<HistoricalMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!serverUrl) {
      setGenerationState('error');
      setHistoryState('error');
      return;
    }
    let active = true;
    const api = createApi(serverUrl);
    setGenerationState('loading');
    setHistoryState('loading');
    void api.getTimeline(sessionId, { eventTypes: ['generation_started'], limit: 1 })
      .then((result) => {
        if (!active) return;
        setLatestGeneration(result.messages[0] ?? null);
        setGenerationState('ready');
      })
      .catch(() => { if (active) setGenerationState('error'); });
    void api.getTimeline(sessionId, { eventTypes: HISTORY_EVENT_TYPES, limit: HISTORY_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setHistory(result.messages);
        setNextCursor(result.next_cursor);
        setHistoryState('ready');
      })
      .catch(() => { if (active) setHistoryState('error'); });
    return () => { active = false; };
  }, [serverUrl, sessionId, createApi]);

  const usageByTerminalId = useMemo(() => {
    const chronological = [...history].reverse().map((event) => ({
      id: event.id,
      type: event.event_type,
      data: event.payload,
    }));
    return new Map(pairTurnUsage<Record<string, unknown>>(chronological).map((pair) => {
      const context = pair.contextUsage;
      const terminal = pair.complete;
      const title = formatTurnUsageCaptionTitle({
        percent: context?.percent,
        estimated: context?.estimated,
        usage: terminal?.usage,
        turnCostUsd: terminal?.turn_cost_usd,
      });
      return [String(pair.terminalId), title ?? '기록 없음'];
    }));
  }, [history]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore || historyState !== 'ready') return;
    setLoadingMore(true);
    try {
      const result = await createApi(serverUrl).getTimeline(sessionId, {
        before: nextCursor,
        eventTypes: HISTORY_EVENT_TYPES,
        limit: HISTORY_PAGE_SIZE,
      });
      setHistory((current) => [...current, ...result.messages]);
      setNextCursor(result.next_cursor);
    } catch {
      setHistoryState('error');
    } finally {
      setLoadingMore(false);
    }
  };

  const generationValue = generationState === 'loading'
    ? '불러오는 중'
    : generationState === 'error'
      ? '조회 실패'
      : latestGeneration
        ? typeof latestGeneration.payload.generation === 'number'
          ? `세대 ${latestGeneration.payload.generation}`
          : '세대 기록 있음'
        : '세대 기록 없음';

  return <SettingsSection id="persistent-session-monitoring" title="" flattened>
    {session ? <PersistentSessionRuntimeFields session={session} presets={presets} /> : <Group title="현재 정보">
      <ReadOnlyField label="현재 모델과 대기 변경" value={sessionState === 'loading' ? '불러오는 중' : sessionState === 'error' ? '조회 실패' : '기록 없음'} />
    </Group>}
    <Group>
      <ReadOnlyField label="현재 세대" value={generationValue} />
      {generationState === 'loading' ? <ActivityIndicator accessibilityLabel="불러오는 중" color={t.colors.accent} /> : null}
      <ReadOnlyField label="최근 기록" value={historyState === 'loading' ? '불러오는 중' : historyState === 'error' ? '조회 실패' : history.length ? `${history.length}개` : '기록 없음'} />
      {historyState === 'loading' ? <ActivityIndicator accessibilityLabel="불러오는 중" color={t.colors.accent} /> : null}
      {historyState === 'ready' ? history
        .filter((event) => event.event_type === 'generation_started' || event.event_type === 'complete')
        .map((event) => {
          const time = new Date(event.created_at).toLocaleString('ko-KR', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
          const title = event.event_type === 'generation_started'
            ? typeof event.payload.generation === 'number' ? `세대 ${event.payload.generation}` : '세대 시작'
            : '턴 완료';
          const detail = event.event_type === 'complete'
            ? usageByTerminalId.get(String(event.id)) ?? '기록 없음'
            : '시작';
          return <ReadOnlyField key={event.id} label={title} value={`${time} · ${detail}`} />;
        }) : null}
      {historyState === 'ready' && nextCursor ? <Action label={loadingMore ? '불러오는 중…' : '더 보기'} disabled={loadingMore} onPress={() => void loadMore()} testID="persistent-session-monitoring-more" /> : null}
    </Group>
  </SettingsSection>;
}
