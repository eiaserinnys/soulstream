import { randomUUID } from "node:crypto";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";

import { assertAttachmentProducerTx } from "../cards/card_attachment_policy.js";
import type { TrustedAttachmentProducer } from "../cards/card_attachment_policy.js";
import type { RepositorySql } from "../cards/control_plane/card_types.js";
import type { OwnedAttachmentCommitService } from "./attachment_commit_contract.js";
import type { AttachmentAssetRow } from "./attachment_read_service.js";
import { projectAttachmentDescriptor } from "./attachment_read_service.js";

export type AgentAttachmentRegistrationInput = {
  readonly producer: TrustedAttachmentProducer;
  readonly targetScope: { readonly type: "card"; readonly id: string } | null;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
};

export type AgentAttachmentRegistrationResult = {
  readonly attachment_id: string;
  readonly descriptor: AttachmentDescriptor;
};

export type AgentAttachmentRegistration = (
  input: AgentAttachmentRegistrationInput,
) => Promise<AgentAttachmentRegistrationResult>;

export type AgentAttachmentRegistrationDeps = {
  readonly sql: RepositorySql;
  readonly commit: OwnedAttachmentCommitService;
  readonly readAsset: (id: string) => Promise<AttachmentAssetRow | null>;
};

class AgentAttachmentRegistrationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "AgentAttachmentRegistrationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createAgentAttachmentRegistration(
  deps: AgentAttachmentRegistrationDeps,
): AgentAttachmentRegistration {
  return async (input) => {
    await assertAttachmentProducerTx(deps.sql, input.producer, input.targetScope);

    const attachmentId = randomUUID();
    const committed = await deps.commit.putSmall({
      spec: {
        attachmentId,
        owner: { kind: "agent_session", key: input.producer.sessionId },
        registration: {
          registrationScope: input.targetScope,
          sourceNodeId: input.producer.nodeId,
          sourceSessionId: input.producer.sessionId,
          outputCommandId: input.producer.outputCommandId,
        },
        originalName: input.name,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        checksumSha256: input.checksumSha256,
      },
      body: input.body,
      signal: input.signal,
    });

    const asset = await deps.readAsset(attachmentId);
    if (
      asset === null ||
      asset.uploadStatus !== "committed" ||
      asset.checksumSha256 === null ||
      asset.checksumSha256 !== committed.checksumSha256
    ) {
      throw new AgentAttachmentRegistrationError(
        "ATTACHMENT_REGISTRATION_FAILED",
        500,
        "첨부 등록 결과를 확인할 수 없습니다.",
      );
    }

    return { attachment_id: attachmentId, descriptor: projectAttachmentDescriptor(asset) };
  };
}
