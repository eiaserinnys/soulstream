import type { AttachmentScope } from "@soulstream/wire-schema/attachments";

import {
  AttachmentReadError,
  createAttachmentReadService,
  type AttachmentReadActor,
  type AttachmentReadRepository,
  type AttachmentReadStorageBinding,
  type AttachmentReadService,
} from "./attachment_read_service.js";
import {
  type WorkerAttachmentReadInput,
  createWorkerAttachmentAccess,
} from "./worker_attachment_access.js";

export type WorkerAttachmentRead = {
  readonly metadata: (input: WorkerAttachmentReadInput) => Promise<{
    readonly descriptor: import("@soulstream/wire-schema/attachments").AttachmentDescriptor;
    readonly upload_status: "pending" | "committed";
  }>;
  readonly content: (input: WorkerAttachmentReadInput, signal?: AbortSignal) => Promise<Response>;
};

export type CreateWorkerAttachmentReadOptions = {
  readonly access: ReturnType<typeof createWorkerAttachmentAccess>;
  readonly repository: AttachmentReadRepository;
  readonly resolveReadStorage: () => Promise<AttachmentReadStorageBinding | null>;
};

export function createWorkerAttachmentRead(
  options: CreateWorkerAttachmentReadOptions,
): WorkerAttachmentRead {
  return {
    async metadata(input) {
      const { service, actor, scope, id } = await prepareRead(options, input);
      return service.metadata(actor, id, scope);
    },
    async content(input, signal) {
      const { service, actor, scope, id } = await prepareRead(options, input);
      return service.content(actor, id, scope, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}

async function prepareRead(
  options: CreateWorkerAttachmentReadOptions,
  input: WorkerAttachmentReadInput,
): Promise<{
  readonly service: AttachmentReadService;
  readonly actor: AttachmentReadActor;
  readonly scope: AttachmentScope;
  readonly id: string;
}> {
  const asset = await options.repository.getAsset(input.attachmentId);
  if (asset === null || asset.storagePurpose !== "attachment") {
    throw new AttachmentReadError("ATTACHMENT_NOT_FOUND", "Attachment not found", 404);
  }
  if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0) {
    throw new AttachmentReadError("ATTACHMENT_INVALID_METADATA", "Attachment metadata is invalid", 500);
  }

  const scope = await options.access.require(input);
  const actor: AttachmentReadActor = {
    kind: "agent",
    trustedCallerSessionId: input.sessionId,
    ownerEmail: "",
  };
  const evidence = { scope, folderId: null, hasStoredRef: true } as const;
  const repository: AttachmentReadRepository = {
    getAsset: async (id) => id === asset.id ? asset : null,
    getLegacyAlias: async () => null,
    getSqlScopeEvidence: async (requestedScope, id) =>
      id === asset.id && sameScope(requestedScope, scope) ? evidence : null,
    listLegacyCandidateScopes: async () => [],
  };
  const service = createAttachmentReadService({
    repository,
    access: {
      async requireScope(requestActor, requestedScope, requestedEvidence) {
        if (
          requestActor.kind !== "agent" ||
          requestActor.trustedCallerSessionId !== input.sessionId ||
          !sameScope(requestedScope, scope) ||
          requestedEvidence !== evidence
        ) {
          throw new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "Attachment access denied", 403);
        }
      },
    },
    resolveReadStorage: options.resolveReadStorage,
    readPageAttachmentEvidence: async () => null,
  });
  return { service, actor, scope, id: asset.id };
}

function sameScope(left: AttachmentScope, right: AttachmentScope): boolean {
  return left.type === right.type && left.id === right.id;
}
