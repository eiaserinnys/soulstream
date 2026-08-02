import Fastify from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import {
  PageMutationCore,
} from "../../src/page/page_mutation_core.js";
import type {
  CommitPageMutationInput,
  PageMutationCommitResult,
  PageOperationRecord,
} from "../../src/page/page_repository.js";
import {
  createPageYDocSnapshot,
  readPageYDocReplica,
  type PageYjsReplica,
} from "../../src/page/page_yjs_model.js";
import { registerPageYjsRoutes } from "../../src/page/page_yjs_route.js";
import { PageYjsService } from "../../src/page/page_service.js";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map(async (provider) => await provider.destroy()));
});

describe("identity page commit → live Y.Doc synchronization", () => {
  const cases = [
    { identity: "task", active: true },
    { identity: "task", active: false },
    { identity: "project", active: true },
    { identity: "project", active: false },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.identity} identity synchronizes an ${testCase.active ? "active" : "inactive"} document without a second persist`, async () => {
      const pageId = `${testCase.identity}-${testCase.active ? "active" : "inactive"}`;
      const repository = new IdentityPageRepository();
      repository.seed(pageId, testCase.identity);
      const app = Fastify({ logger: false });
      const service = new PageYjsService({
        repository,
        auth: {
          authBearerToken: "service-token",
          environment: "production",
          dashboardAuthEnabled: false,
          verifyDashboardToken: async () => null,
        },
      });
      registerPageYjsRoutes(app, {
        createService: () => service,
        authBearerToken: "service-token",
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      let browser: HocuspocusProvider | null = null;
      let browserUpdateCount = 0;

      try {
        if (testCase.active) {
          browser = connectProvider(address, pageId);
          await connectAndWaitForSync(browser);
          browser.document.on("update", () => { browserUpdateCount += 1; });
        }

        const identityApplication = new PageMutationCore().mutate(
          repository.decode(pageId),
          {
            pageId,
            expectedVersion: 10,
            command: { type: "rename_page", title: "Renamed identity" },
            actor: { actorKind: "system" },
            idempotencyKey: `${testCase.identity}:rename:${pageId}`,
          },
        );
        await repository.commitPageMutation({
          documentName: `page:${pageId}`,
          application: identityApplication,
          operationId: `${testCase.identity}-identity-operation`,
        });

        await service.hydrateCommittedPage(`page:${pageId}`);

        const hostRead = await service.getPage(pageId);
        expect(hostRead.page).toMatchObject({
          title: "Renamed identity",
          version: 11,
        });
        if (browser) {
          await waitFor(() => readPageYDocReplica(pageId, browser!.document).page.mutationVersion === 11);
          expect(readPageYDocReplica(pageId, browser.document).page.title)
            .toBe("Renamed identity");
          expect(browserUpdateCount).toBeGreaterThan(0);
        } else {
          expect(service.getPersistenceDiagnostics().activeDocuments).toBe(0);
        }

        const followup = await service.mutatePage({
          pageId,
          expectedVersion: 11,
          command: {
            type: "create_block",
            id: "post-identity-block",
            parentId: null,
            afterBlockId: null,
            blockType: "paragraph",
            text: "mutation after identity commit",
            properties: {},
          },
          actor: { actorKind: "system" },
          idempotencyKey: `${testCase.identity}:post-identity:${pageId}`,
        });

        expect(followup.page.version).toBe(12);
        expect(repository.commitCount).toBe(2);
        expect(repository.storeCount).toBe(0);
        expect(repository.read(pageId).page.mutationVersion).toBe(12);
      } finally {
        await browser?.destroy();
        await app.close();
      }
    }, 20_000);
  }
});

function connectProvider(address: string, pageId: string): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: `${address.replace("http", "ws")}/yjs/page/${pageId}`,
    name: `page:${pageId}`,
    document: new Y.Doc(),
    token: "service-token",
    WebSocketPolyfill: WebSocket,
    autoConnect: false,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket });
  providers.push(provider);
  return provider;
}

async function connectAndWaitForSync(provider: HocuspocusProvider): Promise<void> {
  const synced = provider.isSynced
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("provider sync timed out")), 10_000);
      provider.on("synced", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  provider.connect();
  await synced;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class IdentityPageRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  readonly operations = new Map<string, PageMutationCommitResult>();
  commitCount = 0;
  storeCount = 0;

  seed(pageId: string, identity: "task" | "project"): void {
    this.snapshots.set(`page:${pageId}`, createPageYDocSnapshot({
      page: {
        id: pageId,
        title: "Original identity",
        dailyDate: null,
        mutationVersion: 10,
        archived: false,
        metadata: identity === "task"
          ? { taskIdentity: true }
          : { projectIdentity: true, folderId: pageId },
      },
      blocks: [],
    }));
  }

  decode(pageId: string): Y.Doc {
    const snapshot = this.snapshots.get(`page:${pageId}`);
    if (!snapshot) throw new Error(`snapshot missing: ${pageId}`);
    const document = new Y.Doc();
    Y.applyUpdate(document, snapshot);
    return document;
  }

  read(pageId: string): PageYjsReplica {
    return readPageYDocReplica(pageId, this.decode(pageId));
  }

  async getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }

  async hasPageProjection(pageId: string): Promise<boolean> {
    return this.snapshots.has(`page:${pageId}`);
  }

  async storePageYjsState(input: {
    documentName: string;
    snapshot: Uint8Array;
  }): Promise<void> {
    this.snapshots.set(input.documentName, input.snapshot);
    this.storeCount += 1;
  }

  async hasPageOperation(operationId: string): Promise<boolean> {
    return this.operations.has(operationId);
  }

  async getPageMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PageMutationCommitResult | null> {
    return [...this.operations.values()].find(
      (result) => result.operation.idempotency_key === idempotencyKey,
    ) ?? null;
  }

  async getPageTimestamps(): Promise<{ pageCreatedAt: Date; pageUpdatedAt: Date }> {
    return { pageCreatedAt: new Date(0), pageUpdatedAt: new Date(0) };
  }

  async findPageIdByTitle(): Promise<null> { return null; }
  async findPageIdByDailyDate(): Promise<null> { return null; }
  async listPages() { return { items: [], next_cursor: null }; }
  async getPageBacklinks() { return { items: [], next_cursor: null }; }

  async commitPageMutation(input: CommitPageMutationInput): Promise<PageMutationCommitResult> {
    const pageId = input.application.replica.page.id;
    const current = this.read(pageId).page.mutationVersion;
    if (current !== input.application.expectedVersion) {
      throw new Error(`version conflict: expected ${input.application.expectedVersion}, current ${current}`);
    }
    this.snapshots.set(input.documentName, input.application.snapshot);
    this.commitCount += 1;
    const operation: PageOperationRecord = {
      id: input.operationId,
      page_id: pageId,
      target_block_id: input.application.targetBlockId,
      operation_type: input.application.operationType,
      actor_kind: input.application.actor.actorKind,
      actor_session_id: input.application.actor.actorSessionId ?? null,
      actor_event_id: null,
      actor_user_id: input.application.actor.actorUserId ?? null,
      idempotency_key: input.application.idempotencyKey,
      expected_version: input.application.expectedVersion,
      result_version: input.application.resultVersion,
      payload_json: input.application.payload,
      reason: input.application.reason,
      created_at: new Date(0),
    };
    const result = {
      operation,
      pageCreatedAt: new Date(0),
      pageUpdatedAt: new Date(0),
      idempotent: false,
    };
    this.operations.set(operation.id, result);
    return result;
  }
}
