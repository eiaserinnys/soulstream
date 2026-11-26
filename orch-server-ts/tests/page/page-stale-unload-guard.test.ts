import type { Hocuspocus } from "@hocuspocus/server";
import { afterEach, describe, expect, it } from "vitest";

import { PageYjsService } from "../../src/page/page_service.js";
import {
  createPageYDocSnapshot,
  type PageYjsReplica,
} from "../../src/page/page_yjs_model.js";

const services: PageYjsService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("Page Yjs stale unload guard", () => {
  it("keeps a reopened document registered after the previous connection's deferred unload", async () => {
    const repository = new MemoryPageRepository();
    const service = new PageYjsService({ repository: repository as never });
    services.push(service);
    const hocuspocus = (service as unknown as { hocuspocus: Hocuspocus }).hocuspocus;

    for (let round = 0; round < 30; round += 1) {
      const pageId = `stale-unload-${round}`;
      const documentName = `page:${pageId}`;
      repository.seed(pageId);

      const first = await hocuspocus.openDirectConnection(documentName, {});
      await first.disconnect();
      const held = await hocuspocus.openDirectConnection(documentName, {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      const again = await hocuspocus.openDirectConnection(documentName, {});
      expect(again.document, `round ${round}`).toBe(held.document);

      await again.disconnect();
      await held.disconnect();
    }
  }, 20_000);
});

class MemoryPageRepository {
  private readonly snapshots = new Map<string, Uint8Array>();

  seed(pageId: string): void {
    this.snapshots.set(`page:${pageId}`, createPageYDocSnapshot({
      page: {
        id: pageId,
        title: "Page",
        dailyDate: null,
        mutationVersion: 1,
        archived: false,
        metadata: {},
      },
      blocks: [],
    }));
  }

  async getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }

  async hasPageProjection(pageId: string): Promise<boolean> {
    return this.snapshots.has(`page:${pageId}`);
  }

  async hasPageOperation(): Promise<boolean> {
    return false;
  }

  async storePageYjsState(input: {
    documentName: string;
    snapshot: Uint8Array;
    replica: PageYjsReplica;
  }): Promise<void> {
    this.snapshots.set(input.documentName, input.snapshot);
  }
}
