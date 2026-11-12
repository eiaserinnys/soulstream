import { afterEach, describe, expect, it } from "vitest";

import type {
  UsageStatsAggregate,
  UsageStatsDayDetail,
  UsageStatsOverview,
  UsageStatsProvider,
  UsageStatsProviderRow,
} from "@soulstream/wire-schema/session-statistics";

import {
  createApp,
  parseOrchServerConfig,
  type SessionStatisticsRouteOptions,
} from "../src/index.js";
import {
  createTempModelCatalog,
  type TempModelCatalog,
} from "./helpers/model_catalog.js";

const AS_OF = "2026-10-20T01:02:03.000Z";
const BEARER = "statistics-model-label-token";

const config = parseOrchServerConfig({
  environment: "production",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: BEARER,
});

function aggregate(): UsageStatsAggregate {
  return {
    metrics: {
      input_total: 1,
      cache_read: 0,
      cache_write: 0,
      output_total: 0,
      reasoning_output: 0,
      total_tokens: 1,
      provider_total_tokens: 1,
      ordinary_input: 1,
      reference_cost_usd: null,
      reference_cost_breakdown: {
        cache_read: { known_cost_usd: null, is_partial: true },
        non_cache: { known_cost_usd: null, is_partial: true },
      },
    },
    coverage: {
      usage_complete_events: 0,
      usage_partial_events: 0,
      terminal_missing_usage: 0,
      ended_input_without_usage: 0,
      missing_usage_turns: 0,
      pending_inputs: 0,
      priced_events: 0,
      unpriced_events: 1,
      priced_total_tokens: null,
      unpriced_total_tokens: 1,
      unknown_total_token_events: 0,
      unattributed_missing_usage: false,
      token_partials: {
        total_tokens: false,
        provider_total_tokens: false,
        ordinary_input: false,
        cache_read: false,
      },
    },
    is_partial: true,
  };
}

function modelRow(
  provider: UsageStatsProvider,
  backend: string,
  model: string | null,
): UsageStatsProviderRow {
  return { ...aggregate(), provider, backend, model, attribution: "model" };
}

function providerRow(
  provider: UsageStatsProvider,
  backend: string,
): UsageStatsProviderRow {
  return { ...aggregate(), provider, backend, model: null, attribution: "provider" };
}

function providerRows(): UsageStatsProviderRow[] {
  return [
    modelRow("claude", "claude-code", "claude-opus-5-5"),
    modelRow("kimi", "kimi-for-coding", "kimi-for-coding/k3"),
    modelRow("unknown", "custom", "vendor/team:model:v2"),
    modelRow("unknown", "custom", null),
    providerRow("claude", "claude-code"),
  ];
}

function overview(): UsageStatsOverview {
  return {
    schema_version: 1,
    generated_at: AS_OF,
    as_of: AS_OF,
    range: {
      period: "week",
      since: "2026-10-19",
      until: "2026-10-26",
      effective_until: "2026-10-21",
      timezone: "Asia/Seoul",
      bucket: "day",
    },
    policies: {
      date_attribution: "recorded_terminal",
      project_attribution: "current_folder",
      price_version: "server-policy-version",
    },
    projection_status: { state: "ready", covered_since: "2026-10-01" },
    totals: aggregate(),
    by_model: providerRows(),
    by_project: [],
    series: [
      {
        bucket_start: "2026-10-19",
        provider: "claude",
        model: "claude-opus-5-5",
        label: "claude-opus-5-5",
        metrics: aggregate().metrics,
      },
      {
        bucket_start: "2026-10-19",
        provider: "claude",
        model: null,
        label: "Claude",
        metrics: aggregate().metrics,
      },
      {
        bucket_start: "2026-10-19",
        provider: "unknown",
        model: "vendor/team:model:v2",
        label: "원문 모델",
        metrics: aggregate().metrics,
      },
    ],
    options: {
      providers: [],
      models: [
        { provider: "claude", model: "claude-opus-5-5", backend: "claude", label: "claude-opus-5-5" },
        { provider: "kimi", model: "kimi-for-coding/k3", backend: "kimi-for-coding", label: "kimi-for-coding/k3" },
        { provider: "unknown", model: "vendor/team:model:v2", backend: "custom", label: "원문 모델" },
        { provider: "claude", model: null, backend: "claude-code", label: "Claude" },
      ],
      projects: [],
      project_roster: [],
      model_rosters: [],
    },
  };
}

