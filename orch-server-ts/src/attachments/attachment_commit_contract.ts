import { createHash } from "node:crypto";
import type { AttachmentRegistrationScope } from "@soulstream/wire-schema/attachments";
import type {
  LiveBoardAssetCompletedPart,
  LiveBoardAssetMultipartUpload,
  R2ObjectStorage,
} from "../runtime/live_board_asset_storage.js";
import {
  R2ObjectIntegrityError,
  R2StorageRequestError,
} from "../runtime/live_board_asset_storage.js";
import { createR2StorageResolver } from "../runtime/r2_storage_resolver.js";
import type { R2StorageLocation } from "../runtime/r2_storage_resolver.js";

export type UploadOwner =
  | { readonly kind: "user_email"; readonly key: string }
  | { readonly kind: "agent_session"; readonly key: string };

export type UploadRegistration = {
  readonly registrationScope: AttachmentRegistrationScope | null;
  readonly sourceNodeId: string;
  readonly sourceSessionId: string;
  readonly outputCommandId: string | null;
};

export type UploadSpec = {
  readonly attachmentId: string;
  readonly owner: UploadOwner;
  readonly registration: UploadRegistration;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksumSha256?: string;
};

export type VerifiedAttachmentUploadTicket = {
  readonly importId: string;
  readonly storageKey: string;
  readonly uploadId: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType: string;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly settingsIdentity: string;
  readonly exp: number;
  readonly checksumSha256?: string;
};

export type OwnedAttachmentUpload = {
  readonly attachmentId: string;
  readonly storageKey: string;
  readonly owner: UploadOwner;
  readonly registration: UploadRegistration;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly storageEndpoint: string;
  readonly storageBucket: string;
  readonly checksumSha256: string | null;
  readonly uploadStatus: "pending" | "committed";
  readonly multipartUploadId: string | null;
  readonly createdAt: Date | string;
  readonly garbageCollectedAt: Date | string | null;
};

export type OwnedAttachmentPendingInput = {
  readonly attachmentId: string;
  readonly storageKey: string;
  readonly owner: UploadOwner;
  readonly registration: UploadRegistration;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly location: R2StorageLocation;
};

export type AttachmentLegacyAlias = {
  readonly nodeId: string;
  readonly normalizedPath: string;
  readonly assetId: string | null;
  readonly originalPath: string;
  readonly availability: "resolved" | "missing";
};

export type AttachmentCommitRepository = {
  readonly insertOwnedPending: (input: OwnedAttachmentPendingInput) => Promise<OwnedAttachmentUpload | null>;
  readonly getOwnedUpload: (attachmentId: string, owner: UploadOwner) => Promise<OwnedAttachmentUpload | null>;
  readonly setMultipartUploadId: (input: {
    readonly attachmentId: string;
    readonly owner: UploadOwner;
    readonly expectedUploadId: string | null;
    readonly uploadId: string;
  }) => Promise<OwnedAttachmentUpload | null>;
  readonly commitVerified: (input: {
    readonly attachmentId: string;
    readonly owner: UploadOwner;
    readonly expectedByteSize: number;
    readonly checksumSha256: string;
  }) => Promise<OwnedAttachmentUpload | null>;
  readonly clearPendingMultipart: (input: {
    readonly attachmentId: string;
    readonly owner: UploadOwner;
    readonly expectedUploadId: string;
  }) => Promise<boolean>;
  readonly findLegacyAliasForAsset: (nodeId: string, normalizedPath: string) => Promise<AttachmentLegacyAlias | null>;
  readonly insertLegacyAlias: (input: {
    readonly nodeId: string;
    readonly normalizedPath: string;
    readonly assetId: string;
    readonly originalPath: string;
  }) => Promise<AttachmentLegacyAlias | null>;
};

export type CommitResult = {
  readonly attachmentId: string;
  readonly storageKey: string;
  readonly storageEndpoint: string;
  readonly storageBucket: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
};

export type VerifiedObject = {
  readonly byteSize: number;
  readonly checksumSha256: string;
};

export type AttachmentMultipartInit = {
  readonly partSize: number;
  readonly parts: LiveBoardAssetMultipartUpload["parts"];
  readonly ticket: VerifiedAttachmentUploadTicket;
};

export type OwnedAttachmentCommitService = {
  readonly putSmall: (input: {
    readonly spec: UploadSpec;
    readonly body: Uint8Array;
    readonly signal?: AbortSignal;
  }) => Promise<CommitResult>;
  readonly initMultipart: (input: { readonly spec: UploadSpec }) => Promise<AttachmentMultipartInit>;
  readonly completeMultipart: (input: {
    readonly owner: UploadOwner;
    readonly ticket: VerifiedAttachmentUploadTicket;
    readonly parts: readonly LiveBoardAssetCompletedPart[];
    readonly signal?: AbortSignal;
  }) => Promise<CommitResult>;
  readonly abortMultipart: (input: {
    readonly owner: UploadOwner;
    readonly ticket: VerifiedAttachmentUploadTicket;
  }) => Promise<void>;
};

export type AttachmentStorageBinding = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createR2StorageResolver>["resolveBinding"]>>
>;

export type CreateOwnedAttachmentCommitServiceOptions = {
  readonly repository: AttachmentCommitRepository;
  readonly resolveAttachmentBinding: () => Promise<AttachmentStorageBinding | null>;
  readonly uploadIdGenerator?: () => string;
  readonly now?: () => Date;
};

export async function verifyStoredObject(input: {
  readonly storage: Pick<R2ObjectStorage, "openObject">;
  readonly storageKey: string;
  readonly expectedByteSize: number;
  readonly signal?: AbortSignal;
}): Promise<VerifiedObject> {
  const response = await input.storage.openObject({ storageKey: input.storageKey, method: "GET", signal: input.signal });
  if (response.status !== 200) throw new R2StorageRequestError("get object", response.status);
  const contentLength = response.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength) || Number(contentLength) !== input.expectedByteSize) {
    await response.body?.cancel();
    throw new R2ObjectIntegrityError("size");
  }
  if (response.body === null) {
    if (input.expectedByteSize !== 0) throw new R2ObjectIntegrityError("size");
    return { byteSize: 0, checksumSha256: createHash("sha256").digest("hex") };
  }

  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let byteSize = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteSize += chunk.value.byteLength;
      if (byteSize > input.expectedByteSize) {
        await reader.cancel();
        throw new R2ObjectIntegrityError("size");
      }
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteSize !== input.expectedByteSize) throw new R2ObjectIntegrityError("size");
  return { byteSize, checksumSha256: hash.digest("hex") };
}
