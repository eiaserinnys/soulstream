import { describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  createApp,
  createLiveDashboardAccessProvider,
  parseOrchServerConfig,
  type AuthJwtHelper,
  type BoardItemRouteProvider,
  type BoardYjsHostProxyRouteOptions,
  type DashboardUserRecord,
  type DashboardUserRepository,
  type FolderRouteProvider,
  type LiveConfigProviderBoundary,
  type MarkdownDocumentRouteProvider,
  type TaskRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "service-token",
});

const folders = [
  { id: "folder-a", parentFolderId: null, name: "Alpha" },
  { id: "folder-a-child", parentFolderId: "folder-a", name: "Child" },
  { id: "folder-b", parentFolderId: null, name: "Beta" },
];

describe("live dashboard access provider route wiring", () => {
  it("filters folder list and payload through service token access_email", async () => {
    const { app } = createRouteApp();

    const unrestricted = await app.inject({
      method: "GET",
      url: "/api/folders",
      headers: { authorization: "Bearer service-token" },
    });
    expect(unrestricted.statusCode).toBe(200);
    expect(unrestricted.json()).toMatchObject({
      folders,
      sessions: {},
      access: { restricted: false, allowedFolderIds: [] },
    });

    const restricted = await app.inject({
      method: "GET",
      url: "/api/folders?access_email=restricted@example.com",
      headers: { authorization: "Bearer service-token" },
    });
    expect(restricted.statusCode).toBe(200);
    expect(restricted.json()).toMatchObject({
      folders: [folders[0], folders[1]],
      sessions: {
        "sess-a": { folderId: "folder-a" },
        "sess-child": { folderId: "folder-a-child" },
      },
      access: { restricted: true, allowedFolderIds: ["folder-a"] },
    });

    await app.close();
  });

  it("denies missing and invalid dashboard JWT before route handlers leak data", async () => {
    const { app } = createRouteApp();

    expect((await app.inject({ method: "GET", url: "/api/folders" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/api/folders",
      headers: { cookie: `${AUTH_COOKIE_NAME}=invalid-token` },
    })).statusCode).toBe(401);

    await app.close();
  });

  it("applies the same folder access to board, markdown, and task routes", async () => {
    const { app } = createRouteApp();
    const headers = { cookie: `${AUTH_COOKIE_NAME}=restricted-token` };

    expect((await app.inject({
      method: "GET",
      url: "/api/board-items?folder_id=folder-a-child",
      headers,
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/api/board-items?folder_id=folder-b",
      headers,
    })).statusCode).toBe(403);

    expect((await app.inject({
      method: "GET",
      url: "/api/markdown-documents/doc-child",
      headers,
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/api/markdown-documents/doc-b",
      headers,
    })).statusCode).toBe(403);

    expect((await app.inject({
      method: "GET",
      url: "/api/tasks/rb-child",
      headers,
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/api/tasks/rb-b",
      headers,
    })).statusCode).toBe(403);

    await app.close();
  });

  it("adds DB-backed isAdmin and dashboardAccess to auth status", async () => {
    const { app } = createRouteApp();

    expect((await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: `${AUTH_COOKIE_NAME}=restricted-token` },
    })).json()).toMatchObject({
      authenticated: true,
      user: {
        email: "restricted@example.com",
        isAdmin: false,
        dashboardAccess: { restricted: true, allowedFolderIds: ["folder-a"] },
      },
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: `${AUTH_COOKIE_NAME}=admin-token` },
    })).json()).toMatchObject({
      authenticated: true,
      user: {
        email: "admin@example.com",
        isAdmin: true,
        dashboardAccess: { restricted: false, allowedFolderIds: [] },
      },
    });

    await app.close();
  });
});

