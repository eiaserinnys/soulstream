import { HocuspocusProvider } from "@hocuspocus/provider";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createPendingMutationHandle } from "../pending-mutation-registry";
import {
  createPageDocumentProjection,
  type PageDocumentProjection,
} from "./page-document";

export type PageYjsStatus =
  | "connecting"
  | "syncing"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "authentication_failed"
  | "destroyed";

export interface PageYjsClientError {
  readonly kind: "authentication" | "connection";
  readonly message: string;
}

export interface PageYjsClientSnapshot {
  readonly status: PageYjsStatus;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly synced: boolean;
  readonly error: PageYjsClientError | null;
}

export interface PageProviderConfiguration {
  url: string;
  name: string;
  document: Y.Doc;
  awareness: Awareness;
  token: string;
  autoConnect: false;
  onStatus(input: { status: "connecting" | "connected" | "disconnected" }): void;
  onSynced(input: { state: boolean }): void;
  onAuthenticationFailed(input: { reason: string }): void;
  onUnsyncedChanges(input: { number: number }): void;
}

export interface PageProviderLike {
  connect(): Promise<unknown>;
  disconnect(): void;
  destroy(): void;
}

export interface PageYjsClient {
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  getSnapshot(): PageYjsClientSnapshot;
  subscribe(listener: () => void): () => void;
  getProjection(): PageDocumentProjection;
  connect(): Promise<void>;
  disconnect(): void;
  destroy(): void;
}

const SAFE_DESTROY_TIMEOUT_MS = 5_000;

export async function destroyPageYjsClientSafely(
  client: PageYjsClient,
  timeoutMs = SAFE_DESTROY_TIMEOUT_MS,
): Promise<void> {
  if (isConnectionAttempt(client.getSnapshot().status)) {
    await new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      try {
        unsubscribe = client.subscribe(() => {
          if (!isConnectionAttempt(client.getSnapshot().status)) finish();
        });
        if (!isConnectionAttempt(client.getSnapshot().status)) finish();
      } catch {
        finish();
      }
    });
  }
  client.destroy();
}

function isConnectionAttempt(status: PageYjsStatus): boolean {
  return status === "connecting" || status === "reconnecting";
}

export function getPageYjsDocumentName(pageId: string): string {
  assertPageId(pageId);
  return `page:${pageId}`;
}

export function buildPageYjsUrl(pageId: string, locationLike: Location = window.location): string {
  assertPageId(pageId);
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  if (locationLike.protocol !== "http:" && locationLike.protocol !== "https:") {
    throw new Error(`unsupported page Yjs protocol: ${locationLike.protocol}`);
  }
  return `${protocol}//${locationLike.host}/yjs/page/${encodeURIComponent(pageId)}`;
}

export function createPageYjsClient(options: {
  pageId: string;
  location?: Location;
  doc?: Y.Doc;
  awareness?: Awareness;
  createProvider?: (configuration: PageProviderConfiguration) => PageProviderLike;
}): PageYjsClient {
  const doc = options.doc ?? new Y.Doc();
  const awareness = options.awareness ?? new Awareness(doc);
  const listeners = new Set<() => void>();
  let destroyed = false;
  let everSynced = false;
  let authenticationFailed = false;
  let projection: PageDocumentProjection | null = null;
  const pendingMutation = createPendingMutationHandle();
  let snapshot = makeSnapshot("connecting", false, false, null);
  const publish = (
    status: PageYjsStatus,
    connected: boolean,
    synced: boolean,
    error: PageYjsClientError | null,
  ) => {
    snapshot = makeSnapshot(status, connected, synced, error);
    for (const listener of listeners) listener();
  };
  const createProvider = options.createProvider ?? defaultProviderFactory;
  const provider = createProvider({
    url: buildPageYjsUrl(options.pageId, options.location),
    name: getPageYjsDocumentName(options.pageId),
    document: doc,
    awareness,
    token: "cookie",
    autoConnect: false,
    onStatus: ({ status }) => {
      if (destroyed) return;
      if (status === "connected") {
        authenticationFailed = false;
        publish("syncing", true, false, null);
      } else if (status === "connecting") {
        publish(everSynced ? "reconnecting" : "connecting", false, false, snapshot.error);
      } else if (authenticationFailed) {
        publish("authentication_failed", false, false, snapshot.error);
      } else {
        publish(
          everSynced ? "reconnecting" : "disconnected",
          false,
          false,
          { kind: "connection", message: everSynced
            ? "Page sync websocket disconnected. Reconnecting."
            : "Page sync websocket failed to connect." },
        );
      }
    },
    onSynced: ({ state }) => {
      if (destroyed) return;
      if (state) {
        everSynced = true;
        publish("ready", true, true, null);
      } else {
        publish(everSynced ? "reconnecting" : "syncing", snapshot.connected, false, snapshot.error);
      }
    },
    onAuthenticationFailed: ({ reason }) => {
      if (destroyed) return;
      authenticationFailed = true;
      publish("authentication_failed", false, false, {
        kind: "authentication",
        message: reason || "Page sync authentication failed.",
      });
    },
    onUnsyncedChanges: ({ number }) => {
      if (!destroyed) pendingMutation.setPending(number > 0);
    },
  });

  return {
    pageId: options.pageId,
    doc,
    awareness,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) throw new Error("page Yjs client is destroyed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getProjection() {
      if (destroyed) throw new Error("page Yjs client is destroyed");
      if (!snapshot.ready) throw new Error("page Yjs document is not synced");
      projection ??= createPageDocumentProjection(doc, options.pageId);
      return projection;
    },
    async connect() {
      if (destroyed) throw new Error("page Yjs client is destroyed");
      authenticationFailed = false;
      publish(everSynced ? "reconnecting" : "connecting", false, false, null);
      await provider.connect();
    },
    disconnect() {
      if (destroyed) return;
      provider.disconnect();
      publish("disconnected", false, false, {
        kind: "connection",
        message: "Page sync websocket disconnected.",
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      provider.destroy();
      pendingMutation.dispose();
      awareness.destroy();
      projection?.destroy();
      doc.destroy();
      snapshot = makeSnapshot("destroyed", false, false, null);
    },
  };
}

function defaultProviderFactory(configuration: PageProviderConfiguration): PageProviderLike {
  return new HocuspocusProvider(configuration);
}

function makeSnapshot(
  status: PageYjsStatus,
  connected: boolean,
  synced: boolean,
  error: PageYjsClientError | null,
): PageYjsClientSnapshot {
  return Object.freeze({ status, ready: status === "ready" && synced, connected, synced, error });
}

function assertPageId(pageId: string): void {
  if (!pageId || pageId.trim() !== pageId) {
    throw new Error("pageId must be a non-empty trimmed string");
  }
}
