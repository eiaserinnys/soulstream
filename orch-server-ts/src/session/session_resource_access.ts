import type { ServiceCaller } from "../auth/service_caller.js";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  visibleBoardFolderIds,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";

export type SessionAccessResolveContext = {
  readonly accessEmail?: string | null;
};

export type SessionAccessPolicyProvider = {
  readonly resolveAccess: (
    request: FastifyRequest | ServiceCaller,
    context?: SessionAccessResolveContext,
  ) => BoardAccess | Promise<BoardAccess>;
};

export type SessionAccessRecord = {
  readonly sessionId: string;
  readonly folderId: string | null;
  readonly sessionType?: string | null;
};

export type SessionResourceAccessRepository = {
  readonly getSessionAccessRecord: (
    sessionId: string,
  ) => Promise<SessionAccessRecord | null>;
  readonly listFoldersForAccess: () => Promise<readonly BoardAccessFolderRecord[]>;
  readonly listFoldersForSearchAccess?: (
    statementTimeoutMs: number,
  ) => Promise<readonly BoardAccessFolderRecord[]>;
};

export type SessionResourceAccessInput = {
  readonly request: FastifyRequest | ServiceCaller;
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

/**
 * The session folder check the session HTTP route handlers need. Route options
 * accept this narrow surface so production can wrap the provider with a
 * service-bearer bypass without changing the provider used elsewhere.
 */
export type SessionRequestAccessGuard = {
  readonly requireSessionAccess: (
    input: SessionResourceSessionAccessInput,
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

/**
 * Runs the session folder ACL at an HTTP handler entry. Returns true when the
 * denial response was sent and the caller must return `reply`; false lets the
 * handler continue. The result is a boolean, not the reply, because Fastify's
 * Reply is a thenable and `await` on it would resolve to undefined.
 *
 * Route handlers use this; the shared intervention body does not, because MCP
 * calls it as the service caller.
 */
export async function requireRequestSessionAccess(
  accessProvider: SessionRequestAccessGuard | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
): Promise<boolean> {
  if (accessProvider === undefined) return false;
  try {
    await accessProvider.requireSessionAccess({ request, sessionId });
  } catch (error) {
    if (!(error instanceof SessionResourceAccessError)) throw error;
    reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return true;
  }
  return false;
}

export function firstAllowedSessionFolderId(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
): string | null {
  if (!access.restricted) return null;
  const visible = visibleBoardFolderIds(access, folders);
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
