import { useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import { useSettingsStore } from '../../../store/settingsStore';
import type {
  UsageStatsDayDetail,
  UsageStatsOverview,
  UsageStatsQuery,
} from '../../../../../packages/wire-schema/src/session_statistics';

export type UsageStatsLoadState = 'loading' | 'ready' | 'error' | 'forbidden';

export function useUsageStats(query: UsageStatsQuery, date: string | null) {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => createApiClient(serverUrl), [serverUrl]);
  const [reload, setReload] = useState(0);
  const projectIds = query.project_ids ?? [];
  const projectIdsKey = JSON.stringify(projectIds);
  const requestQuery = useMemo<UsageStatsQuery>(() => ({
    period: query.period,
    anchor: query.anchor,
    provider: query.provider,
    model: query.model,
    project_ids: projectIds,
  }), [query.period, query.anchor, query.provider, query.model, projectIdsKey]);
  const queryKey = JSON.stringify([
    serverUrl,
    query.period,
    query.anchor,
    query.provider ?? null,
    query.model ?? null,
    projectIds,
  ]);
  const overviewKey = JSON.stringify([queryKey, reload]);
  const dateKey = date === null ? null : JSON.stringify([queryKey, date, reload]);
  const currentOverviewKey = useRef(overviewKey);
  currentOverviewKey.current = overviewKey;
  const currentDateKey = useRef(dateKey);
  currentDateKey.current = dateKey;
  const [overviewResult, setOverviewResult] = useState<{
    key: string;
    state: UsageStatsLoadState;
    value?: UsageStatsOverview;
  } | null>(null);
  const [detailResult, setDetailResult] = useState<{
    key: string;
    state: UsageStatsLoadState;
    value?: UsageStatsDayDetail;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setOverviewResult({ key: overviewKey, state: 'loading' });
    void api.getSessionStatistics(requestQuery).then(value => {
      if (!active || currentOverviewKey.current !== overviewKey) return;
      setOverviewResult({ key: overviewKey, state: 'ready', value });
    }).catch(error => {
      if (!active || currentOverviewKey.current !== overviewKey) return;
      setOverviewResult({
        key: overviewKey,
        state: error instanceof ApiHttpError && error.status === 403 ? 'forbidden' : 'error',
      });
    });
    return () => { active = false; };
  }, [api, requestQuery, overviewKey]);

  const currentOverview = overviewResult?.key === overviewKey && overviewResult.state === 'ready'
    ? overviewResult.value ?? null
    : null;
  const overviewReady = currentOverview !== null;
  const rangeSince = currentOverview?.range.since ?? null;
  const rangeEffectiveUntil = currentOverview?.range.effective_until ?? null;
  const overviewState = overviewResult?.key === overviewKey ? overviewResult.state : 'loading';
  const dateInRange = Boolean(
    date !== null
    && query.period !== 'all'
    && rangeSince !== null
    && rangeEffectiveUntil !== null
    && rangeSince <= date
    && date < rangeEffectiveUntil,
  );

  useEffect(() => {
    let active = true;
    if (!date || !dateKey || !overviewReady || !dateInRange) return () => { active = false; };
    setDetailResult({ key: dateKey, state: 'loading' });
    void api.getSessionStatisticsDay(date, requestQuery).then(value => {
      if (!active || currentDateKey.current !== dateKey) return;
      setDetailResult({ key: dateKey, state: 'ready', value });
    }).catch(error => {
      if (!active || currentDateKey.current !== dateKey) return;
      const forbidden = error instanceof ApiHttpError && error.status === 403;
      if (forbidden) setOverviewResult({ key: overviewKey, state: 'forbidden' });
      setDetailResult({
        key: dateKey,
        state: forbidden ? 'forbidden' : 'error',
      });
    });
    return () => { active = false; };
  }, [api, requestQuery, overviewKey, queryKey, date, dateKey, dateInRange, overviewReady, rangeSince, rangeEffectiveUntil, reload]);

  const detail = dateKey !== null && detailResult?.key === dateKey && detailResult.state === 'ready'
    ? detailResult.value ?? null
    : null;
  const detailState = date === null ? 'ready' : detailResult?.key === dateKey
    ? detailResult.state
    : 'loading';
  const state = overviewState === 'ready' ? detailState : overviewState;

  return {
    overview: currentOverview,
    detail,
    state,
    retry: () => setReload(value => value + 1),
  };
}
