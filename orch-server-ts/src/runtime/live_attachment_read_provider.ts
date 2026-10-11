import type { FastifyRequest } from "fastify";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { allowed } from "../cards/card_route_body.js";
import type { AttachmentReadRouteOptions } from "../attachments/attachment_read_routes.js";
import {
  AttachmentReadError,
  createAttachmentReadService,
  type AttachmentReadActor,
  type AttachmentReadRepository,
  type AttachmentReadStorageBinding,
  type AttachmentScopeEvidence,
} from "../attachments/attachment_read_service.js";
import type { AttachmentScope } from "@soulstream/wire-schema/attachments";
import { isBoardFolderAllowed, normalizeBoardAccess } from "../board/board_access.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import type { LiveDashboardAccessProvider } from "./live_dashboard_access_provider.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import type { LiveAuthenticatedEmailResolver } from "./live_authenticated_user_resolver.js";

export type CreateLiveAttachmentReadOptions = {
  readonly repository: AttachmentReadRepository;
  readonly resolveEmail: LiveAuthenticatedEmailResolver;
  readonly resolveReadStorage: () => Promise<AttachmentReadStorageBinding | null>;
  readonly readPageAttachmentEvidence: (
    pageId: string,
    attachmentId: string,
  ) => Promise<AttachmentScopeEvidence | null>;
  readonly dashboardAccessProvider: Pick<LiveDashboardAccessProvider, "resolveAccess">;
  readonly sessionResourceAccessProvider: Pick<SessionResourceAccessProvider, "requireSessionAccess">;
  readonly folderProvider: Pick<LiveFolderProvider, "listFolders" | "listSessionAssignments">;
};

export function createLiveAttachmentReadOptions(
  options: CreateLiveAttachmentReadOptions,
): AttachmentReadRouteOptions {
  const service = createAttachmentReadService({
    repository: options.repository,
    resolveReadStorage: options.resolveReadStorage,
    readPageAttachmentEvidence: options.readPageAttachmentEvidence,
    access: {
      requireScope: async (actor, scope, evidence) => {
        await requireScopeAccess(options, actor, scope, evidence);
      },
    },
  });
  return {
    async resolveActor(request: FastifyRequest) {
      const email = normalizeEmail(await options.resolveEmail(request));
      if (email === "") {
        throw new AttachmentReadError(
          "ATTACHMENT_UNAUTHENTICATED",
          "Authentication required",
          401,
        );
      }
      return { kind: "user", email };
    },
    service,
  };
}

async function requireScopeAccess(
  options: CreateLiveAttachmentReadOptions,
  actor: AttachmentReadActor,
  scope: AttachmentScope,
  evidence: AttachmentScopeEvidence,
): Promise<void> {
  const email = actor.kind === "user" ? normalizeEmail(actor.email) : normalizeEmail(actor.ownerEmail);
  if (email === "") {
    throw new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "Attachment access denied", 403);
  }
  if (scope.type === "session") {
    await options.sessionResourceAccessProvider.requireSessionAccess({
      request: SERVICE_CALLER,
      sessionId: scope.id,
      accessEmail: email,
    });
    return;
  }
  if (scope.type === "page") {
    return;
  }
  if (scope.type === "card") {
    try {
      await allowed(
        { provider: options.folderProvider },
        () => options.dashboardAccessProvider.resolveAccess(SERVICE_CALLER, { accessEmail: email }),
        evidence.folderId ?? "",
      );
    } catch (error) {
      if (isAccessError(error)) throw error;
      throw new AttachmentReadError("ATTACHMENT_SCOPE_UNAVAILABLE", "Attachment scope is unavailable", 503);
    }
    return;
  }
  const access = normalizeBoardAccess(await options.dashboardAccessProvider.resolveAccess(
    SERVICE_CALLER,
    { accessEmail: email },
  ));
  const folders = await options.folderProvider.listFolders();
  if (!isBoardFolderAllowed(access, folders, evidence.folderId)) {
    throw new AttachmentReadError("ATTACHMENT_ACCESS_DENIED", "Attachment access denied", 403);
  }
}

function normalizeEmail(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function isAccessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error &&
    typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}
