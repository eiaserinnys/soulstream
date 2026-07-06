import type { BoardYjsContainerRef, SessionDB } from "./db/session_db.js";

export interface SessionFolderFallbackDeps {
  db: Pick<
    SessionDB,
    "getSession" | "ensureBoardItems" | "getBoardItems" | "resolveBoardYjsContainerScope"
  >;
  logger: {
    warn(obj: unknown, msg: string): void;
  };
}

export interface DelegatedContainerRef {
  kind: "folder" | "runbook";
  id: string;
}

export interface ResolvedDelegatedContainer {
  folderId: string | null;
  container: BoardYjsContainerRef | null;
}

export function hasExplicitFolderId<T extends { folderId?: string | null }>(
  params: T,
): boolean {
  return Object.prototype.hasOwnProperty.call(params, "folderId")
    && params.folderId !== undefined;
}

export async function getCallerSessionFolderId(
  deps: SessionFolderFallbackDeps,
  callerSessionId: string,
): Promise<string | null> {
  try {
    const row = await deps.db.getSession(callerSessionId);
    return row?.folder_id ?? null;
  } catch (err) {
    deps.logger.warn(
      { err, callerSessionId },
      "caller session folder lookup failed",
    );
    return null;
  }
}

export async function resolveDelegatedFolderId(
  deps: SessionFolderFallbackDeps,
  params: {
    callerSessionId: string;
    folderId?: string | null;
  },
): Promise<string | null> {
  const resolved = await resolveDelegatedContainer(deps, params);
  return resolved.folderId;
}

export async function resolveDelegatedContainer(
  deps: SessionFolderFallbackDeps,
  params: {
    callerSessionId?: string | null;
    folderId?: string | null;
    container?: DelegatedContainerRef | null;
  },
): Promise<ResolvedDelegatedContainer> {
  if (params.container) {
    const container = toBoardYjsContainer(params.container);
    if (container.containerKind === "folder") {
      return { folderId: container.containerId, container };
    }
    try {
      const scope = await deps.db.resolveBoardYjsContainerScope(container);
      return { folderId: scope?.folderId ?? null, container };
    } catch (err) {
      deps.logger.warn({ err, container }, "delegated container scope lookup failed");
      return { folderId: null, container };
    }
  }

  if (hasExplicitFolderId(params)) {
    const folderId = params.folderId ?? null;
    return {
      folderId,
      container: folderId ? { containerKind: "folder", containerId: folderId } : null,
    };
  }

  if (!params.callerSessionId) {
    return { folderId: null, container: null };
  }

  const callerContainer = await getCallerSessionPrimaryContainer(deps, params.callerSessionId);
  if (callerContainer?.containerKind === "runbook") {
    try {
      const scope = await deps.db.resolveBoardYjsContainerScope(callerContainer);
      return { folderId: scope?.folderId ?? null, container: callerContainer };
    } catch (err) {
      deps.logger.warn(
        { err, callerSessionId: params.callerSessionId, container: callerContainer },
        "caller delegated container scope lookup failed",
      );
    }
  }

  const folderId = await getCallerSessionFolderId(deps, params.callerSessionId);
  return {
    folderId,
    container: folderId ? { containerKind: "folder", containerId: folderId } : null,
  };
}

async function getCallerSessionPrimaryContainer(
  deps: SessionFolderFallbackDeps,
  callerSessionId: string,
): Promise<BoardYjsContainerRef | null> {
  try {
    await deps.db.ensureBoardItems();
    const item = (await deps.db.getBoardItems()).find((candidate) =>
      candidate.itemType === "session" &&
      candidate.itemId === callerSessionId &&
      (candidate.membershipKind ?? "primary") === "primary"
    );
    if (!item) return null;
    return {
      containerKind: item.containerKind ?? "folder",
      containerId: item.containerId ?? item.folderId,
    };
  } catch (err) {
    deps.logger.warn({ err, callerSessionId }, "caller session board container lookup failed");
    return null;
  }
}

function toBoardYjsContainer(container: DelegatedContainerRef): BoardYjsContainerRef {
  return {
    containerKind: container.kind,
    containerId: container.id,
  };
}
