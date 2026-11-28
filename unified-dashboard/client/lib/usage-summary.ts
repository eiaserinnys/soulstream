import type { UsageSummarySnapshot } from "@seosoyoung/soul-ui";

import { adminTranslation, type AdminTranslate } from "../components/config/admin-translation";
import { HttpResponseError } from "./http-response-error";

export async function fetchUsageSummary(
  request: typeof fetch = fetch,
  t?: AdminTranslate,
): Promise<UsageSummarySnapshot> {
  const response = await request("/api/usage/summary", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpResponseError(
      (t ?? adminTranslation())("admin.stats.summaryLoadError", { status: response.status }),
      response.status,
    );
  }
  return await response.json() as UsageSummarySnapshot;
}

export async function refreshUsageSummary(
  request: typeof fetch = fetch,
  t?: AdminTranslate,
): Promise<UsageSummarySnapshot> {
  const response = await request("/api/usage/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpResponseError(
      (t ?? adminTranslation())("admin.stats.summaryRefreshError", { status: response.status }),
      response.status,
    );
  }
  return await response.json() as UsageSummarySnapshot;
}
