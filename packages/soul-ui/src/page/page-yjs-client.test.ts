import { describe, expect, it, vi } from "vitest";

import {
  buildPageYjsUrl,
  createPageYjsClient,
  getPageYjsDocumentName,
  type PageProviderConfiguration,
  type PageProviderLike,
} from "./page-yjs-client";
import { BLOCKS_MAP, PAGE_META_MAP } from "./page-document";

describe("page Yjs client", () => {
  it("builds the dedicated page websocket route and document name", () => {
    const location = { protocol: "https:", host: "soul.example" } as Location;
    expect(buildPageYjsUrl("page/one", location)).toBe("wss://soul.example/yjs/page/page%2Fone");
    expect(getPageYjsDocumentName("page-1")).toBe("page:page-1");
  });

  it("does not become ready until each connection has synced", () => {
    const provider = providerHarness();
    const client = createPageYjsClient({
      pageId: "page-1",
      location: { protocol: "https:", host: "soul.example" } as Location,
      createProvider: provider.create,
    });

    provider.emitStatus("connected");
    expect(client.getSnapshot()).toMatchObject({ status: "syncing", ready: false });
    expect(() => client.getProjection()).toThrow("page Yjs document is not synced");
    seedPageDocument(client.doc);
    provider.emitSynced(true);
    expect(client.getSnapshot()).toMatchObject({ status: "ready", ready: true });
    expect(client.getProjection().getSnapshot().page.id).toBe("page-1");

    provider.emitStatus("disconnected");
    expect(client.getSnapshot()).toMatchObject({ status: "reconnecting", ready: false });
    provider.emitStatus("connected");
    expect(client.getSnapshot()).toMatchObject({ status: "syncing", ready: false });
    provider.emitSynced(true);
    expect(client.getSnapshot()).toMatchObject({ status: "ready", ready: true });
    client.destroy();
  });

  it("surfaces an initial connection failure", () => {
    const provider = providerHarness();
    const client = createPageYjsClient({
      pageId: "page-1",
      location: { protocol: "https:", host: "soul.example" } as Location,
      createProvider: provider.create,
    });

    provider.emitStatus("disconnected");

    expect(client.getSnapshot()).toMatchObject({
      status: "disconnected",
      ready: false,
      error: { kind: "connection" },
    });
    client.destroy();
  });

  it("surfaces authentication failure and destroys provider resources idempotently", () => {
    const provider = providerHarness();
    const client = createPageYjsClient({
      pageId: "page-1",
      location: { protocol: "http:", host: "localhost:5200" } as Location,
      createProvider: provider.create,
    });

    provider.emitAuthenticationFailed("expired cookie");
    provider.emitStatus("disconnected");
    expect(client.getSnapshot()).toMatchObject({
      status: "authentication_failed",
      ready: false,
      error: { kind: "authentication", message: "expired cookie" },
    });

    client.destroy();
    client.destroy();
    expect(provider.instance.destroy).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({ status: "destroyed", ready: false });
  });
});

function providerHarness() {
  let configuration: PageProviderConfiguration | undefined;
  const instance: PageProviderLike = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    instance,
    create: vi.fn((input: PageProviderConfiguration) => {
      configuration = input;
      return instance;
    }),
    emitStatus(status: "connecting" | "connected" | "disconnected") {
      configuration?.onStatus({ status });
    },
    emitSynced(state: boolean) {
      configuration?.onSynced({ state });
    },
    emitAuthenticationFailed(reason: string) {
      configuration?.onAuthenticationFailed({ reason });
    },
  };
}

function seedPageDocument(doc: import("yjs").Doc): void {
  const meta = doc.getMap(PAGE_META_MAP);
  meta.set("schemaVersion", 1);
  meta.set("id", "page-1");
  meta.set("title", "Page");
  meta.set("dailyDate", null);
  meta.set("mutationVersion", 1);
  meta.set("archived", false);
  meta.set("metadata", {});
  doc.getMap(BLOCKS_MAP);
}
