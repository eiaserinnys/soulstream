import { describe, expect, it, vi } from "vitest";

import {
  modelCatalogPathForRepository,
  openModelCatalogFile,
  repositoryRootFromEntryUrl,
} from "@soulstream/model-catalog/file-loader";

import { ModelCatalog } from "../src/model_catalog.js";

const REPOSITORY_CATALOG_PATH = modelCatalogPathForRepository(
  repositoryRootFromEntryUrl(import.meta.url),
);

describe("preset effort warning", () => {
  it("summarizes every narrowed preset in one line and does not repeat it", () => {
    const store = openModelCatalogFile({ path: REPOSITORY_CATALOG_PATH });
    const narrowedIds = new ModelCatalog(store).list()
      .filter((preset) => preset.backend === "claude"
        && preset.supported_efforts?.some((effort) => effort !== "low"))
      .map((preset) => preset.id);
    expect(narrowedIds.length).toBeGreaterThan(1);

    const warn = vi.fn();
    const catalog = new ModelCatalog(store, {
      logger: { error: vi.fn(), warn },
      effortCapabilities: { claude: ["low"] },
    });

    catalog.list();
    catalog.list();
    catalog.resolve(narrowedIds[0]!);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[1]);
    expect(message).toContain(String(narrowedIds.length));
    for (const id of narrowedIds) expect(message).toContain(id);
    expect(message).not.toContain("\n");
  });
});
