import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

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
import { usePersistentSessionApiFactory } from './persistentSessionApi';

const HISTORY_EVENT_TYPES = ['generation_started', 'complete', 'context_usage', 'error', 'user_message', 'intervention_sent'];
const HISTORY_PAGE_SIZE = 100;
const PERCENT_FORMAT = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
type ReadState = 'loading' | 'ready' | 'error';

export function normalizePersistentHistory(messages: HistoricalMessage[]): HistoricalMessage[] {
  const byId = new Map<number, HistoricalMessage>();
  for (const message of messages) if (!byId.has(message.id)) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
}

export function persistentHistoryForTurnPairing(messages: HistoricalMessage[]): HistoricalMessage[] {
  return normalizePersistentHistory(messages).sort((a, b) => a.id - b.id);
}

export function PersistentSessionMonitoring({ serverUrl, sessionId }: {
  serverUrl: string;
  sessionId: string;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const createApi = usePersistentSessionApiFactory();
  const [generationState, setGenerationState] = useState<ReadState>('loading');
  const [latestGeneration, setLatestGeneration] = useState<HistoricalMessage | null>(null);
  const [latestPersistentDecision, setLatestPersistentDecision] = useState<HistoricalMessage | null>(null);
  const [historyState, setHistoryState] = useState<ReadState>('loading');
  const [history, setHistory] = useState<HistoricalMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!serverUrl) {
      setGenerationState('error');
      setHistoryState('error');
      setLatestPersistentDecision(null);
      return;
    }
    let active = true;
    const api = createApi(serverUrl);
    setGenerationState('loading');
    setHistoryState('loading');
    setLatestPersistentDecision(null);
    void api.getTimeline(sessionId, { eventTypes: ['generation_started'], limit: 1 })
      .then((result) => {
        if (!active) return;
        setLatestGeneration(result.messages[0] ?? null);
        setGenerationState('ready');
      })
      .catch(() => { if (active) setGenerationState('error'); });
    void api.getTimeline(sessionId, {
      eventTypes: ['debug'], debugKinds: ['persistent_decision'], limit: 1,
    }).then((result) => {
      if (!active) return;
      setLatestPersistentDecision(normalizePersistentHistory(result.messages).find((event) =>
        event.event_type === 'debug' && event.payload.kind === 'persistent_decision') ?? null);
    }).catch(() => { if (active) setLatestPersistentDecision(null); });
    void api.getTimeline(sessionId, { eventTypes: HISTORY_EVENT_TYPES, limit: HISTORY_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setHistory(normalizePersistentHistory(result.messages));
        setNextCursor(result.next_cursor);
        setHistoryState('ready');
      })
      .catch(() => { if (active) setHistoryState('error'); });
    return () => { active = false; };
  }, [serverUrl, sessionId, createApi, reload]);

  const usageByTerminalId = useMemo(() => {
    const chronological = persistentHistoryForTurnPairing(history).map((event) => ({
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

  const isLoading = generationState === 'loading' || historyState === 'loading';
  const displayEvents = useMemo(() => history.filter((event) =>
    (event.event_type === 'generation_started' && event.id !== latestGeneration?.id)
    || event.event_type === 'complete'), [history, latestGeneration]);
  const hasGenerationOrHistory = Boolean(latestGeneration) || displayEvents.length > 0;

  const loadMore = async () => {
    if (!nextCursor || loadingMore || historyState !== 'ready') return;
    setLoadingMore(true);
    try {
      const result = await createApi(serverUrl).getTimeline(sessionId, {
        before: nextCursor,
        eventTypes: HISTORY_EVENT_TYPES,
        limit: HISTORY_PAGE_SIZE,
      });
      setHistory((current) => normalizePersistentHistory([...current, ...result.messages]));
      setNextCursor(result.next_cursor);
    } catch {
      setHistoryState('error');
    } finally {
      setLoadingMore(false);
    }
  };

  const retry = () => setReload((value) => value + 1);
  const generationValue = latestGeneration
    ? typeof latestGeneration.payload.generation === 'number' ? String(latestGeneration.payload.generation) : '기록 있음'
    : '세대 기록 없음';

  return <SettingsSection id="persistent-session-monitoring" title="" flattened>
    <Group title="최근 기록">
      {isLoading ? <ActivityIndicator accessibilityLabel="기록 불러오는 중" color={t.colors.accent} /> : null}
      {!isLoading && generationState === 'ready' && hasGenerationOrHistory ? <ReadOnlyField label="현재 세대" value={generationValue} /> : null}
      {!isLoading && historyState === 'ready' && latestPersistentDecision ? <ReadOnlyField
        label="마지막 판단"
        value={[
          formatMonitoringTime(latestPersistentDecision.created_at),
          latestPersistentDecision.payload.action,
          latestPersistentDecision.payload.reason,
        ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')}
      /> : null}
      {!isLoading && (generationState === 'error' || historyState === 'error') ? <View style={styles.errorBlock}>
        <Text accessibilityRole="alert" style={styles.error}>조회 실패</Text>
        <Action label="다시 시도" onPress={retry} testID="persistent-session-monitoring-retry" />
      </View> : null}
      {!isLoading && generationState === 'ready' && historyState === 'ready' && displayEvents.length === 0 ? <Text testID="persistent-session-monitoring-empty" style={styles.body}>기록 없음</Text> : null}
      {!isLoading && historyState === 'ready' ? displayEvents.map((event) => {
        const time = new Date(event.created_at).toLocaleString('ko-KR', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const detail = event.event_type === 'complete'
          ? usageByTerminalId.get(String(event.id)) ?? '기록 없음'
          : typeof event.payload.generation === 'number' ? `세대 ${event.payload.generation}` : '세대 기록';
        return <View key={event.id} style={styles.historyRow}>
          <Text style={styles.timestamp}>{time}</Text>
          <Text style={styles.body}>{detail}</Text>
        </View>;
      }) : null}
      {!isLoading && historyState === 'ready' && nextCursor ? <Action label={loadingMore ? '불러오는 중…' : '더 보기'} disabled={loadingMore} onPress={() => void loadMore()} testID="persistent-session-monitoring-more" /> : null}
    </Group>
  </SettingsSection>;
}

export function persistentSessionQuotaRows(session: PersistentSessionResource, presets: ModelPresetAvailability[]) {
  const groups = new Map<string, {
    backend: string | null;
    roles: string[];
    headroom: number | null;
    resetsAt: string | null;
    observedAt: string | null;
    quotaLabel: string | null;
    unavailable: boolean;
  }>();
  const references = [
    { role: '현재', presetId: session.runtime.current_model.model_preset },
    { role: '기본', presetId: session.settings.default_model.model_preset },
    { role: '대체', presetId: session.settings.fallback_model?.model_preset ?? null },
  ];
  for (const reference of references) {
    if (!reference.presetId) continue;
    const preset = presets.find((item) => item.id === reference.presetId);
    const weekly = preset?.weekly_headroom;
    const backend = preset?.backend ?? null;
    const unavailable = !weekly || weekly.status === 'unavailable' || typeof weekly.headroom !== 'number';
    const headroom = unavailable ? null : weekly.headroom;
    const resetsAt = weekly?.resets_at ?? null;
    const observedAt = weekly?.observed_at ?? null;
    const quotaLabel = weekly?.quota_label ?? null;
    const providerKey = backend ?? `missing:${reference.presetId}`;
    const key = JSON.stringify([providerKey, unavailable, headroom, resetsAt, observedAt, quotaLabel]);
    const group = groups.get(key) ?? { backend, roles: [], headroom, resetsAt, observedAt, quotaLabel, unavailable };
    group.roles.push(reference.role);
    groups.set(key, group);
  }

  return [...groups].map(([key, group]) => {
    const provider = group.backend === 'claude' ? 'Claude' : group.backend === 'codex' ? 'Codex' : group.backend;
    const label = provider ? `${provider} · ${group.roles.join('·')}` : group.roles.join('·');
    if (group.unavailable || group.headroom === null) return { key, label, headroomLabel: null, metadata: null };

    const metadata = [
      group.resetsAt ? `초기화 ${formatMonitoringTime(group.resetsAt)}` : null,
      group.observedAt ? `관측 ${formatMonitoringTime(group.observedAt)}` : null,
    ].filter(Boolean).join(' · ');
    return {
      key,
      label,
      headroomLabel: `${group.quotaLabel ?? '7일'} 여유 ${PERCENT_FORMAT.format(group.headroom)}%`,
      metadata: metadata || null,
    };
  });
}

function formatMonitoringTime(value: string) {
  return new Date(value).toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function makeStyles(t: ReturnType<typeof useTokens>) {
  return StyleSheet.create({
    errorBlock: { gap: t.spacing.xs },
    error: { ...t.foundation.typography.body, color: t.colors.error },
    historyRow: { gap: t.spacing.xxs },
    timestamp: { ...t.foundation.typography.meta, color: t.colors.textMuted },
    body: { ...t.foundation.typography.body, color: t.colors.textPrimary },
  });
}
