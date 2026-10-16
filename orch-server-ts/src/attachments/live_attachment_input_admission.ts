import type { FastifyRequest } from "fastify";

import { isServiceCaller, type ServiceCaller } from "../auth/service_caller.js";
import { createAttachmentInputAdmission, type AdmittedAttachmentInput } from "./attachment_input_admission.js";
import {
  AttachmentReadError,
  type AttachmentReadActor,
  type AttachmentReadRepository,
  type AttachmentReadService,
} from "./attachment_read_service.js";
import type { LiveAuthenticatedEmailResolver } from "../runtime/live_authenticated_user_resolver.js";

type AttachmentInput = {
  readonly sessionId: string;
  readonly nodeId?: string;
  readonly attachmentIds?: string[];
  readonly attachmentPaths?: string[];
};

export type LiveAttachmentInputAdmission = {
  readonly forRequest: (
    caller: FastifyRequest | ServiceCaller,
    input: AttachmentInput,
  ) => Promise<AdmittedAttachmentInput>;
  readonly forTrustedInput: (input: AttachmentInput & {
    readonly actor: AttachmentReadActor;
    readonly nodeId: string;
  }) => Promise<AdmittedAttachmentInput>;
};

export function createLiveAttachmentInputAdmission(options: {
  readonly repository: AttachmentReadRepository;
  readonly resolveEmail: LiveAuthenticatedEmailResolver;
  readonly readService: AttachmentReadService;
  readonly findSessionNode: (id: string) => Promise<string | null>;
}): LiveAttachmentInputAdmission {
  const admission = createAttachmentInputAdmission({
    repository: options.repository,
    requireLink: async (actor, id, target) => {
      try {
        const owner = await options.readService.metadata(actor, id, { type: "owner" });
        if (owner.upload_status !== "committed") {
          throw new AttachmentReadError(
            "ATTACHMENT_NOT_COMMITTED",
            "Attachment upload is not committed",
            409,
          );
        }
        return;
      } catch (error) {
        if (statusCode(error) !== 403) throw error;
      }
      if (target.sessionId === undefined) {
        throw new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "Attachment access denied", 403);
      }
      await options.readService.metadata(actor, id, { type: "session", id: target.sessionId });
    },
  });

  return {
    async forRequest(caller, input) {
      const actor = await requestActor(caller, options.resolveEmail);
      const sourceNodeId = input.nodeId ?? await options.findSessionNode(input.sessionId);
      if (sourceNodeId === null) {
        throw new AttachmentReadError(
          "SESSION_OWNER_MISSING",
          `Session owner is missing: ${input.sessionId}`,
          404,
        );
      }
      return await admit(admission, actor, input, sourceNodeId);
    },
    async forTrustedInput(input) {
      return await admit(admission, input.actor, input, input.nodeId);
    },
  };
}

async function requestActor(
  caller: FastifyRequest | ServiceCaller,
  resolveEmail: LiveAuthenticatedEmailResolver,
): Promise<AttachmentReadActor | null> {
  if (isServiceCaller(caller)) return null;
  const email = await resolveEmail(caller);
  return email === null || email.trim().length === 0
    ? null
    : { kind: "user", email };
}

async function admit(
  admission: ReturnType<typeof createAttachmentInputAdmission>,
  actor: AttachmentReadActor | null,
  input: AttachmentInput,
  nodeId: string,
): Promise<AdmittedAttachmentInput> {
  return await admission.admit({
    actor,
    sourceNodeId: nodeId,
    target: { sessionId: input.sessionId },
    ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
    ...(input.attachmentPaths === undefined ? {} : { attachmentPaths: input.attachmentPaths }),
  });
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error &&
    typeof error.statusCode === "number" ? error.statusCode : undefined;
}
