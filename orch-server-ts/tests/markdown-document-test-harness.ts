import { vi } from "vitest";

import {
  MarkdownDocumentRouteError,
  createApp,
  parseOrchServerConfig,
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
    async listMarkdownDocuments() { return { documents: [], nextCursor: null }; },
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
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
) {
  const harness = createHarness(overrides);
  const accessProvider = createAccessProvider(access, harness.calls);
  const service = {
    create: vi.fn(async (input) => ({
      document: {
        id: "doc-1",
        folderId: input.folderId,
        title: input.title,
        body: input.body,
        version: 1,
      },
      boardItem: { id: "markdown:doc-1" },
    })),
    update: vi.fn(async () => ({
      id: "doc/one",
      folderId: "folder-a-child",
      title: "New",
      body: "Before",
      version: 8,
    })),
    delete: vi.fn(async () => undefined),
    ...serviceOverrides,
  };
  const app = createApp({
    config,
    markdownDocumentRoutes: {
      provider: harness.provider,
      accessProvider,
      serviceProvider: () => service as never,
    },
  });
  return { app, calls: harness.calls, service };
}
