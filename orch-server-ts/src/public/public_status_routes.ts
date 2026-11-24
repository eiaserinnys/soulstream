import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  normalizeBoardAccess,
  visibleBoardFolderIds,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";
import type { PublicDatabaseSchemaProvider } from "./database_schema_provider.js";

export type PublicStatusRouteConfig = {
  nodeName?: string | null;
  authEnabled: boolean;
  atomEnabled: boolean;
  atomPublicUrl?: string | null;
};

export type PublicStatusRouteConfigProvider = {
  getConfig: () => PublicStatusRouteConfig | Promise<PublicStatusRouteConfig>;
};

export type PublicStatusFolderCounts =
  | ReadonlyMap<string | null, number>
  | Record<string, number>;

export type PublicStatusFolderCountsProvider = {
  getFolderCounts: () => PublicStatusFolderCounts | Promise<PublicStatusFolderCounts>;
  listFolders: () =>
    | readonly BoardAccessFolderRecord[]
    | Promise<readonly BoardAccessFolderRecord[]>;
  resolveAccess: (
    request: FastifyRequest,
  ) => BoardAccess | Promise<BoardAccess>;
};

export type PublicStatusRouteOptions = {
  configProvider: PublicStatusRouteConfigProvider;
  folderCountsProvider: PublicStatusFolderCountsProvider;
  databaseSchemaProvider?: PublicDatabaseSchemaProvider;
  startTimeSeconds?: number;
  nowSeconds?: () => number;
  healthVersion?: string;
  lifecycle?: {
    snapshot(): {
      healthy: boolean;
      ready: boolean;
      draining: boolean;
      instance_id: string;
      build_id: string;
      process_build_id: string;
    } | Promise<{
      healthy: boolean;
      ready: boolean;
      draining: boolean;
      instance_id: string;
      build_id: string;
      process_build_id: string;
    }>;
  };
};

export const publicStatusRouteAuthRequirements = {
  "GET /api/health": false,
  "GET /api/config": false,
  "GET /api/status": true,
  "GET /api/sessions/folder-counts": true,
} as const;

export function registerPublicStatusRoutes(
  app: FastifyInstance,
  options: PublicStatusRouteOptions,
): void {
  const startTimeSeconds = options.startTimeSeconds ?? currentSeconds();
  const nowSeconds = options.nowSeconds ?? currentSeconds;
  const healthVersion = options.healthVersion ?? "0.1.0";

  app.get("/api/health", async () => {
    const databaseSchema = options.databaseSchemaProvider === undefined
      ? undefined
      : await options.databaseSchemaProvider.getDatabaseSchema();
    return {
      status: "ok",
      version: healthVersion,
      ...(await options.lifecycle?.snapshot()),
      uptime_seconds: Math.max(0, Math.trunc(nowSeconds() - startTimeSeconds)),
      ...(databaseSchema === undefined ? {} : { database_schema: databaseSchema }),
    };
  });

  app.get("/api/config", async () => {
    const config = await options.configProvider.getConfig();
    return {
      mode: "orchestrator",
      nodeId: config.nodeName ?? null,
      auth: { enabled: config.authEnabled },
      features: {
        configModal: true,
        searchModal: true,
        nodePanel: true,
        nodeGuard: false,
      },
    };
  });

  app.get("/api/status", async () => {
    const config = await options.configProvider.getConfig();
    const lifecycle = await options.lifecycle?.snapshot();
    return {
      is_draining: lifecycle?.draining ?? false,
      healthy: lifecycle?.healthy ?? true,
      atom_enabled: config.atomEnabled,
      atom_public_url: config.atomPublicUrl ?? null,
    };
  });

  app.get("/api/sessions/folder-counts", async (request) => {
    let counts = folderCountEntries(await options.folderCountsProvider.getFolderCounts());
    const access = normalizeBoardAccess(
      await options.folderCountsProvider.resolveAccess(request),
    );
    if (access.restricted) {
      const folders = await options.folderCountsProvider.listFolders();
      const visible = visibleBoardFolderIds(access, folders);
      counts = counts.filter(([folderId]) => (
        typeof folderId === "string" && visible.has(folderId)
      ));
    }
    return { counts: serializeFolderCounts(counts) };
  });
}

function currentSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function folderCountEntries(
  counts: PublicStatusFolderCounts,
): Array<[string | null, number]> {
  if (counts instanceof Map) return [...counts.entries()];
  return Object.entries(counts);
}

function serializeFolderCounts(
  counts: ReadonlyArray<[string | null, number]>,
): Record<string, number> {
  return Object.fromEntries(
    counts.map(([folderId, count]) => [folderId === null ? "null" : folderId, count]),
  );
}