function createRouteApp() {
  const accessProvider = createLiveDashboardAccessProvider({
    configProvider: configWith({
      auth_bearer_token: "service-token",
      google_client_id: "google-client",
      environment: "production",
    }),
    jwt: createJwt(),
    repository: createUserRepository(),
  });
  const hostProxy = {
    registry: {},
    httpClient: vi.fn(async () => ({ statusCode: 200, body: {} })),
  } as unknown as BoardYjsHostProxyRouteOptions;
  const app = createApp({
    config,
    authRoutes: {
      configProvider: {
        getConfig: vi.fn(async () => ({
          authEnabled: true,
          devModeEnabled: false,
          googleClientId: "google-client",
          googleClientSecret: "google-secret",
          callbackUrl: "/api/auth/google/callback",
          jwtSecretConfigured: true,
          cookieName: AUTH_COOKIE_NAME,
        })),
      },
      httpClient: { post: vi.fn(), get: vi.fn() },
      jwt: createJwt(),
      nativeVerifier: vi.fn(),
      resolveTokenAccess: vi.fn(async () => ({ ok: true as const })),
      userPayloadExtra: accessProvider.userPayloadExtra,
    },
    folderRoutes: { provider: createFolderProvider(), accessProvider },
    boardItemRoutes: {
      provider: createBoardItemProvider(),
      accessProvider,
      hostProxy,
    },
    markdownDocumentRoutes: {
      provider: createMarkdownProvider(),
      accessProvider,
      hostProxy,
    },
    taskRoutes: {
      provider: createTaskProvider(),
      accessProvider,
      httpClient: vi.fn(async () => ({ statusCode: 200 })),
    },
  });
  return { app };
}

function createFolderProvider(): FolderRouteProvider {
  return {
    listFolders: vi.fn(async () => folders),
    listSessionAssignments: vi.fn(async () => ({
      "sess-a": { folderId: "folder-a" },
      "sess-child": { folderId: "folder-a-child" },
      "sess-b": { folderId: "folder-b" },
      "sess-none": { folderId: null },
    })),
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reorderFolders: vi.fn(),
  };
}

function createBoardItemProvider(): BoardItemRouteProvider {
  return {
    listFolders: vi.fn(async () => folders),
    listBoardItems: vi.fn(async () => [{ id: "item-child", folderId: "folder-a-child" }]),
    resolveBoardContainerFolderId: vi.fn(async () => "folder-a-child"),
    getCatalogSnapshot: vi.fn(async () => ({
      folders,
      boardItems: [{ id: "item-child", folderId: "folder-a-child" }],
    })),
  };
}

function createMarkdownProvider(): MarkdownDocumentRouteProvider {
  return {
    listFolders: vi.fn(async () => folders),
    resolveBoardContainerFolderId: vi.fn(async () => "folder-a-child"),
    getMarkdownDocument: vi.fn(async (documentId) => {
      if (documentId === "doc-child") return { id: "doc-child", folderId: "folder-a-child" };
      if (documentId === "doc-b") return { id: "doc-b", folderId: "folder-b" };
      return null;
    }),
    getCustomView: vi.fn(async () => null),
  };
}

function createTaskProvider(): TaskRouteProvider {
  return {
    listFolders: vi.fn(async () => folders),
    getTaskSnapshot: vi.fn(async (taskId) => {
      if (taskId === "rb-child") {
        return { task: { id: "rb-child", folder_id: "folder-a-child" } };
      }
      if (taskId === "rb-b") return { task: { id: "rb-b", folder_id: "folder-b" } };
      return null;
    }),
  };
}

function createUserRepository(): DashboardUserRepository {
  const users = new Map<string, DashboardUserRecord>([
    ["admin@example.com", {
      email: "admin@example.com",
      isAdmin: true,
      allowedFolderIds: [],
    }],
    ["restricted@example.com", {
      email: "restricted@example.com",
      isAdmin: false,
      allowedFolderIds: ["folder-a"],
    }],
  ]);
  return { findUserByEmail: vi.fn(async (email) => users.get(email) ?? null) };
}

function createJwt(): AuthJwtHelper {
  return {
    issueToken: vi.fn(async () => "token"),
    verifyToken: vi.fn(async (token) => {
      if (token === "admin-token") return { email: "admin@example.com" };
      if (token === "restricted-token") return { email: "restricted@example.com" };
      return null;
    }),
  };
}

function configWith(values: Record<string, unknown>): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => values),
    requireConfig: vi.fn(async (key: string) => {
      if (!(key in values)) throw new Error(`${key} is required`);
      return values[key];
    }),
  };
}
