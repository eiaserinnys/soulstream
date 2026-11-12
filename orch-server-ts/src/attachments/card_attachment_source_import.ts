import { randomUUID } from "node:crypto";

import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";

import type {
  AttachmentCommitRepository,
  OwnedAttachmentCommitService,
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

export type CardAttachmentSourceImportDeps = {
  readonly readSource: AttachmentSourceReader;
  readonly commits: Pick<OwnedAttachmentCommitService, "putSmall">;
  readonly repository: Pick<
    AttachmentCommitRepository,
    "findLegacyAliasForAsset" | "insertLegacyAlias"
  >;
  readonly addCardRef: (cardId: string, attachmentId: string) => Promise<void>;
};

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
      spec: uploadSpec(input, file),
      body: file.content,
    });

    await deps.addCardRef(input.cardId, committed.attachmentId);

    const inserted = await deps.repository.insertLegacyAlias({
      nodeId: input.sourceNodeId,
      normalizedPath,
      assetId: committed.attachmentId,
      originalPath: input.path,
    });
    if (inserted === null) {
      const winner = await deps.repository.findLegacyAliasForAsset(
        input.sourceNodeId,
        normalizedPath,
      );
      if (winner !== null && winner.availability === "resolved" && winner.assetId !== null) {
        return bindingFor(winner.assetId, input);
      }
      throw new CardAttachmentSourceImportError(
        `${prefix(input)}첨부를 중앙에 등록하지 못했습니다. 다시 실행하세요.`,
        409,
      );
    }
    return bindingFor(committed.attachmentId, input);
  };
}

function uploadSpec(
  input: CardAttachmentSourceImportInput,
  file: AttachmentSourceReadFile,
): UploadSpec {
  return {
    attachmentId: randomUUID(),
    owner: { kind: "agent_session", key: input.sourceSessionId },
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

async function readSourceOrFail(
  deps: CardAttachmentSourceImportDeps,
  input: CardAttachmentSourceImportInput,
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
  input: CardAttachmentSourceImportInput,
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

function prefix(input: CardAttachmentSourceImportInput): string {
  return `첨부 "${input.name}"을 노드 ${input.sourceNodeId}에서 가져오지 못했습니다: `;
}

function sourceMissingMessage(input: CardAttachmentSourceImportInput): string {
  return `${prefix(input)}파일을 찾을 수 없습니다.`;
}
