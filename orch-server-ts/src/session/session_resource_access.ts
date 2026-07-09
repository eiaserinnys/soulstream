import type { FastifyRequest } from "fastify";

import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";

export type SessionAccessResolveContext = {
  readonly accessEmail?: string | null;
};

export type SessionAccessPolicyProvider = {
  readonly resolveAccess: (
    request: FastifyRequest,
    context?: SessionAccessResolveContext,
  ) => BoardAccess | Promise<BoardAccess>;
};

export type SessionAccessRecord = {
  readonly sessionId: string;
  readonly folderId: string | null;
};

export type SessionResourceAccessRepository = {
  readonly getSessionAccessRecord: (
    sessionId: string,
  ) => Promise<SessionAccessRecord | null>;
  readonly listFoldersForAccess: () => Promise<readonly BoardAccessFolderRecord[]>;
};

export type SessionResourceAccessInput = {
  readonly request: FastifyRequest;
  readonly accessEmail?: string | null;
};

export type SessionResourceSessionAccessInput = SessionResourceAccessInput & {
  readonly sessionId: string;
};

export type SessionResourceFolderAccessInput = SessionResourceAccessInput & {
  readonly folderId: string | null;
};

export type SessionResourceAccessProvider = {
  readonly resolveAccess: (
    input: SessionResourceAccessInput,
  ) => Promise<Required<BoardAccess>>;
  readonly requireSessionAccess: (
    input: SessionResourceSessionAccessInput,
  ) => Promise<void>;
  readonly requireFolderAccess: (
    input: SessionResourceFolderAccessInput,
  ) => Promise<void>;
};

export type CreateSessionResourceAccessProviderOptions = {
  readonly accessProvider: SessionAccessPolicyProvider;
  readonly repository: SessionResourceAccessRepository;
};

export class SessionResourceAccessError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SessionResourceAccessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createSessionResourceAccessProvider(
  options: CreateSessionResourceAccessProviderOptions,
): SessionResourceAccessProvider {
  return {
    async resolveAccess(input) {
      return normalizeBoardAccess(
        await options.accessProvider.resolveAccess(input.request, {
          accessEmail: input.accessEmail,
        }),
      );
    },
    async requireSessionAccess(input) {
      const access = normalizeBoardAccess(
        await options.accessProvider.resolveAccess(input.request, {
          accessEmail: input.accessEmail,
        }),
      );
      if (!access.restricted) return;

      const session = await options.repository.getSessionAccessRecord(input.sessionId);
      if (session === null) {
        throw new SessionResourceAccessError(
          "SESSION_NOT_FOUND",
          "Session not found",
          404,
        );
      }
      const folders = await options.repository.listFoldersForAccess();
      requireAllowedFolder(access, folders, session.folderId);
    },
    async requireFolderAccess(input) {
      const access = normalizeBoardAccess(
        await options.accessProvider.resolveAccess(input.request, {
          accessEmail: input.accessEmail,
        }),
      );
      if (!access.restricted) return;
      const folders = await options.repository.listFoldersForAccess();
      requireAllowedFolder(access, folders, input.folderId);
    },
  };
}

export function firstAllowedSessionFolderId(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
): string | null {
  if (!access.restricted) return null;
  const visible = visibleFolderIdSet(access, folders);
  for (const folderId of access.allowedFolderIds) {
    if (visible.has(folderId)) return folderId;
  }
  for (const folder of folders) {
    if (visible.has(folder.id)) return folder.id;
  }
  return null;
}

function requireAllowedFolder(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
  folderId: string | null,
): void {
  if (!isBoardFolderAllowed(access, folders, folderId)) {
    throw new SessionResourceAccessError(
      "SESSION_ACCESS_DENIED",
      "Folder access denied",
      403,
    );
  }
}

function visibleFolderIdSet(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
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
