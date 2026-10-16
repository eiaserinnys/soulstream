import type { UsageSummarySnapshot } from "@seosoyoung/soul-ui";

import { HttpResponseError } from "./http-response-error";

export async function fetchUsageSummary(
  request: typeof fetch = fetch,
): Promise<UsageSummarySnapshot> {
  const response = await request("/api/usage/summary", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpResponseError(
      `사용량 요약을 불러오지 못했습니다 (${response.status})`,
      response.status,
    );
  }
  return await response.json() as UsageSummarySnapshot;
}
