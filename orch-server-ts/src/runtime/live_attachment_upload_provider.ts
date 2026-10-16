import type { FastifyRequest } from "fastify";
import type { AttachmentRegistrationScope } from "@soulstream/wire-schema/attachments";
import { AttachmentUploadHttpError, type AttachmentUploadOptions, type UploadMode } from "../attachments/attachment_upload_http.js";
import type { AttachmentReadRouteOptions } from "../attachments/attachment_read_routes.js";
import type {
  AttachmentCommitRepository,
  AttachmentStorageBinding,
  OwnedAttachmentCommitService,
  UploadRegistration,
} from "../attachments/attachment_commit_contract.js";
import type { SessionResourceAccessProvider, SessionResourceAccessRepository } from "../session/session_resource_access.js";
import type { LiveAuthenticatedEmailResolver } from "./live_authenticated_user_resolver.js";

// Same pre-session shape as the legacy multipart path: an unsaved session is
// addressed by a client-generated UUID v4, never by an arbitrary string.
const PRE_SESSION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function createLiveAttachmentUploadOptions(input: {
  readonly resolveEmail: LiveAuthenticatedEmailResolver;
  readonly readOptions: AttachmentReadRouteOptions;
  readonly repository: SessionResourceAccessRepository;
  readonly access: SessionResourceAccessProvider;
  readonly commits: OwnedAttachmentCommitService;
  readonly commitRepository: AttachmentCommitRepository;
  readonly resolveBinding: AttachmentUploadOptions["resolveBinding"];
}): AttachmentUploadOptions {
  return {
    async resolveActor(request: FastifyRequest) {
      // Identity comes only from the shared credential resolver; body, query
      // and caller_info are never consulted here.
      const email = normalizeEmail(await input.resolveEmail(request));
      if (email === "") return null;
      const actor = await input.readOptions.resolveActor(request);
      return actor.kind === "user" ? actor : null;
    },
    async requireRegistration(request, registration) {
      const sessionId = registration.sessionId.trim();
      if (sessionId === "") throw invalidUpload();
      const session = await input.repository.getSessionAccessRecord(sessionId);
      // Existence is verified directly: the ACL provider's unrestricted early
      // return must never stand in as proof that the folder exists.
      if (registration.folderId !== null) {
        const folders = await input.repository.listFoldersForAccess();
        if (!folders.some((folder) => folder.id === registration.folderId)) {
          throw new AttachmentUploadHttpError(404, "folder_not_found", "첨부 대상 폴더를 찾을 수 없습니다");
        }
      }
      const registrationScope = session !== null
        ? await existingSessionScope(input.access, request, registration, sessionId)
        : await preSessionScope(input.access, request, registration, sessionId);
      // Registration records provenance only; it grants no access.
      return { registrationScope, sourceNodeId: null, sourceSessionId: sessionId, outputCommandId: null };
    },
    commits: input.commits,
    repository: input.commitRepository,
    resolveBinding: input.resolveBinding,
    ownerMetadata: input.readOptions.service.metadata,
  };
}

type RegistrationInput = {
  readonly actor: { readonly email: string };
  readonly folderId: string | null;
  readonly mode: UploadMode;
  readonly small: boolean;
};

async function existingSessionScope(
  access: SessionResourceAccessProvider,
  request: FastifyRequest,
  registration: RegistrationInput,
  sessionId: string,
): Promise<AttachmentRegistrationScope> {
  await access.requireSessionAccess({ request, sessionId, accessEmail: registration.actor.email });
  if (registration.folderId !== null) {
    await access.requireFolderAccess({ request, folderId: registration.folderId, accessEmail: registration.actor.email });
  }
  return { type: "session", id: sessionId };
}

async function preSessionScope(
  access: SessionResourceAccessProvider,
  request: FastifyRequest,
  registration: RegistrationInput,
  sessionId: string,
): Promise<AttachmentRegistrationScope | null> {
  if (!PRE_SESSION_UUID.test(sessionId)) throw invalidUpload();
  if (registration.folderId !== null) {
    await access.requireFolderAccess({ request, folderId: registration.folderId, accessEmail: registration.actor.email });
    return { type: "folder", id: registration.folderId };
  }
  // Only a legacy small draft may stage without a scope; id-v1 and large
  // uploads must name a folder so the object is reachable by its owner.
  if (registration.mode === "legacy" && registration.small) return null;
  throw invalidUpload();
}

function invalidUpload(): AttachmentUploadHttpError {
  return new AttachmentUploadHttpError(400, "invalid_upload", "첨부 업로드 등록 정보가 올바르지 않습니다");
}

function normalizeEmail(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
