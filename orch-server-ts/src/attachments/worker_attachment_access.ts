import type { AttachmentScope } from "@soulstream/wire-schema/attachments";

import {
  AttachmentReadError,
  type AttachmentReadRepository,
} from "./attachment_read_service.js";

export type WorkerAttachmentReadInput = {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly attachmentId: string;
  readonly mode: "input" | "resolve";
  readonly deliveryId?: string;
};

export type WorkerAttachmentSession = {
  readonly nodeId: string;
  readonly cardId: string | null;
  readonly assigneeCardIds: readonly string[];
};

export type WorkerAttachmentDelivery = {
  readonly targetSessionId: string | null;
  readonly attachmentIds: readonly string[];
};

export type CreateWorkerAttachmentAccessOptions = {
  readonly repository: AttachmentReadRepository;
  readonly findSession: (id: string) => Promise<WorkerAttachmentSession | null>;
  readonly findDelivery: (id: string) => Promise<WorkerAttachmentDelivery | null>;
};

export function createWorkerAttachmentAccess(options: CreateWorkerAttachmentAccessOptions): {
  readonly require: (input: WorkerAttachmentReadInput) => Promise<AttachmentScope>;
} {
  return {
    async require(input) {
      const session = await options.findSession(input.sessionId);
      if (session === null) {
        throw new AttachmentReadError("SESSION_NOT_FOUND", "Session not found", 404);
      }
      if (session.nodeId !== input.nodeId) {
        throw new AttachmentReadError(
          "ATTACHMENT_NODE_MISMATCH",
          "Attachment access denied",
          403,
        );
      }
      if (input.mode === "resolve" && input.deliveryId !== undefined) {
        throw invalidContextError();
      }

      const sessionScope: AttachmentScope = { type: "session", id: input.sessionId };
      const sessionEvidence = await options.repository.getSqlScopeEvidence(
        sessionScope,
        input.attachmentId,
      );
      if (sessionEvidence?.hasStoredRef === true) return sessionScope;

      if (input.mode === "input" && input.deliveryId !== undefined) {
        const delivery = await options.findDelivery(input.deliveryId);
        if (delivery !== null && delivery.targetSessionId !== input.sessionId) {
          throw accessDeniedError();
        }
        if (delivery?.attachmentIds.includes(input.attachmentId)) return sessionScope;
      }

      const cardIds = new Set([
        ...(session.cardId === null ? [] : [session.cardId]),
        ...session.assigneeCardIds,
      ]);
      for (const id of cardIds) {
        const scope: AttachmentScope = { type: "card", id };
        const evidence = await options.repository.getSqlScopeEvidence(scope, input.attachmentId);
        if (evidence?.hasStoredRef === true) return scope;
      }

      throw new AttachmentReadError(
        "ATTACHMENT_REF_REQUIRED",
        "Attachment access denied",
        403,
      );
    },
  };
}

function invalidContextError(): AttachmentReadError {
  return new AttachmentReadError(
    "ATTACHMENT_INVALID_CONTEXT",
    "Invalid attachment context",
    422,
  );
}

function accessDeniedError(): AttachmentReadError {
  return new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "Attachment access denied", 403);
}
