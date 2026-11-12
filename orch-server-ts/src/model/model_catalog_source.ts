import type { ModelCatalogConfig } from "@soulstream/model-catalog";

/**
 * Read-only view of the repository's model catalogue. The file store's
 * `snapshot()` satisfies it; composition takes this, never a path or a copy.
 */
export type ModelCatalogSource = {
  snapshot(): ModelCatalogConfig;
};
