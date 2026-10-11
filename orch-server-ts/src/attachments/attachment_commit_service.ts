import { createHash, randomUUID } from "node:crypto";
import type {
  LiveBoardAssetCompletedPart,
  LiveBoardAssetMultipartUpload,
} from "../runtime/live_board_asset_storage.js";
import {
  R2ObjectIntegrityError,
  R2StorageRequestError,
} from "../runtime/live_board_asset_storage.js";
import type { R2StorageLocation } from "../runtime/r2_storage_resolver.js";
import { ATTACHMENT_TICKET_SECONDS, LARGE_ATTACHMENT_PART_SIZE } from "./attachment_upload_ticket.js";
import { verifyStoredObject } from "./attachment_commit_contract.js";
import type {
  AttachmentCommitRepository,
  AttachmentStorageBinding,
  AttachmentMultipartInit,
  CommitResult,
  CreateOwnedAttachmentCommitServiceOptions,
  OwnedAttachmentPendingInput,
  OwnedAttachmentUpload,
  OwnedAttachmentCommitService,
  UploadOwner,
  UploadRegistration,
  UploadSpec,
  VerifiedAttachmentUploadTicket,
  VerifiedObject,
} from "./attachment_commit_contract.js";
export { verifyStoredObject } from "./attachment_commit_contract.js";
export type * from "./attachment_commit_contract.js";

export class AttachmentCommitError extends Error {
  constructor(
    readonly code: "invalid_upload" | "upload_conflict" | "already_committed" | "checksum_mismatch" | "object_mismatch" | "storage_unavailable" | "storage_failed",
    readonly statusCode: number,
    message: string,
    readonly attachmentId?: string,
  ) {
    super(message);
    this.name = "AttachmentCommitError";
  }
}

const ATTACHMENT_STORAGE_PREFIX = "session-attachments/originals";

