import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyUsageSummaryOutcome,
  selectUsageSummaryNode,
  usageSummaryLoadState,
  USAGE_SUMMARY_REFRESH_INTERVAL_MS,
  type UsageSummaryState,
} from '../../../packages/soul-ui/src/lib/usage-summary';

import type { ApiClient } from '../api/client';
import type { AppUsageSummaryNode, AppUsageSummarySnapshot } from '../api/usageEndpoints';
import { usageSummaryGaugesForApp, type AppUsageSummaryGauge } from '../lib/usage-summary-pool';
import { ApiHttpError } from '../api/clientCore';
import { useAuthScopeGeneration } from '../lib/auth-scope';

export type UsageSummaryLoadState = 'idle' | 'ready' | 'serverPending' | 'connectionError';

export type UseUsageSummaryOptions = {
  enabled: boolean;
  nodeId: string | null;
  selectedNodeId?: string | null;
  api: Pick<ApiClient, 'getUsageSummary'> | null;
};

export type UseUsageSummaryResult = {
  summary: AppUsageSummarySnapshot | null;
  node: AppUsageSummaryNode | null;
  gauges: AppUsageSummaryGauge[];
  loading: boolean;
  loadState: UsageSummaryLoadState;
  evaluatedAtMs: number;
  retry: () => void;
};

const EMPTY_STATE: UsageSummaryState = {
  scopeKey: '',
  lastSuccess: null,
  hideSummary: false,
  outcome: 'idle',
  loading: false,
  evaluatedAtMs: 0,
};

function emptyState(scopeKey: string): UsageSummaryState {
  return { ...EMPTY_STATE, scopeKey };
}

function statusOf(caught: unknown): number | null {
  return caught instanceof ApiHttpError ? caught.status : null;
}

export function useUsageSummary({
  enabled,
  nodeId,
  selectedNodeId = null,
  api,
}: UseUsageSummaryOptions): UseUsageSummaryResult {
  const scopeKey = useAuthScopeGeneration();
  const [state, setState] = useState<UsageSummaryState>(EMPTY_STATE);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !api) {
      setState((current) => {
        const scoped = current.scopeKey === scopeKey ? current : emptyState(scopeKey);
        return scoped.loading ? { ...scoped, loading: false } : scoped;
      });
      return;
    }

    let active = true;
    setState((current) => {
      const scoped = current.scopeKey === scopeKey ? current : emptyState(scopeKey);
      return { ...scoped, loading: true, evaluatedAtMs: Date.now() };
    });

    const load = async () => {
      try {
        const summary = await api.getUsageSummary();
        if (!active) return;
        setState((current) => ({
          ...applyUsageSummaryOutcome(current, { scopeKey, outcome: 'success', status: null, summary }),
          evaluatedAtMs: Date.now(),
        }));
      } catch (caught) {
        if (!active) return;
        const status = statusOf(caught);
        setState((current) => ({
          ...applyUsageSummaryOutcome(current, { scopeKey, outcome: 'error', status, summary: null }),
          evaluatedAtMs: Date.now(),
        }));
      }
    };

    void load();
    const interval = globalThis.setInterval(() => { void load(); }, USAGE_SUMMARY_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      globalThis.clearInterval(interval);
    };
  }, [api, enabled, reload, scopeKey]);

  const scopedState = state.scopeKey === scopeKey ? state : emptyState(scopeKey);
  const summary = scopedState.hideSummary ? null : scopedState.lastSuccess;
  const node = selectUsageSummaryNode(summary, nodeId, selectedNodeId) as AppUsageSummaryNode | null;
  const gauges = useMemo(() => usageSummaryGaugesForApp(node), [node]);
  const loadState = usageSummaryLoadState(scopedState.outcome, node !== null);

  return {
    summary,
    node,
    gauges,
    loading: scopedState.loading,
    loadState,
    evaluatedAtMs: scopedState.evaluatedAtMs,
    retry,
  };
}
