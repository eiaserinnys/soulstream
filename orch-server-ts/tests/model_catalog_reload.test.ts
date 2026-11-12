import { afterEach, describe, expect, it } from "vitest";

import type { ModelCatalogConfig } from "@soulstream/model-catalog";

import {
  sessionStatisticsSourceKey,
} from "../src/usage/session_statistics_aggregate.js";
import { normalizeSessionStatisticsEvent } from "../src/usage/session_statistics_normalizer.js";
import { buildOverview } from "../src/usage/session_statistics_service.js";
import {
  fact,
  read,
  usageRow,
} from "./fixtures/session_statistics_aggregation.fixtures.js";
import {
  createTempModelCatalog,
  type TempModelCatalog,
} from "./helpers/model_catalog.js";

const OLD_PRICE_VERSION = "api-list-usd-2026-10-19-v1";
const NEW_PRICE_VERSION = "api-list-usd-2026-11-12-v2";

const OPUS_RATES = "rates: {input: 4, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8, output: 20}";
const OPUS_RATES_DOUBLED = "rates: {input: 8, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8, output: 20}";

function completeEvent(eventId: number) {
  return {
    sessionId: "catalog-reload",
    eventId,
    eventType: "complete",
    createdAt: "2026-10-20T00:00:00.000Z",
    payload: {
      type: "complete",
      model: "claude-opus-5-5",
      output_command_id: `catalog-reload-${eventId}`,
      usage_snapshot: {
        schema_version: 1,
        backend: "claude",
        provider: "claude",
        preset_id: null,
        requested_model: "claude-opus-5-5",
        provider_attribution: "configured_alias",
      },
      usage: {
        input_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

function usageFact(
  event: ReturnType<typeof completeEvent>,
  catalog: ModelCatalogConfig,
) {
  const factDraft = normalizeSessionStatisticsEvent(event, catalog).facts.find(
    (entry) => entry.fact_kind === "usage" && entry.representation !== "diagnostic",
  );
  if (factDraft === undefined) throw new Error("usage fact was not produced");
  return factDraft;
}

describe("model catalog reload", () => {
  let catalog: TempModelCatalog | undefined;

  afterEach(() => {
    catalog?.cleanup();
    catalog = undefined;
  });

  it("prices the next ingested fact from changed rates and keeps stored totals", () => {
    catalog = createTempModelCatalog();

    const before = usageFact(completeEvent(1), catalog.store.snapshot());
    expect(before.known_cost_usd).toBeCloseTo(4, 10);
    expect(before.pricing_version).toBe(OLD_PRICE_VERSION);

    catalog.edit((text) => text
      .replace(`price_version: ${OLD_PRICE_VERSION}`, `price_version: ${NEW_PRICE_VERSION}`)
      .replace(OPUS_RATES, OPUS_RATES_DOUBLED));

    const after = usageFact(completeEvent(2), catalog.store.snapshot());
    expect(after.known_cost_usd).toBeCloseTo(8, 10);
    expect(after.pricing_version).toBe(NEW_PRICE_VERSION);

    // The stored fact keeps its own version and total. A newer catalogue does not re-price it.
    const stored = usageRow({
      fact: fact({
        provider: "claude",
        model: "claude-opus-5-5",
        input_total: 1_000_000,
        output_total: 0,
        total_tokens: 1_000_000,
        known_cost_usd: 4,
        pricing_version: OLD_PRICE_VERSION,
      }),
    });
    const source = read([stored], {}, new Map([
      [sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "4"],
    ]));

    const overview = buildOverview(source, catalog.store.snapshot());
    expect(overview.policies.price_version).toBe(NEW_PRICE_VERSION);
    expect(overview.totals.metrics.reference_cost_usd).toBe(4);
    expect(overview.totals.metrics.reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: null, is_partial: true },
      non_cache: { known_cost_usd: null, is_partial: true },
    });
  });
});