export function createOwnedAttachmentCommitService(
  options: CreateOwnedAttachmentCommitServiceOptions,
): OwnedAttachmentCommitService {
  const now = options.now ?? (() => new Date());
  const uploadIdGenerator = options.uploadIdGenerator ?? randomUUID;

  return {
    async putSmall(input) {
      const prepared = prepareSpec(input.spec);
      if (input.body.byteLength !== prepared.spec.byteSize) {
        throw new AttachmentCommitError("object_mismatch", 422, "Attachment source size does not match its registration", prepared.spec.attachmentId);
      }
      const sourceChecksum = sha256(input.body);
      assertClientChecksum(prepared.spec, sourceChecksum);
      const binding = await requireAttachmentBinding(options);
      const storageKey = attachmentStorageKey(prepared.spec.attachmentId);
      const existing = await options.repository.insertOwnedPending(pendingInput(prepared.spec, storageKey, binding.location));
      if (existing === null) throw conflict(prepared.spec.attachmentId);
      assertSameRegistration(existing, prepared.spec, storageKey, binding.location);
      if (existing.uploadStatus === "committed") {
        if (existing.checksumSha256 === sourceChecksum) return toCommitResult(existing);
        throw conflict(prepared.spec.attachmentId);
      }
      if (existing.multipartUploadId !== null) throw conflict(prepared.spec.attachmentId);

      try {
        await binding.storage.putObject({
          storageKey,
          mimeType: prepared.spec.mimeType,
          byteSize: prepared.spec.byteSize,
          checksumSha256: sourceChecksum,
          body: input.body,
          signal: input.signal,
        });
      } catch (error) {
        throw mapStorageError(error, prepared.spec.attachmentId);
      }

      let verified: VerifiedObject;
      try {
        verified = await verifyStoredObject({
          storage: binding.storage,
          storageKey,
          expectedByteSize: prepared.spec.byteSize,
          signal: input.signal,
        });
      } catch (error) {
        throw mapStorageError(error, prepared.spec.attachmentId);
      }
      if (verified.checksumSha256 !== sourceChecksum) throw checksumMismatch(prepared.spec.attachmentId);
      await assertBindingUnchanged(options, binding, prepared.spec.attachmentId);
      return commitVerified(options.repository, existing, prepared.spec.owner, verified);
    },

    async initMultipart(input) {
      const prepared = prepareSpec(input.spec);
      const binding = await requireAttachmentBinding(options);
      const storageKey = attachmentStorageKey(prepared.spec.attachmentId);
      const existing = await options.repository.insertOwnedPending(pendingInput(prepared.spec, storageKey, binding.location));
      if (existing === null) throw conflict(prepared.spec.attachmentId);
      assertSameRegistration(existing, prepared.spec, storageKey, binding.location);
      if (existing.uploadStatus === "committed") {
        throw new AttachmentCommitError("already_committed", 409, "Attachment is already committed", existing.attachmentId);
      }
      const { exp, expiresSeconds } = uploadExpiry(existing.createdAt, now(), prepared.spec.attachmentId);
      if (existing.multipartUploadId !== null) {
        try {
          const multipart = binding.storage.createMultipartPartUrls({
            storageKey,
            uploadId: existing.multipartUploadId,
            byteSize: existing.byteSize,
            partSize: LARGE_ATTACHMENT_PART_SIZE,
            expiresSeconds,
          });
          return multipartInitResult(existing, multipart, binding.identity, exp, prepared.spec.checksumSha256);
        } catch (error) {
          throw mapStorageError(error, prepared.spec.attachmentId);
        }
      }

      let multipart: LiveBoardAssetMultipartUpload;
      try {
        multipart = await binding.storage.createMultipartUpload({
          storageKey,
          mimeType: prepared.spec.mimeType,
          byteSize: prepared.spec.byteSize,
          partSize: LARGE_ATTACHMENT_PART_SIZE,
          expiresSeconds,
        });
      } catch (error) {
        throw mapStorageError(error, prepared.spec.attachmentId);
      }
      const stored = await options.repository.setMultipartUploadId({
        attachmentId: prepared.spec.attachmentId,
        owner: prepared.spec.owner,
        expectedUploadId: null,
        uploadId: multipart.uploadId,
      });
      if (stored === null) {
        try {
          await binding.storage.abortMultipartUpload({ storageKey, uploadId: multipart.uploadId });
        } catch {
          // The pending row remains authoritative; the caller can retry init with its active upload ID.
        }
        const raced = await options.repository.getOwnedUpload(prepared.spec.attachmentId, prepared.spec.owner);
        if (raced?.uploadStatus === "pending" && raced.multipartUploadId !== null) {
          assertSameRegistration(raced, prepared.spec, storageKey, binding.location);
          const { exp: racedExp, expiresSeconds: racedTtl } = uploadExpiry(raced.createdAt, now(), raced.attachmentId);
          try {
            const reissued = binding.storage.createMultipartPartUrls({
              storageKey,
              uploadId: raced.multipartUploadId,
              byteSize: raced.byteSize,
              partSize: LARGE_ATTACHMENT_PART_SIZE,
              expiresSeconds: racedTtl,
            });
            return multipartInitResult(raced, reissued, binding.identity, racedExp, prepared.spec.checksumSha256);
          } catch (error) {
            throw mapStorageError(error, raced.attachmentId);
          }
        }
        if (raced?.uploadStatus === "committed") {
          throw new AttachmentCommitError("already_committed", 409, "Attachment is already committed", raced.attachmentId);
        }
        throw conflict(prepared.spec.attachmentId);
      }
      assertSameRegistration(stored, prepared.spec, storageKey, binding.location);
      return multipartInitResult(stored, multipart, binding.identity, exp, prepared.spec.checksumSha256);
    },

    async completeMultipart(input) {
      const ticket = input.ticket;
      const existing = await options.repository.getOwnedUpload(ticket.importId, input.owner);
      if (existing === null) throw conflict(ticket.importId);
      assertTicketMatchesRow(ticket, existing);
      if (existing.uploadStatus === "committed") {
        assertOptionalChecksum(ticket.checksumSha256, existing.checksumSha256, ticket.importId);
        return toCommitResult(existing);
      }
      if (existing.multipartUploadId === null || existing.multipartUploadId !== ticket.uploadId) {
        throw conflict(ticket.importId);
      }
      const binding = await requireAttachmentBinding(options);
      assertTicketBinding(ticket, existing, binding);

      let objectAlreadyPresent = false;
      try {
        const head = await binding.storage.headObject({ storageKey: existing.storageKey });
        objectAlreadyPresent = true;
        if (head.byteSize !== existing.byteSize) throw objectMismatch(ticket.importId);
      } catch (error) {
        if (!isR2NotFound(error, "head object")) throw mapStorageError(error, ticket.importId);
      }
      if (!objectAlreadyPresent) {
        try {
          await binding.storage.completeMultipartUpload({
            storageKey: existing.storageKey,
            uploadId: ticket.uploadId,
            parts: input.parts,
          });
        } catch (error) {
          if (!isR2NotFound(error, "complete multipart upload")) throw mapStorageError(error, ticket.importId);
          try {
            const head = await binding.storage.headObject({ storageKey: existing.storageKey });
            if (head.byteSize !== existing.byteSize) throw objectMismatch(ticket.importId);
            objectAlreadyPresent = true;
          } catch (headError) {
            if (isR2NotFound(headError, "head object")) throw mapStorageError(error, ticket.importId);
            throw mapStorageError(headError, ticket.importId);
          }
        }
      }

      let verified: VerifiedObject;
      try {
        verified = await verifyStoredObject({
          storage: binding.storage,
          storageKey: existing.storageKey,
          expectedByteSize: existing.byteSize,
          signal: input.signal,
        });
      } catch (error) {
        throw mapStorageError(error, ticket.importId);
      }
      assertOptionalChecksum(ticket.checksumSha256, verified.checksumSha256, ticket.importId);
      await assertBindingUnchanged(options, binding, ticket.importId);
      return commitVerified(options.repository, existing, input.owner, verified);
    },

    async abortMultipart(input) {
      const ticket = input.ticket;
      const existing = await options.repository.getOwnedUpload(ticket.importId, input.owner);
      if (existing === null) throw conflict(ticket.importId);
      assertTicketMatchesRow(ticket, existing);
      if (existing.uploadStatus === "committed") return;
      if (existing.multipartUploadId === null || existing.multipartUploadId !== ticket.uploadId) {
        throw conflict(ticket.importId);
      }
      const binding = await requireAttachmentBinding(options);
      assertTicketBinding(ticket, existing, binding);
      try {
        await binding.storage.abortMultipartUpload({ storageKey: existing.storageKey, uploadId: ticket.uploadId });
      } catch (error) {
        throw mapStorageError(error, ticket.importId);
      }
      const cleared = await options.repository.clearPendingMultipart({
        attachmentId: ticket.importId,
        owner: input.owner,
        expectedUploadId: ticket.uploadId,
      });
      if (!cleared) {
        const current = await options.repository.getOwnedUpload(ticket.importId, input.owner);
        if (current?.uploadStatus === "committed") return;
        throw conflict(ticket.importId);
      }
    },
  };
}

