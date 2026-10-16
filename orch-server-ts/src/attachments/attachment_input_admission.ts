import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";

import {
  normalizeAttachmentLegacyPath,
  type AttachmentAssetRow,
  type AttachmentReadActor,
  type AttachmentReadRepository,
} from "./attachment_read_service.js";

export type AttachmentAdmissionActor = AttachmentReadActor;

export type AttachmentAdmissionTarget = {
  sessionId?: string;
  cardId?: string;
};

export type AdmittedAttachmentInput = {
  attachment_ids: string[];
  attachment_paths: string[];
  attachment_bindings: AttachmentPathBinding[];
};

export type AttachmentInputAdmission = {
  admit(input: {
    actor: AttachmentAdmissionActor | null;
    sourceNodeId: string;
    target: AttachmentAdmissionTarget;
    attachmentIds?: readonly string[];
    attachmentPaths?: readonly string[];
  }): Promise<AdmittedAttachmentInput>;
};

export function createAttachmentInputAdmission(options: {
  repository: AttachmentReadRepository;
  requireLink(
    actor: AttachmentAdmissionActor,
    id: string,
    target: AttachmentAdmissionTarget,
    asset: AttachmentAssetRow,
  ): Promise<void>;
}): AttachmentInputAdmission {
  return {
    async admit(input) {
      const explicitIds = explicitAttachmentIds(input.attachmentIds);
      const paths = [...(input.attachmentPaths ?? [])];

      const aliases: { path: string; assetId: string | null; missing: boolean }[] = [];
      for (const path of paths) {
        const alias = await options.repository.getLegacyAlias(
          input.sourceNodeId,
          normalizeAttachmentLegacyPath(path),
        );
        if (alias === null) continue;
        aliases.push({
          path,
          assetId: alias.assetId,
          missing: alias.availability === "missing",
        });
      }

      if (explicitIds.length === 0 && aliases.length === 0) {
        return { attachment_ids: [], attachment_paths: paths, attachment_bindings: [] };
      }
      const actor = input.actor;
      if (actor === null) {
        throw admissionError("ATTACHMENT_UNAUTHENTICATED", "Attachment actor is required", 401);
      }

      const bindings: AttachmentPathBinding[] = aliases.map(({ path, assetId, missing }) => {
        if (missing || assetId === null) {
          throw admissionError("ATTACHMENT_SOURCE_MISSING", "Attachment source is missing", 404);
        }
        return { attachment_id: assetId, node_id: input.sourceNodeId, path };
      });

      const ids = [...new Set([...explicitIds, ...bindings.map((binding) => binding.attachment_id)])];
      for (const id of ids) {
        const asset = await options.repository.getAsset(id);
        if (asset === null || asset.storagePurpose !== "attachment") {
          throw admissionError("ATTACHMENT_NOT_FOUND", "Attachment not found", 404);
        }
        if (asset.uploadStatus !== "committed") {
          throw admissionError("ATTACHMENT_NOT_COMMITTED", "Attachment upload is not committed", 409);
        }
        await options.requireLink(actor, id, input.target, asset);
      }

      if (
        explicitIds.length > 0 &&
        bindings.some((binding) => !explicitIds.includes(binding.attachment_id))
      ) {
        throw admissionError(
          "ATTACHMENT_REFERENCE_MISMATCH",
          "Attachment ids do not match the attachment paths",
          422,
        );
      }

      return { attachment_ids: ids, attachment_paths: paths, attachment_bindings: bindings };
    },
  };
}

function explicitAttachmentIds(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw admissionError("INVALID_REQUEST", "attachment_ids must be non-empty strings", 400);
  }
  return [...new Set<string>(value)];
}

function admissionError(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}
