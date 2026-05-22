import type { FetchSessionsOptions } from "../providers/types";
import type { DashboardState } from "../stores/dashboard-store-types";

export type SessionListQueryKey = readonly [
  "sessions",
  DashboardState["sessionTypeFilter"],
  DashboardState["viewMode"],
  string | null,
];

export function buildFetchSessionsOptions(
  queryKey: SessionListQueryKey,
  pageParam: number,
  pageSize: number,
): FetchSessionsOptions {
  const [, sessionTypeFilter, viewMode, folderId] = queryKey;
  return {
    ...(sessionTypeFilter === "all" ? {} : { sessionType: sessionTypeFilter }),
    offset: pageParam,
    limit: pageSize,
    ...(viewMode === "feed" ? { feedOnly: true } : {}),
    ...(viewMode === "folder" && folderId !== null ? { folderId } : {}),
  };
}
