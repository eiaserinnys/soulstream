// 확인용 시안: 실제 ConfigModal과 통계 컴포넌트를 공개 합성 데이터로 연다.
import { mockApi, mockupParams } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import {
  buildEmptyUsageStatsOverview,
  buildUsageStatsDayDetail,
  buildUsageStatsOverview,
  type UsageStatsPeriod,
  type UsageStatsProvider,
} from "@seosoyoung/soul-ui";
import { useState } from "react";
import { ConfigModal, type ConfigModalApi } from "../../client/components/ConfigModal";

const state = mockupParams.get("state") ?? "normal";

function queryFor(url: URL) {
  const period = (url.searchParams.get("period") ?? "week") as UsageStatsPeriod;
  const provider = (url.searchParams.get("provider") ?? null) as UsageStatsProvider | null;
  const project = url.searchParams.get("project_ids");
  return {
    period,
    anchor: url.searchParams.get("anchor") ?? "2026-10-18",
    provider,
    project_ids: project ? [project] : undefined,
  };
}

mockApi({
  "GET /api/config/settings": { categories: [] },
  "GET /api/session-statistics": ({ url }: { url: URL; method: string; body: unknown }) => {
    const query = queryFor(url);
    if (state === "empty") return buildEmptyUsageStatsOverview(query);
    const overview = buildUsageStatsOverview(query);
    if (state === "backfilling") overview.projection_status = { state: "backfilling", covered_since: "2026-09-10" };
    return overview;
  },
  ...(() => {
    const routes: Record<string, (context: { url: URL }) => unknown> = {};
    const start = new Date("2026-09-01T00:00:00Z");
    const until = new Date("2026-11-01T00:00:00Z");
    while (start < until) {
      const date = start.toISOString().slice(0, 10);
      routes[`GET /api/session-statistics/days/${date}`] = ({ url }) => {
        const query = queryFor(url);
        if (state === "empty") {
          const detail = buildUsageStatsDayDetail(date, query);
          const empty = buildEmptyUsageStatsOverview({ period: "week", anchor: date, provider: query.provider, project_ids: query.project_ids });
          detail.totals = empty.totals;
          detail.by_model = [];
          detail.by_project = [];
          detail.input_material = {
            basis: "observed_input_material",
            unit: "chars_utf16",
            method: "combined_visible",
            observed_chars: null,
            parts: [],
            coverage: { complete_samples: 0, partial_samples: 0, manifest_only_samples: 0, missing_samples: 1 },
          };
          detail.tool_calls = 0;
          return detail;
        }
        return buildUsageStatsDayDetail(date, query);
      };
      start.setUTCDate(start.getUTCDate() + 1);
    }
    return routes;
  })(),
});

const mockRequest: typeof fetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (requestUrl.pathname.startsWith("/api/session-statistics")) {
    if (state === "forbidden") return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    if (state === "error") return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    if (state === "loading") await new Promise(resolve => window.setTimeout(resolve, 2400));
  }
  return window.fetch(input, init);
};

const mockConfigApi = { request: mockRequest } as ConfigModalApi;

function UsageStatsMockup() {
  const [open, setOpen] = useState(true);
  return <>
    <span className="usage-stats-mockup-label">예시 숫자</span>
    <ConfigModal initialTab="usage_stats" open={open} onOpenChange={setOpen} api={mockConfigApi} />
  </>;
}

mountMockup(<UsageStatsMockup />);