function prepareSpec(spec: UploadSpec): { spec: UploadSpec; checksumSha256?: string } {
  const validId = /^[A-Za-z0-9_-]+$/.test(spec.attachmentId);
  const validOwner = (spec.owner.kind === "user_email" || spec.owner.kind === "agent_session")
    && spec.owner.key.length > 0;
  if (!validId || !validOwner || spec.originalName.length === 0 || spec.mimeType.length === 0
    || !Number.isSafeInteger(spec.byteSize) || spec.byteSize < 0
    || spec.registration.sourceNodeId.length === 0 || spec.registration.sourceSessionId.length === 0) {
    throw new AttachmentCommitError("invalid_upload", 409, "Attachment registration is invalid", spec.attachmentId);
  }
  const checksumSha256 = spec.checksumSha256 === undefined ? undefined : normalizeChecksum(spec.checksumSha256);
  return { spec: { ...spec, ...(checksumSha256 === undefined ? {} : { checksumSha256 }) }, checksumSha256 };
}

function assertClientChecksum(spec: UploadSpec, sourceChecksum: string): void {
  if (spec.checksumSha256 !== undefined && normalizeChecksum(spec.checksumSha256) !== sourceChecksum) {
    throw checksumMismatch(spec.attachmentId);
  }
}

function pendingInput(spec: UploadSpec, storageKey: string, location: R2StorageLocation): OwnedAttachmentPendingInput {
  return {
    attachmentId: spec.attachmentId,
    storageKey,
    owner: spec.owner,
    registration: spec.registration,
    originalName: spec.originalName,
    mimeType: spec.mimeType,
    byteSize: spec.byteSize,
    location,
  };
}

