import type { FastifyInstance, FastifyRequest } from "fastify";

export type PublicStatusRouteConfig = {
  nodeName?: string | null;
  authEnabled: boolean;
  atomEnabled: boolean;
};

export type PublicStatusRouteConfigProvider = {
  getConfig: () => PublicStatusRouteConfig | Promise<PublicStatusRouteConfig>;
};

export type PublicStatusFolderAccess = {
  restricted: boolean;
  allowedFolderIds?: readonly string[];
};

export type PublicStatusFolderRecord = {
  id: string;
  parentFolderId?: string | null;
};

export type PublicStatusFolderCounts =
  | ReadonlyMap<string | null, number>
  | Record<string, number>;

export type PublicStatusFolderCountsProvider = {
  getFolderCounts: () => PublicStatusFolderCounts | Promise<PublicStatusFolderCounts>;
  listFolders: () =>
    | readonly PublicStatusFolderRecord[]
    | Promise<readonly PublicStatusFolderRecord[]>;
  resolveAccess: (
    request: FastifyRequest,
  ) => PublicStatusFolderAccess | Promise<PublicStatusFolderAccess>;
};

export type PublicStatusRouteOptions = {
  configProvider: PublicStatusRouteConfigProvider;
  folderCountsProvider: PublicStatusFolderCountsProvider;
  startTimeSeconds?: number;
  nowSeconds?: () => number;
  healthVersion?: string;
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

  app.get("/api/health", async () => ({
    status: "ok",
    version: healthVersion,
    uptime_seconds: Math.max(0, Math.trunc(nowSeconds() - startTimeSeconds)),
  }));

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
    return {
      is_draining: false,
      healthy: true,
      atom_enabled: config.atomEnabled,
    };
  });

  app.get("/api/sessions/folder-counts", async (request) => {
    let counts = folderCountEntries(await options.folderCountsProvider.getFolderCounts());
    const access = normalizeAccess(
      await options.folderCountsProvider.resolveAccess(request),
    );
    if (access.restricted) {
      const folders = await options.folderCountsProvider.listFolders();
      const visible = visibleFolderIds(access, folders);
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

function normalizeAccess(
  access: PublicStatusFolderAccess,
): Required<PublicStatusFolderAccess> {
  return {
    restricted: access.restricted,
    allowedFolderIds: [...(access.allowedFolderIds ?? [])],
  };
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

function visibleFolderIds(
  access: Required<PublicStatusFolderAccess>,
  folders: readonly PublicStatusFolderRecord[],
): Set<string> {
  const knownIds = new Set<string>();
  const byParent = new Map<string | null, string[]>();
  for (const folder of folders) {
    knownIds.add(folder.id);
    const parentId =
      typeof folder.parentFolderId === "string" ? folder.parentFolderId : null;
    const children = byParent.get(parentId) ?? [];
    children.push(folder.id);
    byParent.set(parentId, children);
  }

  const visible = new Set<string>();
  const stack = access.allowedFolderIds.filter((folderId) => knownIds.has(folderId));
  while (stack.length > 0) {
    const folderId = stack.pop();
    if (folderId === undefined || visible.has(folderId)) continue;
    visible.add(folderId);
    stack.push(...(byParent.get(folderId) ?? []));
  }
  return visible;
}
