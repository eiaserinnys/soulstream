import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../../../api/client';
import { ApiHttpError } from '../../../api/clientCore';
import { useSettingsStore } from '../../../store/settingsStore';
import type { UsageStatsDayDetail, UsageStatsOverview, UsageStatsQuery } from '../../../../../packages/soul-ui/src/lib/usage-stats-fixture-data';

export type UsageStatsLoadState = 'loading' | 'ready' | 'error' | 'forbidden';

// Match the app's request lifecycle: an obsolete effect cannot publish its result.
export function useUsageStats(query: UsageStatsQuery, date: string | null) {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => createApiClient(serverUrl), [serverUrl]);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<UsageStatsLoadState>('loading');
  const [overview, setOverview] = useState<UsageStatsOverview | null>(null);
  const [detail, setDetail] = useState<UsageStatsDayDetail | null>(null);
  const [baseOverview, setBaseOverview] = useState<UsageStatsOverview | null>(null);
  const [allOverview, setAllOverview] = useState<UsageStatsOverview | null>(null);
  const [modelOverviews, setModelOverviews] = useState<UsageStatsOverview[]>([]);
  const [optionsState, setOptionsState] = useState<UsageStatsLoadState>('loading');

  useEffect(() => {
    let active = true;
    setOptionsState('loading');
    const base = { period: query.period, anchor: query.anchor };
    void Promise.all([
      api.getSessionStatistics(base),
      api.getSessionStatistics({ period: 'all', anchor: query.anchor }),
      ...(['claude', 'codex', 'antigravity', 'deepseek', 'kimi'] as const)
        .map(provider => api.getSessionStatistics({ ...base, provider })),
    ]).then(([unfiltered, all, ...models]) => {
      if (!active) return;
      setBaseOverview(unfiltered);
      setAllOverview(all);
      setModelOverviews(models);
      setOptionsState('ready');
    }).catch(error => {
      if (active) setOptionsState(error instanceof ApiHttpError && error.status === 403 ? 'forbidden' : 'error');
    });
    return () => { active = false; };
  }, [api, query.period, query.anchor, reload]);

  useEffect(() => {
    let active = true;
    setState('loading');
    setDetail(null);
    void Promise.all([
      api.getSessionStatistics(query),
      date ? api.getSessionStatisticsDay(date, query) : Promise.resolve(null),
    ]).then(([nextOverview, nextDetail]) => {
      if (!active) return;
      setOverview(nextOverview);
      setDetail(nextDetail);
      setState('ready');
    }).catch(error => {
      if (active) setState(error instanceof ApiHttpError && error.status === 403 ? 'forbidden' : 'error');
    });
    return () => { active = false; };
  }, [api, query, date, reload]);

  return {
    overview, detail, baseOverview, allOverview, modelOverviews,
    state: optionsState === 'ready' ? state : optionsState,
    retry: () => setReload(value => value + 1),
  };
}
