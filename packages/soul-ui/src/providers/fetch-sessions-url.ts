import type { FetchSessionsOptions } from "./types";

export function buildFetchSessionsUrl(
  basePath: string,
  options?: FetchSessionsOptions,
): string {
  const params = new URLSearchParams();
  if (options?.sessionType) params.set("session_type", options.sessionType);
  if (options?.offset != null && options.offset > 0) {
    params.set("offset", String(options.offset));
  }
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.folderId) params.set("folder_id", options.folderId);
  if (options?.feedOnly) params.set("feed_only", "true");

  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