function attachmentStorageKey(attachmentId: string): string {
  return `${ATTACHMENT_STORAGE_PREFIX}/${attachmentId}`;
}

function assertSameRegistration(
  row: OwnedAttachmentUpload,
  spec: UploadSpec,
  storageKey: string,
  location: R2StorageLocation,
): void {
  if (row.attachmentId !== spec.attachmentId
    || row.storageKey !== storageKey
    || row.owner.kind !== spec.owner.kind
    || row.owner.key !== spec.owner.key
    || row.originalName !== spec.originalName
    || row.mimeType !== spec.mimeType
    || row.byteSize !== spec.byteSize
    || !sameRegistration(row.registration, spec.registration)
    || row.storageEndpoint !== location.endpoint
    || row.storageBucket !== location.bucket
    || row.garbageCollectedAt !== null) {
    throw conflict(spec.attachmentId);
  }
}

function sameRegistration(left: UploadRegistration, right: UploadRegistration): boolean {
  const leftScope = left.registrationScope;
  const rightScope = right.registrationScope;
  return left.sourceNodeId === right.sourceNodeId
    && left.sourceSessionId === right.sourceSessionId
    && left.outputCommandId === right.outputCommandId
    && (leftScope === null
      ? rightScope === null
      : rightScope !== null && leftScope.type === rightScope.type && leftScope.id === rightScope.id);
}

function assertTicketMatchesRow(ticket: VerifiedAttachmentUploadTicket, row: OwnedAttachmentUpload): void {
  if (ticket.importId !== row.attachmentId || ticket.storageKey !== row.storageKey
    || ticket.filename !== row.originalName || ticket.size !== row.byteSize
    || ticket.contentType !== row.mimeType || ticket.sessionId !== row.registration.sourceSessionId
    || ticket.nodeId !== row.registration.sourceNodeId) {
    throw conflict(row.attachmentId);
  }
}

function assertTicketBinding(
  ticket: VerifiedAttachmentUploadTicket,
  row: OwnedAttachmentUpload,
  binding: AttachmentStorageBinding,
): void {
  if (ticket.settingsIdentity !== binding.identity
    || row.storageEndpoint !== binding.location.endpoint
    || row.storageBucket !== binding.location.bucket) {
    throw conflict(row.attachmentId);
  }
}

function multipartInitResult(
  row: OwnedAttachmentUpload,
  multipart: LiveBoardAssetMultipartUpload,
  settingsIdentity: string,
  exp: number,
  checksumSha256?: string,
): AttachmentMultipartInit {
  return {
    partSize: multipart.partSize,
    parts: multipart.parts,
    ticket: {
      importId: row.attachmentId,
      storageKey: row.storageKey,
      uploadId: multipart.uploadId,
      filename: row.originalName,
      size: row.byteSize,
      contentType: row.mimeType,
      sessionId: row.registration.sourceSessionId,
      nodeId: row.registration.sourceNodeId,
      settingsIdentity,
      exp,
      ...(checksumSha256 === undefined ? {} : { checksumSha256 }),
    },
  };
}

