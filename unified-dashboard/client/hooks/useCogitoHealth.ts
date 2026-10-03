import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchCogitoBriefs,
  summarizeCogitoHealth,
  type CogitoHealthSummary,
} from "../lib/cogito-health";

export interface UseCogitoHealthResult {
  summary: CogitoHealthSummary | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCogitoHealth(request?: typeof fetch): UseCogitoHealthResult {
  const query = useQuery({
    queryKey: request ? ["cogito-health", "sample"] : ["cogito-health"],
    queryFn: () => fetchCogitoBriefs(request),
    staleTime: 30_000,
    refetchInterval: false,
  });

  const summary = useMemo(
    () => (query.data ? summarizeCogitoHealth(query.data) : null),
    [query.data],
  );

  return {
    summary,
    loading: query.isLoading,
    refreshing: query.isFetching && Boolean(query.data),
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
