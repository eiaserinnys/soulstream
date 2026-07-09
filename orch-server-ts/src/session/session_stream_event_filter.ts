import type { FastifyRequest } from "fastify";

import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";
import type { SessionStreamEvent } from "../sse/replay_broadcaster.js";
import type {
  SessionResourceAccessProvider,
  SessionResourceAccessRepository,
} from "./session_resource_access.js";

export type SessionStreamEventFilterContext = {
  readonly feedOnly?: boolean;
};

export type SessionStreamEventFilter = (
  request: FastifyRequest,
  event: SessionStreamEvent,
  context?: SessionStreamEventFilterContext,
) => Promise<SessionStreamEvent | null>;

export type CreateSessionStreamEventFilterOptions = {
  readonly accessProvider: Pick<SessionResourceAccessProvider, "resolveAccess">;
  readonly repository: SessionResourceAccessRepository;
};

export function createSessionStreamEventFilter(
  options: CreateSessionStreamEventFilterOptions,
): SessionStreamEventFilter {
  return async (request, event, context = {}) => {
    const feedOnly = context.feedOnly ?? queryBool(request.query, "feed_only");
    const access = normalizeBoardAccess(
      await options.accessProvider.resolveAccess({ request }),
    );
    if (!access.restricted && !feedOnly) return event;

    if (event.type === "catalog_updated") {
      return filterCatalogUpdatedEvent(event, access, feedOnly, options.repository);
    }

    if (event.type === "session_created" || event.type === "session_updated") {
      return filterSessionUpsertEvent(event, access, feedOnly, options.repository);
    }

    if (event.type === "session_deleted") {
      return filterSessionDeletedEvent(event, access, feedOnly, options.repository);
    }

    return event;
  };
}

async function filterCatalogUpdatedEvent(
  event: SessionStreamEvent,
  access: Required<BoardAccess>,
  feedOnly: boolean,
  repository: SessionResourceAccessRepository,
): Promise<SessionStreamEvent> {
  const catalog = isRecord(event.catalog) ? event.catalog : {};
  const catalogFolders = Array.isArray(catalog.folders)
    ? catalog.folders
    : await repository.listFoldersForAccess();
  const folderRecords = folderAccessRecords(catalogFolders);
  const sessions = isRecord(catalog.sessions) ? catalog.sessions : {};
  const scopedFolders = access.restricted
    ? filterFoldersForAccess(access, catalogFolders)
    : catalogFolders;
  let scopedSessions = access.restricted
    ? filterSessionAssignmentsForAccess(access, folderRecords, sessions)
    : sessions;
  if (feedOnly) {
    scopedSessions = filterFeedSessionAssignments(catalogFolders, scopedSessions);
  }
  return {
    ...event,
    catalog: {
      ...catalog,
      folders: scopedFolders,
      sessions: scopedSessions,
    },
  };
}

async function filterSessionUpsertEvent(
  event: SessionStreamEvent,
  access: Required<BoardAccess>,
  feedOnly: boolean,
  repository: SessionResourceAccessRepository,
): Promise<SessionStreamEvent | null> {
  const session = isRecord(event.session) ? event.session : event;
  let folderId =
    stringOrNull(event.folder_id) ??
    stringOrNull(event.folderId) ??
    stringOrNull(session.folder_id) ??
    stringOrNull(session.folderId);
  let sessionType =
    stringOrNull(event.session_type) ??
    stringOrNull(event.sessionType) ??
    stringOrNull(session.session_type) ??
    stringOrNull(session.sessionType);
  const sessionId =
    stringOrNull(event.agent_session_id) ??
    stringOrNull(event.agentSessionId) ??
    stringOrNull(session.agent_session_id) ??
    stringOrNull(session.agentSessionId);

  if (
    sessionId !== null &&
    ((access.restricted && folderId === null) ||
      (feedOnly && (folderId === null || sessionType === null)))
  ) {
    const row = await repository.getSessionAccessRecord(sessionId);
    if (row !== null) {
      folderId = row.folderId;
      sessionType = row.sessionType ?? null;
    }
  }

  const folders = await repository.listFoldersForAccess();
  if (access.restricted && !isBoardFolderAllowed(access, folders, folderId)) {
    return null;
  }
  if (feedOnly && (folderExcludesFeed(folders, folderId) || sessionType === "llm")) {
    return null;
  }
  return event;
}

async function filterSessionDeletedEvent(
  event: SessionStreamEvent,
  access: Required<BoardAccess>,
  feedOnly: boolean,
  repository: SessionResourceAccessRepository,
): Promise<SessionStreamEvent | null> {
  const sessionId =
    stringOrNull(event.agent_session_id) ?? stringOrNull(event.agentSessionId);
  if (sessionId === null) return null;

  const row = await repository.getSessionAccessRecord(sessionId);
  if (row === null) return access.restricted ? null : event;

  const folders = await repository.listFoldersForAccess();
  if (access.restricted && !isBoardFolderAllowed(access, folders, row.folderId)) {
    return null;
  }
  if (
    feedOnly &&
    (folderExcludesFeed(folders, row.folderId) || row.sessionType === "llm")
  ) {
    return null;
  }
  return event;
}

function filterFoldersForAccess<T>(
  access: Required<BoardAccess>,
  folders: readonly T[],
): T[] {
  const records = folderAccessRecords(folders);
  return folders.filter((folder) => {
    const id = folderId(folder);
    return id !== null && isBoardFolderAllowed(access, records, id);
  });
}

function filterSessionAssignmentsForAccess(
  access: Required<BoardAccess>,
  folders: readonly BoardAccessFolderRecord[],
  sessions: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sessions).filter(([, assignment]) =>
      isBoardFolderAllowed(access, folders, assignmentFolderId(assignment))
    ),
  );
}

function filterFeedSessionAssignments(
  folders: readonly unknown[],
  sessions: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sessions).filter(([, assignment]) =>
      !folderExcludesFeed(folders, assignmentFolderId(assignment))
    ),
  );
}

function folderExcludesFeed(folders: readonly unknown[], folderId: string | null): boolean {
  if (folderId === null) return false;
  const folder = folders.find((item) => folderIdFromRecord(item) === folderId);
  if (!isRecord(folder)) return false;
  const settings = folder.settings;
  return isRecord(settings) && settings.excludeFromFeed === true;
}

function folderAccessRecords(folders: readonly unknown[]): BoardAccessFolderRecord[] {
  return folders.flatMap((folder) => {
    const id = folderIdFromRecord(folder);
    if (id === null) return [];
    return [{
      id,
      parentFolderId: parentFolderIdFromRecord(folder),
      settings: isRecord(folder) ? folder.settings : undefined,
    }];
  });
}

function folderId(value: unknown): string | null {
  return folderIdFromRecord(value);
}

function folderIdFromRecord(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return stringOrNull(value.id);
}

function parentFolderIdFromRecord(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return stringOrNull(value.parentFolderId) ?? stringOrNull(value.parent_folder_id);
}

function assignmentFolderId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return stringOrNull(value.folderId) ?? stringOrNull(value.folder_id);
}

function queryBool(query: unknown, key: string): boolean {
  if (typeof query !== "object" || query === null || !(key in query)) return false;
  const value = (query as Record<string, unknown>)[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