function uploadExpiry(createdAt: Date | string, currentTime: Date, attachmentId: string): { exp: number; expiresSeconds: number } {
  const createdAtMs = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) throw conflict(attachmentId);
  const exp = Math.floor((createdAtMs + ATTACHMENT_TICKET_SECONDS * 1000) / 1000);
  const expiresSeconds = exp - Math.floor(currentTime.getTime() / 1000);
  if (expiresSeconds <= 0) throw conflict(attachmentId);
  return { exp, expiresSeconds };
}

async function requireAttachmentBinding(
  options: CreateOwnedAttachmentCommitServiceOptions,
): Promise<AttachmentStorageBinding> {
  const binding = await options.resolveAttachmentBinding();
  if (binding === null) {
    throw new AttachmentCommitError("storage_unavailable", 503, "Attachment storage is not configured");
  }
  return binding;
}

async function assertBindingUnchanged(
  options: CreateOwnedAttachmentCommitServiceOptions,
  expected: AttachmentStorageBinding,
  attachmentId: string,
): Promise<void> {
  const current = await requireAttachmentBinding(options);
  if (current.identity !== expected.identity
    || current.location.endpoint !== expected.location.endpoint
    || current.location.bucket !== expected.location.bucket) {
    throw conflict(attachmentId);
  }
}

async function commitVerified(
  repository: AttachmentCommitRepository,
  pending: OwnedAttachmentUpload,
  owner: UploadOwner,
  verified: VerifiedObject,
): Promise<CommitResult> {
  const committed = await repository.commitVerified({
    attachmentId: pending.attachmentId,
    owner,
    expectedByteSize: verified.byteSize,
    checksumSha256: verified.checksumSha256,
  });
  if (committed !== null) return toCommitResult(committed);
  const current = await repository.getOwnedUpload(pending.attachmentId, owner);
  if (current?.uploadStatus === "committed"
    && current.byteSize === verified.byteSize
    && current.checksumSha256 === verified.checksumSha256) return toCommitResult(current);
  throw conflict(pending.attachmentId);
}

function toCommitResult(row: OwnedAttachmentUpload): CommitResult {
  if (row.uploadStatus !== "committed" || row.checksumSha256 === null) throw conflict(row.attachmentId);
  return {
    attachmentId: row.attachmentId,
    storageKey: row.storageKey,
    storageEndpoint: row.storageEndpoint,
    storageBucket: row.storageBucket,
    originalName: row.originalName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    checksumSha256: row.checksumSha256,
  };
}

function assertOptionalChecksum(expected: string | undefined, actual: string | null, attachmentId: string): void {
  if (expected !== undefined && (actual === null || normalizeChecksum(expected) !== actual)) {
    throw checksumMismatch(attachmentId);
  }
}

function isR2NotFound(error: unknown, operation: string): boolean {
  return error instanceof R2StorageRequestError && error.operation === operation && error.status === 404;
}

function mapStorageError(error: unknown, attachmentId: string): AttachmentCommitError {
  if (error instanceof AttachmentCommitError) return error;
  if (error instanceof R2ObjectIntegrityError) {
    return error.reason === "checksum"
      ? checksumMismatch(attachmentId)
      : objectMismatch(attachmentId);
  }
  if (error instanceof R2StorageRequestError) {
    return new AttachmentCommitError("storage_failed", 502, `R2 ${error.operation} failed (${error.status})`, attachmentId);
  }
  return new AttachmentCommitError("storage_failed", 502, "Attachment storage request failed", attachmentId);
}

function normalizeChecksum(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new AttachmentCommitError("invalid_upload", 422, "Attachment checksum is invalid");
  }
  return normalized;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumMismatch(attachmentId: string): AttachmentCommitError {
  return new AttachmentCommitError("checksum_mismatch", 422, "Attachment checksum does not match", attachmentId);
}

function objectMismatch(attachmentId: string): AttachmentCommitError {
  return new AttachmentCommitError("object_mismatch", 422, "Stored attachment does not match its registration", attachmentId);
}

function conflict(attachmentId: string): AttachmentCommitError {
  return new AttachmentCommitError("upload_conflict", 409, "Attachment registration conflicts with an existing upload", attachmentId);
}
