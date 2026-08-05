import { vi } from "vitest";

import {
  MarkdownDocumentRouteError,
  createApp,
  parseOrchServerConfig,
  type BoardYjsHostProxyRouteOptions,
  type MarkdownDocumentAccessProvider,
  type MarkdownDocumentRecord,
  type MarkdownDocumentRouteProvider,
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

const documents = new Map<string, MarkdownDocumentRecord>([
  ["doc/one", {
    id: "doc/one",
    folderId: "folder-a-child",
    containerKind: "task",
    containerId: "task-1",
    title: "Doc",
    body: "Before",
    version: 7,
  }],
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
  serviceOverrides: Record<string, unknown> = {},
  includeBoardYjsProxyRoutes = false,
  hostProxyOverrides: Partial<BoardYjsHostProxyRouteOptions> = {},
) {
  const harness = createHarness(overrides);
  const accessProvider = createAccessProvider(access, harness.calls);
  const service = {
    createMarkdownDocument: vi.fn(async (input) => ({
      document: {
        id: "doc-1",
        folderId: input.folderId,
        containerKind: input.container.containerKind,
        containerId: input.container.containerId,
        title: input.title,
        body: input.body,
        version: 1,
      },
      boardItem: { id: "markdown:doc-1" },
    })),
    updateMarkdownDocument: vi.fn(async () => ({
      id: "doc/one",
      folderId: "folder-a-child",
      title: "New",
      body: "Before",
      version: 8,
    })),
    deleteMarkdownDocument: vi.fn(async () => undefined),
    ...serviceOverrides,
  } as unknown as NonNullable<BoardYjsHostProxyRouteOptions["service"]>;
  const hostProxy = {
    authBearerToken: "test-token",
    service,
    ...hostProxyOverrides,
  };
  const app = createApp({
    config,
    ...(includeBoardYjsProxyRoutes ? { boardYjsHostProxyRoutes: hostProxy } : {}),
    markdownDocumentRoutes: {
      provider: harness.provider,
      accessProvider,
      hostProxy,
    },
  });
  return { app, calls: harness.calls, service };
}
