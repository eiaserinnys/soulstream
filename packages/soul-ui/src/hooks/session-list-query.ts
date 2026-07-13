import type { FetchSessionsOptions } from "../providers/types";
import type { DashboardState } from "../stores/dashboard-store-types";

export type SessionListQueryKey = readonly [
  prefix: "sessions",
  sessionTypeFilter: DashboardState["sessionTypeFilter"],
  viewMode: DashboardState["viewMode"] | "all" | "ids",
  folderId: string | null,
  sessionIds?: readonly string[],
];

export function buildFetchSessionsOptions(
  queryKey: SessionListQueryKey,
  pageParam: number,
  pageSize: number,
): FetchSessionsOptions {
  const [, sessionTypeFilter, viewMode, folderId, sessionIds] = queryKey;
  return {
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(sessionTypeFilter === "all" ? {} : { sessionType: sessionTypeFilter }),
    offset: pageParam,
    limit: pageSize,
    ...(viewMode === "feed" ? { feedOnly: true } : {}),
    ...(viewMode === "folder" && folderId !== null ? { folderId } : {}),
  };
}
