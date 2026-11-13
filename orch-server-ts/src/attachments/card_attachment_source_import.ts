import { randomUUID } from "node:crypto";

import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";

import type {
  AttachmentCommitRepository,
  OwnedAttachmentCommitService,
  UploadOwner,
  UploadSpec,
} from "./attachment_commit_contract.js";
import { normalizeAttachmentLegacyPath } from "./attachment_read_service.js";
import {
  AttachmentRouteError,
  AttachmentTransportConnectionError,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "./attachment_routes.js";

export type AttachmentSourceReadFile = {
  readonly content: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
};

export type AttachmentSourceReader = (
  nodeId: string,
  path: string,
) => Promise<AttachmentSourceReadFile>;

export type CardAttachmentSourceImportInput = {
  readonly cardId: string;
  readonly sourceNodeId: string;
  readonly sourceSessionId: string;
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
};

export type CardAttachmentSourceImporter = (
  input: CardAttachmentSourceImportInput,
) => Promise<AttachmentPathBinding>;

/** Reading the original node, writing R2 and recording the alias, without touching the card row. */
export type CardAttachmentSourceStoreDeps = {
  readonly readSource: AttachmentSourceReader;
  readonly commits: Pick<OwnedAttachmentCommitService, "putSmall">;
  readonly repository: Pick<
    AttachmentCommitRepository,
    "findLegacyAliasForAsset" | "insertLegacyAlias"
  >;
};

export type CardAttachmentSourceImportDeps = CardAttachmentSourceStoreDeps & {
  readonly addCardRef: (cardId: string, attachmentId: string) => Promise<void>;
};

/** The minimal asset shape the incoming-path reuse branch checks before trusting an alias. */
export type CardAttachmentReusableAsset = {
  readonly attachmentId: string;
  readonly uploadStatus: "pending" | "committed";
  readonly registrationSessionId: string | null;
};

export type CardAttachmentPrepareDeps = CardAttachmentSourceStoreDeps & {
  readonly findAsset: (attachmentId: string) => Promise<CardAttachmentReusableAsset | null>;
};

export type CardAttachmentPrepareInput = {
  readonly cardId: string;
  readonly owner: UploadOwner;
  readonly sourceNodeId: string;
  readonly sourceSessionId: string;
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
};

export type CardAttachmentPrepared = {
  readonly attachmentId: string;
  readonly nodeId: string;
  readonly path: string;
};

export type CardAttachmentPreparer = (
  input: CardAttachmentPrepareInput,
) => Promise<CardAttachmentPrepared>;

/**
 * Raised when a foreign-node attachment cannot be brought into the card's
 * central scope. The code matches the orchestration worker's NODE_REJECTED
 * branch so the card is blocked with the daily-language reason instead of
 * silently retrying, and no session is created.
 */
export class CardAttachmentSourceImportError extends Error {
  readonly code = "NODE_REJECTED";
  readonly statusCode: number;

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = "CardAttachmentSourceImportError";
    this.statusCode = statusCode;
  }
}

export function createCardAttachmentSourceImport(
  deps: CardAttachmentSourceImportDeps,
): CardAttachmentSourceImporter {
  return async (input) => {
    const normalizedPath = normalizeAttachmentLegacyPath(input.path);
    const existing = await deps.repository.findLegacyAliasForAsset(
      input.sourceNodeId,
      normalizedPath,
    );
    if (existing !== null) {
      if (existing.availability !== "resolved" || existing.assetId === null) {
        throw new CardAttachmentSourceImportError(sourceMissingMessage(input), 404);
      }
      return bindingFor(existing.assetId, input);
    }

    const file = await readSourceOrFail(deps, input);
    const committed = await deps.commits.putSmall({
      spec: uploadSpec(input, { kind: "agent_session", key: input.sourceSessionId }, file),
      body: file.content,
    });

    await deps.addCardRef(input.cardId, committed.attachmentId);

    const assetId = await registerAlias(deps.repository, input, normalizedPath, committed.attachmentId);
    return bindingFor(assetId, input);
  };
}

/**
 * Prepares one path attachment before the card row exists: reuse a resolved
 * alias, reuse an asset the node already materialized into its incoming cache,
 * or read the original node and commit the bytes to R2. Either way a resolved
 * alias is left behind, so card creation and later runs share one path.
 */
export function createCardAttachmentPreparer(
  deps: CardAttachmentPrepareDeps,
): CardAttachmentPreparer {
  return async (input) => {
    const normalizedPath = normalizeAttachmentLegacyPath(input.path);
    const existing = await deps.repository.findLegacyAliasForAsset(
      input.sourceNodeId,
      normalizedPath,
    );
    if (existing !== null) {
      if (existing.availability !== "resolved" || existing.assetId === null) {
        throw new CardAttachmentSourceImportError(sourceMissingMessage(input), 404);
      }
      return preparedFor(existing.assetId, input);
    }

    const materialized = await reusableMaterializedAsset(deps, input, normalizedPath);
    if (materialized !== null) return preparedFor(materialized, input);

    const file = await readSourceOrFail(deps, input);
    const committed = await deps.commits.putSmall({
      spec: uploadSpec(input, input.owner, file),
      body: file.content,
    });
    return preparedFor(
      await registerAlias(deps.repository, input, normalizedPath, committed.attachmentId),
      input,
    );
  };
}

// Node materializer cache shape: <incoming>/<session id>/assets/<asset id>/<name>.
const MATERIALIZED_ASSET_PATH = /(?:^|\/)incoming\/([^/]+)\/assets\/([^/]+)\//;

