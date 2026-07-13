import { pathToFileURL } from "node:url";

import Fastify from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

interface HarnessSample {
  round: number;
  queuedHeapBytes: number;
  retainedHeapBytes: number;
  storeCalls: number;
}

interface PageModelModule {
  createPageYDocSnapshot(input: unknown): Uint8Array;
}

interface PageRouteModule {
  registerPageYjsRoutes(app: ReturnType<typeof Fastify>, options: unknown): void;
}

interface PageServiceModule {
  PageYjsService: new (options: unknown) => {
    assertWebsocketAuthConfigured(): void;
    handleConnection(socket: WebSocket, request: unknown, pageId: string): void;
    close(): Promise<void>;
  };
}

async function main(): Promise<void> {
  const rounds = 3;
  const editsPerRound = 1_000;
  const targetRoot = argumentValue("--target-root") ?? process.cwd().replace(/\/orch-server-ts$/, "");
  const assertStable = process.argv.includes("--assert-stable");
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) throw new Error("page Yjs heap harness requires node --expose-gc");

  const pageModel = await importTarget<PageModelModule>(targetRoot, "orch-server-ts/src/page/page_yjs_model.ts");
  const pageRoute = await importTarget<PageRouteModule>(targetRoot, "orch-server-ts/src/page/page_yjs_route.ts");
  const pageService = await importTarget<PageServiceModule>(targetRoot, "orch-server-ts/src/page/page_service.ts");
  const repository = new SlowMemoryPageRepository(pageModel.createPageYDocSnapshot);
  repository.seed("page-heap");
  const app = Fastify({ logger: false });
  const service = new pageService.PageYjsService({
    repository,
    auth: {
      authBearerToken: "service-token",
      environment: "production",
      dashboardAuthEnabled: false,
      verifyDashboardToken: async () => null,
    },
    logger: app.log,
  });
  pageRoute.registerPageYjsRoutes(app, {
    createService: () => service,
    authBearerToken: "service-token",
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const provider = new HocuspocusProvider({
    url: `${address.replace("http", "ws")}/yjs/page/page-heap`,
    name: "page:page-heap",
    document: new Y.Doc(),
    token: "service-token",
    WebSocketPolyfill: WebSocket,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket });

  try {
    await waitForSync(provider);
    const text = getText(provider.document);
    gc();
    const baseline = process.memoryUsage().heapUsed;
    const samples: HarnessSample[] = [];

    for (let round = 1; round <= rounds; round += 1) {
      for (let index = 0; index < editsPerRound; index += 1) text.insert(text.length, "x");
      await delay(100);
      gc();
      const queuedHeapBytes = process.memoryUsage().heapUsed;
      await delay(2_500);
      gc();
      samples.push({
        round,
        queuedHeapBytes,
        retainedHeapBytes: process.memoryUsage().heapUsed,
        storeCalls: repository.storeCalls,
      });
    }

    const retainedSlopeBytes = samples.at(-1)!.retainedHeapBytes - samples[0]!.retainedHeapBytes;
    const maxQueuedDeltaBytes = Math.max(...samples.map(
      (sample) => sample.queuedHeapBytes - baseline,
    ));
    const result = {
      targetRoot,
      rounds,
      edits: rounds * editsPerRound,
      storeCalls: repository.storeCalls,
      baselineHeapBytes: baseline,
      maxQueuedDeltaBytes,
      retainedSlopeBytes,
      samples,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);

    if (assertStable) {
      if (repository.storeCalls > rounds + 1) {
        throw new Error(`expensive store calls are unbounded: ${repository.storeCalls}`);
      }
      if (maxQueuedDeltaBytes > 64 * 1024 * 1024) {
        throw new Error(`queued heap delta exceeded 64MiB: ${maxQueuedDeltaBytes}`);
      }
      if (retainedSlopeBytes > 16 * 1024 * 1024) {
        throw new Error(`retained heap slope exceeded 16MiB: ${retainedSlopeBytes}`);
      }
    }
  } finally {
    await provider.destroy();
    await app.close();
  }
}

class SlowMemoryPageRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  storeCalls = 0;

  constructor(private readonly createSnapshot: PageModelModule["createPageYDocSnapshot"]) {}

  seed(pageId: string): void {
    this.snapshots.set(`page:${pageId}`, this.createSnapshot({
      page: {
        id: pageId,
        title: "Heap harness",
        dailyDate: null,
        mutationVersion: 1,
        archived: false,
        metadata: {},
      },
      blocks: [{
        id: "block-1",
        parentId: null,
        positionKey: "a",
        type: "paragraph",
        text: "",
        properties: {},
        collapsed: false,
      }],
    }));
  }

  async getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }

  async storePageYjsState(input: {
    documentName: string;
    snapshot: Uint8Array;
  }): Promise<void> {
    this.storeCalls += 1;
    await delay(1);
    this.snapshots.set(input.documentName, input.snapshot);
  }

  async hasPageOperation(): Promise<boolean> { return false; }
  async getPageMutationByIdempotencyKey(): Promise<null> { return null; }
  async getPageTimestamps() { return { pageCreatedAt: new Date(0), pageUpdatedAt: new Date(0) }; }
  async findPageIdByTitle(): Promise<null> { return null; }
  async findPageIdByDailyDate(): Promise<null> { return null; }
  async listPages() { return { items: [], next_cursor: null }; }
  async getPageBacklinks() { return { items: [], next_cursor: null }; }
  async commitPageMutation(): Promise<never> { throw new Error("not used in heap harness"); }
}

function getText(document: Y.Doc): Y.Text {
  const block = document.getMap<Y.Map<unknown>>("blocks").get("block-1");
  const text = block?.get("text");
  if (!(text instanceof Y.Text)) throw new Error("heap harness block text missing");
  return text;
}

function waitForSync(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider sync timed out")), 10_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
  });
}

function argumentValue(name: string): string | null {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function importTarget<T>(targetRoot: string, relativePath: string): Promise<T> {
  return await import(pathToFileURL(`${targetRoot}/${relativePath}`).href) as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main();
