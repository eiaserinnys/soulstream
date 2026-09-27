import type { FetchSessionsOptions } from "../providers/types";
import type { DashboardState } from "../stores/dashboard-store-types";

export type SessionListQueryKey = readonly [
  prefix: "sessions",
  viewMode: DashboardState["viewMode"] | "all" | "ids",
  folderId: string | null,
  sessionIds?: readonly string[],
];

export function buildFetchSessionsOptions(
  queryKey: SessionListQueryKey,
  pageParam: number,
  pageSize: number,
): FetchSessionsOptions {
  const [, viewMode, folderId, sessionIds] = queryKey;
  return {
    ...(sessionIds === undefined ? {} : { sessionIds }),
    offset: pageParam,
    limit: pageSize,
    ...(viewMode === "feed" ? { feedOnly: true } : {}),
    ...(viewMode === "folder" && folderId !== null ? { folderId } : {}),
  };
}
