import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyUsageSummaryOutcome,
  selectUsageSummaryNode,
  usageSummaryLoadState,
  weeklyUsageGauges,
  USAGE_SUMMARY_REFRESH_INTERVAL_MS,
  type UsageSummaryGauge,
  type UsageSummaryLoadState,
  type UsageSummaryNode,
  type UsageSummarySnapshot,
  type UsageSummaryState,
} from "@seosoyoung/soul-ui";

import { HttpResponseError } from "../lib/http-response-error";
import { fetchUsageSummary } from "../lib/usage-summary";

export type UseUsageSummaryOptions = {
  enabled: boolean;
  nodeId: string | null;
  selectedNodeId?: string | null;
  scopeKey: string;
  request?: typeof fetch;
};

export type UseUsageSummaryResult = {
  summary: UsageSummarySnapshot | null;
  node: UsageSummaryNode | null;
  gauges: UsageSummaryGauge[];
  loading: boolean;
  loadState: UsageSummaryLoadState;
  evaluatedAtMs: number;
  retry: () => void;
};

const EMPTY_STATE: UsageSummaryState = {
  scopeKey: "",
  lastSuccess: null,
  hideSummary: false,
  outcome: "idle",
  loading: false,
  evaluatedAtMs: 0,
};

function emptyState(scopeKey: string): UsageSummaryState {
  return { ...EMPTY_STATE, scopeKey };
}

function statusOf(caught: unknown): number | null {
  return caught instanceof HttpResponseError ? caught.status : null;
}

export function useUsageSummary({
  enabled,
  nodeId,
  selectedNodeId = null,
  scopeKey,
  request = globalThis.fetch,
}: UseUsageSummaryOptions): UseUsageSummaryResult {
  const [state, setState] = useState<UsageSummaryState>(EMPTY_STATE);
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
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
        const summary = await fetchUsageSummary(request);
        if (!active) return;
        setState((current) => ({
          ...applyUsageSummaryOutcome(current, { scopeKey, outcome: "success", status: null, summary }),
          evaluatedAtMs: Date.now(),
        }));
      } catch (caught) {
        if (!active) return;
        const status = statusOf(caught);
        setState((current) => ({
          ...applyUsageSummaryOutcome(current, { scopeKey, outcome: "error", status, summary: null }),
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
  }, [enabled, reload, request, scopeKey]);

  const scopedState = state.scopeKey === scopeKey ? state : emptyState(scopeKey);
  const summary = scopedState.hideSummary ? null : scopedState.lastSuccess;
  const node = selectUsageSummaryNode(summary, nodeId, selectedNodeId);
  const gauges = useMemo(() => weeklyUsageGauges(node), [node]);
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
