import { useCallback, useEffect, useMemo, useState } from "react";
import {
  selectUsageSummaryNode,
  weeklyUsageGauges,
  USAGE_SUMMARY_REFRESH_INTERVAL_MS,
  type UsageSummaryGauge,
  type UsageSummaryNode,
  type UsageSummarySnapshot,
} from "@seosoyoung/soul-ui";

import { HttpResponseError } from "../lib/http-response-error";
import { fetchUsageSummary } from "../lib/usage-summary";

export type UsageSummaryLoadState = "idle" | "ready" | "serverPending" | "connectionError";

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

type RequestOutcome = "idle" | "success" | "serverPending" | "connectionError";
type ScopedSummaryState = {
  scopeKey: string;
  lastSuccess: UsageSummarySnapshot | null;
  hideSummary: boolean;
  outcome: RequestOutcome;
  loading: boolean;
  evaluatedAtMs: number;
};

const EMPTY_STATE: ScopedSummaryState = {
  scopeKey: "",
  lastSuccess: null,
  hideSummary: false,
  outcome: "idle",
  loading: false,
  evaluatedAtMs: 0,
};

function emptyState(scopeKey: string): ScopedSummaryState {
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
  const [state, setState] = useState<ScopedSummaryState>(EMPTY_STATE);
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
        setState((current) => {
          const scoped = current.scopeKey === scopeKey ? current : emptyState(scopeKey);
          return {
            ...scoped,
            lastSuccess: summary,
            hideSummary: false,
            outcome: "success",
            loading: false,
            evaluatedAtMs: Date.now(),
          };
        });
      } catch (caught) {
        if (!active) return;
        const status = statusOf(caught);
        setState((current) => {
          const scoped = current.scopeKey === scopeKey ? current : emptyState(scopeKey);
          if (status === 401) return { ...emptyState(scopeKey), evaluatedAtMs: Date.now() };
          if (status === 404) {
            return {
              ...scoped,
              hideSummary: true,
              outcome: "serverPending",
              loading: false,
              evaluatedAtMs: Date.now(),
            };
          }
          return {
            ...scoped,
            hideSummary: false,
            outcome: "connectionError",
            loading: false,
            evaluatedAtMs: Date.now(),
          };
        });
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
  let loadState: UsageSummaryLoadState;
  if (scopedState.outcome === "connectionError") loadState = "connectionError";
  else if (scopedState.outcome === "serverPending") loadState = "serverPending";
  else if (scopedState.outcome === "success") loadState = node ? "ready" : "serverPending";
  else loadState = "idle";

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
