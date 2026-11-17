import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import { parseArguments } from "../../scripts/backfill-codex-turn-cost.js";
import { calculateBackfillCost, processBackfillRows } from "../../src/db/backfill_codex_turn_cost.js";

const catalog = parseModelCatalogYaml(readFileSync(fileURLToPath(new URL(
  "../../../packages/model-catalog/data/model-catalog.yaml", import.meta.url,
)), "utf8"));
const usage = { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 100_000 };
const candidate = { session_id: "s", id: 1, event_type: "complete", payload: { model: "gpt-6.1-terra", usage } };

describe("Codex turn cost backfill", () => {
  it("defaults to dry-run and requires an ID log for apply", () => {
    expect(parseArguments(["--checkpoint", "/tmp/checkpoint"]).apply).toBe(false);
    expect(() => parseArguments(["--checkpoint", "/tmp/checkpoint", "--apply"])).toThrow(/--ids-file/);
    expect(parseArguments(["--checkpoint", "/tmp/checkpoint", "--apply", "--ids-file", "/tmp/ids"]).apply).toBe(true);
  });
  it("selects terminal rows missing the key with known Codex prices and computes engine cost", () => {
    expect(calculateBackfillCost(candidate, catalog)).toBe(1.31);
    expect(calculateBackfillCost({ ...candidate, event_type: "error" }, catalog)).toBe(1.31);
    expect(calculateBackfillCost({ ...candidate, event_type: "user_message" }, catalog)).toBeUndefined();
    expect(calculateBackfillCost({ ...candidate, payload: { ...candidate.payload, turn_cost_usd: null } }, catalog)).toBeUndefined();
    expect(calculateBackfillCost({ ...candidate, payload: { ...candidate.payload, usage: [] } }, catalog)).toBeUndefined();
    expect(calculateBackfillCost({ ...candidate, payload: { ...candidate.payload, model: "unknown" } }, catalog)).toBeUndefined();
    expect(calculateBackfillCost({ ...candidate, payload: { ...candidate.payload, model: "claude-opus-5-5" } }, catalog)).toBeUndefined();
  });

  it("reports per-model totals without writes in dry-run and writes only eligible rows on apply", async () => {
    const write = vi.fn(async () => true);
    const rows = [candidate, { ...candidate, id: 2, event_type: "error" }, { ...candidate, id: 3, payload: { ...candidate.payload, turn_cost_usd: 0 } }];
    const dry = await processBackfillRows(rows, catalog, false, write);
    expect(write).not.toHaveBeenCalled();
    expect(dry).toEqual({ "gpt-6.1-terra": { count: 2, cost_usd: 2.62 } });
    const applied = await processBackfillRows(rows, catalog, true, write);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(candidate, 1.31);
    expect(applied).toEqual(dry);
  });
});