/**
 * A user upload already committed to R2 is materialized under the session's
 * incoming folder, which sits outside the node's allowed read roots. When the
 * path names that session's own committed asset, reuse it instead of asking the
 * node to read a file it copied from us.
 */
async function reusableMaterializedAsset(
  deps: CardAttachmentPrepareDeps,
  input: CardAttachmentPrepareInput,
  normalizedPath: string,
): Promise<string | null> {
  const match = MATERIALIZED_ASSET_PATH.exec(normalizedPath);
  if (match === null) return null;
  const sessionId = match[1]!;
  const assetId = match[2]!;
  const asset = await deps.findAsset(assetId);
  if (
    asset === null
    || asset.uploadStatus !== "committed"
    || asset.registrationSessionId !== sessionId
  ) {
    return null;
  }
  return registerAlias(deps.repository, input, normalizedPath, asset.attachmentId);
}

async function registerAlias(
  repository: CardAttachmentSourceStoreDeps["repository"],
  input: { readonly sourceNodeId: string; readonly path: string; readonly name: string },
  normalizedPath: string,
  assetId: string,
): Promise<string> {
  const inserted = await repository.insertLegacyAlias({
    nodeId: input.sourceNodeId,
    normalizedPath,
    assetId,
    originalPath: input.path,
  });
  if (inserted !== null) return assetId;
  const winner = await repository.findLegacyAliasForAsset(input.sourceNodeId, normalizedPath);
  if (winner !== null && winner.availability === "resolved" && winner.assetId !== null) {
    return winner.assetId;
  }
  throw new CardAttachmentSourceImportError(
    `${prefix(input)}첨부를 중앙에 등록하지 못했습니다. 다시 실행하세요.`,
    409,
  );
}

function uploadSpec(
  input: { readonly cardId: string; readonly sourceNodeId: string; readonly sourceSessionId: string; readonly name: string; readonly mimeType: string },
  owner: UploadOwner,
  file: AttachmentSourceReadFile,
): UploadSpec {
  return {
    attachmentId: randomUUID(),
    owner,
    registration: {
      registrationScope: { type: "card", id: input.cardId },
      sourceNodeId: input.sourceNodeId,
      sourceSessionId: input.sourceSessionId,
      outputCommandId: null,
    },
    originalName: input.name.length > 0 ? input.name : file.filename,
    mimeType: input.mimeType.length > 0 ? input.mimeType : file.contentType || "application/octet-stream",
    byteSize: file.content.byteLength,
  };
}

function bindingFor(
  attachmentId: string,
  input: CardAttachmentSourceImportInput,
): AttachmentPathBinding {
  return {
    attachment_id: attachmentId,
    node_id: input.sourceNodeId,
    path: input.path,
  };
}

function preparedFor(
  attachmentId: string,
  input: CardAttachmentPrepareInput,
): CardAttachmentPrepared {
  return {
    attachmentId,
    nodeId: input.sourceNodeId,
    path: input.path,
  };
}

async function readSourceOrFail(
  deps: Pick<CardAttachmentSourceStoreDeps, "readSource">,
  input: { readonly sourceNodeId: string; readonly path: string; readonly name: string },
): Promise<AttachmentSourceReadFile> {
  let file: AttachmentSourceReadFile;
  try {
    file = await deps.readSource(input.sourceNodeId, input.path);
  } catch (error) {
    throw importFailure(input, error);
  }

  if (
    !Number.isSafeInteger(file.size)
    || file.size < 0
    || file.size > MAX_ATTACHMENT_SIZE_BYTES
    || file.content.byteLength !== file.size
  ) {
    throw new CardAttachmentSourceImportError(
      `${prefix(input)}원본 노드가 파일을 올바르게 돌려주지 않았습니다. 다시 실행하세요.`,
      502,
    );
  }
  return file;
}

function importFailure(
  input: { readonly sourceNodeId: string; readonly name: string },
  error: unknown,
): CardAttachmentSourceImportError {
  if (error instanceof CardAttachmentSourceImportError) return error;
  if (error instanceof AttachmentTransportConnectionError) {
    return new CardAttachmentSourceImportError(
      `${prefix(input)}노드가 연결되어 있지 않습니다. 노드가 켜진 뒤 다시 실행하세요.`,
      503,
    );
  }
  if (error instanceof AttachmentRouteError) {
    if (error.statusCode === 404) {
      return new CardAttachmentSourceImportError(
        `${prefix(input)}파일을 찾을 수 없습니다.`,
        404,
      );
    }
    if (error.statusCode === 413) {
      return new CardAttachmentSourceImportError(
        `${prefix(input)}파일이 너무 큽니다. 100MiB 이하만 가져올 수 있습니다.`,
        413,
      );
    }
    if (error.statusCode === 501) {
      return new CardAttachmentSourceImportError(
        `${prefix(input)}원본 노드가 다른 노드의 첨부를 읽는 기능을 지원하지 않습니다. 노드를 최신 버전으로 올린 뒤 다시 실행하세요.`,
        501,
      );
    }
    if (error.statusCode === 400) {
      return new CardAttachmentSourceImportError(
        `${prefix(input)}${error.message}`,
        400,
      );
    }
  }
  return new CardAttachmentSourceImportError(
    `${prefix(input)}원본 노드에서 파일을 가져오지 못했습니다. 다시 실행하세요.`,
    502,
  );
}

function prefix(input: { readonly sourceNodeId: string; readonly name: string }): string {
  return `첨부 "${input.name}"을 노드 ${input.sourceNodeId}에서 가져오지 못했습니다: `;
}

function sourceMissingMessage(input: { readonly sourceNodeId: string; readonly name: string }): string {
  return `${prefix(input)}파일을 찾을 수 없습니다.`;
}
