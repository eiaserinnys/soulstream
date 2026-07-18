import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { normalizeBoardContainerKind } from "../board-yjs/board_container_kind_compat.js";
import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  type BoardAccess,
} from "./board_access.js";

export type BoardAssetFolderRecord = {
  id: string;
  parentFolderId?: string | null;
  [key: string]: unknown;
};

export type BoardAssetBoardItemRecord = {
  itemType?: unknown;
  itemId?: unknown;
  folderId?: unknown;
  [key: string]: unknown;
};

export type BoardAssetCatalogSnapshot = {
  boardItems?: readonly BoardAssetBoardItemRecord[] | null;
};

export type BoardAssetAccess = BoardAccess;

export type BoardAssetContainerKind = "folder" | "task";

export type BoardAssetContainerTarget = {
  kind: BoardAssetContainerKind;
  id: string;
};

export type BoardAssetCommitPart = {
  partNumber: number;
  etag: string;
};

export type BoardAssetInitInput = {
  folderId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  containerKind?: BoardAssetContainerKind;
  containerId?: string;
};

export type BoardAssetCommitInput = {
  folderId: string;
  assetId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  parts: readonly BoardAssetCommitPart[];
  containerKind?: BoardAssetContainerKind;
  containerId?: string;
};

export type BoardAssetRouteProvider = {
  listFolders: () =>
    | Promise<readonly BoardAssetFolderRecord[]>
    | readonly BoardAssetFolderRecord[];
  getCatalogSnapshot: () =>
    | Promise<BoardAssetCatalogSnapshot>
    | BoardAssetCatalogSnapshot;
  initFileAsset: (input: BoardAssetInitInput) => Promise<unknown> | unknown;
  commitFileAsset: (input: BoardAssetCommitInput) => Promise<unknown> | unknown;
};

export type BoardAssetAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<BoardAssetAccess> | BoardAssetAccess;
};

export type BoardAssetRouteOptions = {
  provider: BoardAssetRouteProvider;
  accessProvider: BoardAssetAccessProvider;
};

export class BoardAssetRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "BoardAssetRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type FolderAssetParams = {
  folder_id: string;
};

type FolderAssetCommitParams = FolderAssetParams & {
  asset_id: string;
};

type ContainerAssetParams = {
  container_kind: string;
  container_id: string;
};

type ContainerAssetCommitParams = ContainerAssetParams & {
  asset_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

export const boardAssetRouteAuthRequirements = {
  "POST /api/board/:folder_id/assets/init": true,
  "POST /api/board-containers/:container_kind/:container_id/assets/init": true,
  "POST /api/board/:folder_id/assets/:asset_id/commit": true,
  "POST /api/board-containers/:container_kind/:container_id/assets/:asset_id/commit": true,
} as const;

export function registerBoardAssetRoutes(
  app: FastifyInstance,
  options: BoardAssetRouteOptions,
): void {
  app.post<{ Params: FolderAssetParams }>(
    "/api/board/:folder_id/assets/init",
    async (request, reply) => {
      const body = parseInitBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const folderId = folderAssetParams(request).folder_id;
      const accessDenied = await ensureFolderAccess(options, request, folderId);
      if (accessDenied !== undefined) return accessDenied(reply);

      try {
        const result = await options.provider.initFileAsset({
          folderId,
          name: body.value.name,
          mimeType: body.value.mime,
          byteSize: body.value.size,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendBoardAssetError(reply, error);
      }
    },
  );

  app.post<{ Params: ContainerAssetParams }>(
    "/api/board-containers/:container_kind/:container_id/assets/init",
    async (request, reply) => {
      const container = parseContainerParams(containerAssetParams(request));
      if (!container.ok) return validationError(reply, container);
      const body = parseInitBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const folderResult = await tryResolveBoardContainerFolderId(
        options.provider,
        container.value,
      );
      if (!folderResult.ok) return sendBoardAssetError(reply, folderResult.error);
      const accessDenied = await ensureFolderAccess(options, request, folderResult.value);
      if (accessDenied !== undefined) return accessDenied(reply);

      try {
        const result = await options.provider.initFileAsset({
          folderId: folderResult.value,
          name: body.value.name,
          mimeType: body.value.mime,
          byteSize: body.value.size,
          containerKind: container.value.kind,
          containerId: container.value.id,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendBoardAssetError(reply, error);
      }
    },
  );

  app.post<{ Params: FolderAssetCommitParams }>(
    "/api/board/:folder_id/assets/:asset_id/commit",
    async (request, reply) => {
      const body = parseCommitBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const params = folderAssetCommitParams(request);
      const accessDenied = await ensureFolderAccess(options, request, params.folder_id);
      if (accessDenied !== undefined) return accessDenied(reply);

      try {
        const result = await options.provider.commitFileAsset({
          folderId: params.folder_id,
          assetId: params.asset_id,
          ...body.value,
        });
        return reply.send(result);
      } catch (error) {
        return sendBoardAssetError(reply, error);
      }
    },
  );

  app.post<{ Params: ContainerAssetCommitParams }>(
    "/api/board-containers/:container_kind/:container_id/assets/:asset_id/commit",
    async (request, reply) => {
      const params = containerAssetCommitParams(request);
      const container = parseContainerParams(params);
      if (!container.ok) return validationError(reply, container);
      const body = parseCommitBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const folderResult = await tryResolveBoardContainerFolderId(
        options.provider,
        container.value,
      );
      if (!folderResult.ok) return sendBoardAssetError(reply, folderResult.error);
      const accessDenied = await ensureFolderAccess(options, request, folderResult.value);
      if (accessDenied !== undefined) return accessDenied(reply);

      try {
        const result = await options.provider.commitFileAsset({
          folderId: folderResult.value,
          assetId: params.asset_id,
          ...body.value,
          containerKind: container.value.kind,
          containerId: container.value.id,
        });
        return reply.send(result);
      } catch (error) {
        return sendBoardAssetError(reply, error);
      }
    },
  );
}

function parseInitBody(
  body: unknown,
): Validation<{ name: string; mime: string; size: number }> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const name = requiredString(object.value, "name");
  if (!name.ok) return name;
  const mime = requiredString(object.value, "mime");
  if (!mime.ok) return mime;
  const size = requiredInteger(object.value, "size");
  if (!size.ok) return size;
  return { ok: true, value: { name: name.value, mime: mime.value, size: size.value } };
}

function parseCommitBody(
  body: unknown,
): Validation<{
  x: number;
  y: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  parts: readonly BoardAssetCommitPart[];
}> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const x = requiredFiniteNumber(object.value, "x");
  if (!x.ok) return x;
  const y = requiredFiniteNumber(object.value, "y");
  if (!y.ok) return y;
  const width = optionalInteger(object.value, "width");
  if (!width.ok) return width;
  const height = optionalInteger(object.value, "height");
  if (!height.ok) return height;
  const durationSeconds = optionalFiniteNumber(object.value, "durationSeconds");
  if (!durationSeconds.ok) return durationSeconds;
  const parts = parseParts(object.value.parts);
  if (!parts.ok) return parts;

  const value: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    durationSeconds?: number;
    parts: readonly BoardAssetCommitPart[];
  } = { x: x.value, y: y.value, parts: parts.value };
  if (width.value !== undefined) value.width = width.value;
  if (height.value !== undefined) value.height = height.value;
  if (durationSeconds.value !== undefined) {
    value.durationSeconds = durationSeconds.value;
  }
  return { ok: true, value };
}

function parseParts(value: unknown): Validation<readonly BoardAssetCommitPart[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, message: "parts must be an array" };
  const parts: BoardAssetCommitPart[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, message: "parts entries must be JSON objects" };
    }
    const part = item as Record<string, unknown>;
    const partNumber = requiredInteger(part, "partNumber");
    if (!partNumber.ok) return partNumber;
    const etag = requiredString(part, "etag");
    if (!etag.ok) return etag;
    parts.push({ partNumber: partNumber.value, etag: etag.value });
  }
  return { ok: true, value: parts };
}