function dayDetail(): UsageStatsDayDetail {
  return {
    schema_version: 1,
    date: "2026-10-19",
    generated_at: AS_OF,
    as_of: AS_OF,
    totals: aggregate(),
    by_model: providerRows(),
    by_project: [],
    input_material: {
      basis: "observed_input_material",
      unit: "approximate_tokens",
      estimate_method: "utf16_chars_div4_ceil_v1",
      method: "combined_visible",
      observed_approximate_tokens: null,
      parts: [],
      calibration: {
        status: "not_comparable",
        sample_count: 0,
        factor: null,
        reasons: [],
      },
      coverage: {
        complete_samples: 0,
        partial_samples: 0,
        manifest_only_samples: 0,
        missing_samples: 0,
      },
    },
    tool_calls: 0,
  };
}

function createHarness(catalog: TempModelCatalog["store"]) {
  const routeOptions = {
    service: {
      getOverview: async () => overview(),
      getDay: async () => dayDetail(),
    },
    accessProvider: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }),
    },
    folderProvider: { listFolders: async () => [] },
    now: () => new Date(AS_OF),
    modelCatalog: catalog,
  } as unknown as SessionStatisticsRouteOptions;
  return createApp({
    config,
    productionAuth: {
      resolveTokenAccess: async () => ({ ok: true }),
    },
    sessionStatisticsRoutes: routeOptions,
  });
}

describe("session statistics model labels", () => {
  let catalog: TempModelCatalog | undefined;

  afterEach(() => {
    catalog?.cleanup();
    catalog = undefined;
  });

  it("decorates both APIs from the catalogue and follows display-name edits", async () => {
    catalog = createTempModelCatalog();
    const app = createHarness(catalog.store);
    const headers = { authorization: `Bearer ${BEARER}` };
    try {
      const overviewResponse = await app.inject({
        method: "GET",
        url: "/api/session-statistics?period=week&anchor=2026-10-19",
        headers,
      });
      expect(overviewResponse.statusCode).toBe(200);
      const body = overviewResponse.json() as UsageStatsOverview;
      const rows = new Map(
        body.by_model.map((row) => [`${row.attribution}:${row.provider}:${row.model}`, row]),
      );
      expect(rows.get("model:claude:claude-opus-5-5")?.model_label).toBe("Claude Opus 5.5");
      expect(rows.get("model:kimi:kimi-for-coding/k3")?.model_label).toBe("Kimi for Coding K3");
      expect(rows.get("model:unknown:vendor/team:model:v2")?.model_label).toBeNull();
      expect(rows.get("model:unknown:null")?.model_label).toBeNull();
      expect(rows.get("provider:claude:null")?.model_label).toBeNull();
      expect(body.options.models.find((model) => model.model === "claude-opus-5-5")?.label)
        .toBe("Claude Opus 5.5");
      expect(body.options.models.find((model) => model.model === "kimi-for-coding/k3")?.label)
        .toBe("Kimi for Coding K3");
      expect(body.options.models.find((model) => model.model === "vendor/team:model:v2")?.label)
        .toBe("vendor/team:model:v2");
      expect(body.options.models.find((model) => model.model === null)?.label).toBe("Claude");
      expect(body.series.find((point) => point.model === "claude-opus-5-5")?.label)
        .toBe("Claude Opus 5.5");
      expect(body.series.find((point) => point.model === "vendor/team:model:v2")?.label)
        .toBe("vendor/team:model:v2");
      expect(body.series.find((point) => point.model === null)?.label).toBe("Claude");

      const dayResponse = await app.inject({
        method: "GET",
        url: "/api/session-statistics/days/2026-10-19?period=week&anchor=2026-10-19",
        headers,
      });
      expect(dayResponse.statusCode).toBe(200);
      const day = dayResponse.json() as UsageStatsDayDetail;
      expect(day.by_model.find((row) => row.model === "claude-opus-5-5")?.model_label)
        .toBe("Claude Opus 5.5");
      expect(day.by_model.find((row) => row.model === "kimi-for-coding/k3")?.model_label)
        .toBe("Kimi for Coding K3");

      catalog.edit((text) => text.replace(
        "display_name: Claude Opus 5.5",
        "display_name: Claude Opus 5.6 Beta",
      ));

      const editedResponse = await app.inject({
        method: "GET",
        url: "/api/session-statistics?period=week&anchor=2026-10-19",
        headers,
      });
      expect(editedResponse.statusCode).toBe(200);
      const edited = editedResponse.json() as UsageStatsOverview;
      expect(edited.by_model.find((row) => row.model === "claude-opus-5-5")?.model_label)
        .toBe("Claude Opus 5.6 Beta");
      expect(edited.options.models.find((model) => model.model === "claude-opus-5-5")?.label)
        .toBe("Claude Opus 5.6 Beta");
    } finally {
      await app.close();
    }
  });
});
