import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  modelCatalogPathForRepository,
  openModelCatalogFile,
  repositoryRootFromEntryUrl,
  type ModelCatalogFileStore,
} from "@soulstream/model-catalog/file-loader";

/** The repository's canonical catalogue, resolved the same way production_main resolves it. */
export const REPOSITORY_MODEL_CATALOG_PATH = modelCatalogPathForRepository(
  repositoryRootFromEntryUrl(new URL("../../src/index.ts", import.meta.url).href),
);

/** A store over the repository's canonical catalogue; no polling timer is started. */
export function repositoryModelCatalog(): ModelCatalogFileStore {
  return openModelCatalogFile({ path: REPOSITORY_MODEL_CATALOG_PATH });
}

export type TempModelCatalog = {
  readonly path: string;
  readonly store: ModelCatalogFileStore;
  /** Rewrite the file and move its mtime so the store's signature changes. */
  edit(mutate: (text: string) => string): void;
  cleanup(): void;
};

/**
 * A writable copy of the canonical catalogue for reload tests. The store reads
 * the copy on every signature change, exactly like the production store.
 */
export function createTempModelCatalog(
  mutate?: (text: string) => string,
): TempModelCatalog {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orch-model-catalog-"));
  const filePath = path.join(directory, "model-catalog.yaml");
  const canonical = fs.readFileSync(REPOSITORY_MODEL_CATALOG_PATH, "utf-8");
  fs.writeFileSync(filePath, mutate === undefined ? canonical : mutate(canonical));
  const store = openModelCatalogFile({ path: filePath });
  const baseTime = Date.now();
  let revision = 0;
  return {
    path: filePath,
    store,
    edit(edit) {
      fs.writeFileSync(filePath, edit(fs.readFileSync(filePath, "utf-8")));
      revision += 1;
      const stamp = new Date(baseTime + revision * 1_000);
      fs.utimesSync(filePath, stamp, stamp);
    },
    cleanup() {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