async function ensureFolderAccess(
  options: BoardAssetRouteOptions,
  request: FastifyRequest,
  folderId: string,
): Promise<((reply: FastifyReply) => FastifyReply) | undefined> {
  const folders = await options.provider.listFolders();
  const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
  if (!isBoardFolderAllowed(access, folders, folderId)) {
    return folderAccessDenied;
  }
  return undefined;
}

async function resolveBoardContainerFolderId(
  provider: BoardAssetRouteProvider,
  container: BoardAssetContainerTarget,
): Promise<string> {
  if (container.kind === "folder") return container.id;
  const snapshot = await provider.getCatalogSnapshot();
  const boardItems = Array.isArray(snapshot.boardItems) ? snapshot.boardItems : [];
  for (const item of boardItems) {
    if (item.itemType !== "task" || item.itemId !== container.id) continue;
    if (typeof item.folderId === "string" && item.folderId.length > 0) {
      return item.folderId;
    }
  }
  throw new BoardAssetRouteError(
    "TASK_BOARD_CONTAINER_NOT_FOUND",
    "Task board container not found",
    404,
  );
}

async function tryResolveBoardContainerFolderId(
  provider: BoardAssetRouteProvider,
  container: BoardAssetContainerTarget,
): Promise<{ ok: true; value: string } | { ok: false; error: unknown }> {
  try {
    return {
      ok: true,
      value: await resolveBoardContainerFolderId(provider, container),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

function parseContainerParams(params: ContainerAssetParams): Validation<BoardAssetContainerTarget> {
  const kind = normalizeBoardContainerKind(params.container_kind);
  if (!kind) {
    return { ok: false, message: "container_kind must be folder or task" };
  }
  if (params.container_id.length === 0) {
    return { ok: false, message: "container_id must not be empty" };
  }
  return { ok: true, value: { kind, id: params.container_id } };
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Validation<string> {
  const value = body[key];
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string` };
}

function requiredInteger(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function requiredFiniteNumber(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function optionalInteger(
  body: Record<string, unknown>,
  key: string,
): Validation<number | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value === "number" && Number.isInteger(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function optionalFiniteNumber(
  body: Record<string, unknown>,
  key: string,
): Validation<number | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function validationError<T>(
  reply: FastifyReply,
  validation: Extract<Validation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode ?? 400).send({ detail: validation.message });
}

function folderAccessDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ detail: "Folder access denied" });
}

function sendBoardAssetError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BoardAssetRouteError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("size") || detail.includes("quota")) {
    return reply.code(413).send({ detail });
  }
  return reply.code(400).send({ detail });
}

function folderAssetParams(request: FastifyRequest): FolderAssetParams {
  return request.params as FolderAssetParams;
}

function folderAssetCommitParams(request: FastifyRequest): FolderAssetCommitParams {
  return request.params as FolderAssetCommitParams;
}

function containerAssetParams(request: FastifyRequest): ContainerAssetParams {
  return request.params as ContainerAssetParams;
}

function containerAssetCommitParams(request: FastifyRequest): ContainerAssetCommitParams {
  return request.params as ContainerAssetCommitParams;
}
