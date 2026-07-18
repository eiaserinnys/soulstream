import { vi } from "vitest";

import {
  InMemoryNodeRegistry,
  MarkdownDocumentRouteError,
  createApp,
  parseOrchServerConfig,
  type BoardYjsHostHttpClient,
  type MarkdownDocumentAccessProvider,
  type MarkdownDocumentRouteProvider,
  type NodeRegistrationPayload,
} from "../src/index.js";

export const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const folders = [
  { id: "folder-a", parentFolderId: null, name: "Alpha" },
  { id: "folder-a-child", parentFolderId: "folder-a", name: "Child" },
  { id: "folder-b", parentFolderId: null, name: "Beta" },
];

const documents = new Map([
  ["doc/one", { id: "doc/one", folderId: "folder-a-child", title: "Doc" }],
  ["doc-snake", { id: "doc-snake", folder_id: "folder-a", title: "Snake" }],
  ["doc-b", { id: "doc-b", folderId: "folder-b", title: "Other" }],
]);

const customViews = new Map([
  ["view-1", { id: "view-1", folderId: "folder-a", html: "<p>view</p>" }],
]);

type ProviderCall =
  | ["listFolders"]
  | ["access"]
  | ["resolveContainer", unknown]
  | ["getDocument", string]
  | ["getCustomView", string];

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
  });
}

function registerBoardHost(registry: InMemoryNodeRegistry): string {
  registerNode(registry, "worker-node", 4106, false);
  const oldConnectionId = registerNode(registry, "old-board-host", 4107, true);
  registry.disconnectNode("old-board-host", {
    connectionId: oldConnectionId,
    reason: "network close",
  });
  return registerNode(registry, "board-host", 4105, true);
}

function registerNode(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  port: number,
  isHost: boolean,
): string {
  return registry.registerNode({
    type: "node_register",
    node_id: nodeId,
    host: "localhost",
    port,
    agents: [],
    capabilities: { board_yjs_host: isHost },
  } satisfies NodeRegistrationPayload).node.connectionId;
}

function createHarness(overrides: Partial<MarkdownDocumentRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: MarkdownDocumentRouteProvider = {
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
    },
    async resolveBoardContainerFolderId(container) {
      calls.push(["resolveContainer", container]);
      if (container.kind === "task" && container.id === "task-1") {
        return "folder-a";
      }
      throw new MarkdownDocumentRouteError(
        "BOARD_CONTAINER_NOT_FOUND",
        "Task board container not found",
        404,
      );
    },
    async getMarkdownDocument(documentId) {
      calls.push(["getDocument", documentId]);
      return documents.get(documentId) ?? null;
    },
    async getCustomView(customViewId) {
      calls.push(["getCustomView", customViewId]);
      return customViews.get(customViewId) ?? null;
    },
    ...overrides,
  };
  return { calls, provider };
}

function createAccessProvider(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  calls: ProviderCall[],
): MarkdownDocumentAccessProvider {
  return {
    async resolveAccess() {
      calls.push(["access"]);
      return access;
    },
  };
}

export function createAppWithMarkdownDocuments(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  overrides: Partial<MarkdownDocumentRouteProvider> = {},
  httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
    statusCode: 201,
    headers: { "content-type": "application/json" },
    body: { document: { id: "doc-1" } },
  })),
  includeBoardYjsProxyRoutes = false,
) {
  const registry = createRegistry();
  const connectionId = registerBoardHost(registry);
  const harness = createHarness(overrides);
  const accessProvider = createAccessProvider(access, harness.calls);
  const hostProxy = { registry, httpClient };
  const app = createApp({
    config,
    ...(includeBoardYjsProxyRoutes ? { boardYjsHostProxyRoutes: hostProxy } : {}),
    markdownDocumentRoutes: {
      provider: harness.provider,
      accessProvider,
      hostProxy,
    },
  });
  return { app, calls: harness.calls, connectionId, httpClient };
}
