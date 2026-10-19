import { useEffect, useMemo, useRef, useState } from "react";
import { usageStatsFilterKey } from "@seosoyoung/soul-ui";
import type {
  UsageStatsDayDetail,
  UsageStatsOverview,
  UsageStatsPeriod,
  UsageStatsProvider,
} from "@seosoyoung/soul-ui";

export type UsageStatsFilter =
  | { kind: "all"; id: string; label: string; provider: null; model: null }
  | { kind: "provider"; id: string; label: string; provider: UsageStatsProvider; model: null }
  | { kind: "model"; id: string; label: string; provider: UsageStatsProvider; model: string };

export type UsageStatsLoadState = "loading" | "ready" | "error" | "forbidden";

export const ALL_USAGE_STATS_FILTER: UsageStatsFilter = {
  kind: "all",
  id: usageStatsFilterKey("all", null, null),
  label: "모든 모델",
  provider: null,
  model: null,
};

interface ResourceState<T> {
  key: string;
  state: UsageStatsLoadState | "idle";
  data: T | null;
}

function makeQuery(
  period: UsageStatsPeriod,
  anchor: string,
  filter: UsageStatsFilter,
  projectId: string | null,
): string {
  const params = new URLSearchParams({ period, anchor, timezone: "Asia/Seoul" });
  if (filter.provider) params.set("provider", filter.provider);
  if (filter.kind === "model") params.set("model", filter.model);
  if (projectId) params.set("project_ids", projectId);
  return params.toString();
}

async function readJson<T>(request: typeof fetch, url: string): Promise<T> {
  const response = await request(url, { credentials: "same-origin" });
  if (response.status === 403) throw Object.assign(new Error("forbidden"), { status: 403 });
  if (!response.ok) throw Object.assign(new Error("request failed"), { status: response.status });
  return response.json() as Promise<T>;
}

function errorState(error: unknown): "error" | "forbidden" {
  return typeof error === "object" && error !== null && "status" in error && error.status === 403
    ? "forbidden"
    : "error";
}

export function useUsageStats({
  request,
  period,
  anchor,
  filter,
  projectId,
  selectedDate,
}: {
  request: typeof fetch;
  period: UsageStatsPeriod;
  anchor: string;
  filter: UsageStatsFilter;
  projectId: string | null;
  selectedDate: string | null;
}) {
  const [retryCount, setRetryCount] = useState(0);
  const filterKey = usageStatsFilterKey(filter.kind, filter.provider, filter.model);
  const queryKey = JSON.stringify([period, anchor, filterKey, projectId]);
  const query = makeQuery(period, anchor, filter, projectId);
  const [overviewResult, setOverviewResult] = useState<ResourceState<UsageStatsOverview>>({
    key: "",
    state: "loading",
    data: null,
  });
  const [detailResult, setDetailResult] = useState<ResourceState<UsageStatsDayDetail> & { date: string | null }>({
    key: "",
    date: null,
    state: "idle",
    data: null,
  });
  const currentRange = useRef<{ key: string; since: string; effectiveUntil: string } | null>(null);

  useEffect(() => {
    let active = true;
    setOverviewResult(current => ({
      key: queryKey,
      state: "loading",
      data: current.key === queryKey ? current.data : null,
    }));
    void readJson<UsageStatsOverview>(request, `/api/session-statistics?${query}`)
      .then(data => {
        if (!active) return;
        currentRange.current = { key: queryKey, since: data.range.since, effectiveUntil: data.range.effective_until };
        setOverviewResult({ key: queryKey, state: "ready", data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const state = errorState(error);
        if (state === "forbidden" && currentRange.current?.key === queryKey) currentRange.current = null;
        setOverviewResult({ key: queryKey, state, data: null });
      });
    return () => { active = false; };
  }, [request, query, queryKey, retryCount]);

  const overviewMatches = overviewResult.key === queryKey;
  const overviewState: UsageStatsLoadState = overviewMatches ? overviewResult.state as UsageStatsLoadState : "loading";
  const overview = overviewMatches && overviewState !== "error" && overviewState !== "forbidden"
    ? overviewResult.data
    : null;
  const overviewLoading = overviewState === "loading";
  useEffect(() => {
    const range = currentRange.current?.key === queryKey
      ? { since: currentRange.current.since, effective_until: currentRange.current.effectiveUntil }
      : null;
    if (!selectedDate || period === "all" || !range) {
      setDetailResult({ key: queryKey, date: selectedDate, state: "idle", data: null });
      return;
    }
    if (selectedDate < range.since || selectedDate >= range.effective_until) {
      setDetailResult({ key: queryKey, date: selectedDate, state: "idle", data: null });
      return;
    }

    let active = true;
    setDetailResult({ key: queryKey, date: selectedDate, state: "loading", data: null });
    void readJson<UsageStatsDayDetail>(request, `/api/session-statistics/days/${selectedDate}?${query}`)
      .then(data => {
        if (!active) return;
        setDetailResult({ key: queryKey, date: selectedDate, state: "ready", data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const state = errorState(error);
        if (state === "forbidden") {
          setOverviewResult(current => current.key === queryKey
            ? { key: queryKey, state: "forbidden", data: null }
            : current);
        }
        setDetailResult({ key: queryKey, date: selectedDate, state, data: null });
      });
    return () => { active = false; };
  }, [request, query, queryKey, selectedDate, period, retryCount]);

  const detailMatches = detailResult.key === queryKey && detailResult.date === selectedDate;
  const detailState = detailMatches ? detailResult.state : selectedDate ? "loading" : "idle";
  const detail = detailMatches && detailState === "ready" ? detailResult.data : null;
  const detailLoading = Boolean(selectedDate) && overviewState === "ready" && detailState === "loading";
  const state: UsageStatsLoadState = overviewState !== "ready"
    ? overviewState
    : selectedDate && (detailState === "error" || detailState === "forbidden")
      ? detailState
      : "ready";

  return useMemo(() => ({
    overview,
    detail,
    state,
    overviewLoading,
    detailLoading,
    retry: () => setRetryCount(current => current + 1),
  }), [overview, detail, state, overviewLoading, detailLoading]);
}
