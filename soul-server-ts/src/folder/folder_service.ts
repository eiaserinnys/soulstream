import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import type { CardDetail, FolderSnapshot, FolderStatus, CardStatus } from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import { FolderVersionConflict, type CardAssigneeInput } from "./folder_models.js";
import type { FolderActorParams, FolderIdentityMutationResult, FolderMutationResult } from "./folder_service_models.js";

export type { FolderActorParams, FolderMutationResult } from "./folder_service_models.js";

/** Worker facade for the single folder/card owner in orch. */
export class FolderService {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {
    this.transport = new PersistenceHostTransport(config);
  }

  async getFolder(folderId: string, options: { view?: "full" | "outline"; cardId?: string } = {}): Promise<FolderSnapshot | null> {
    try {
      return await this.request("get_folder", { folderId, ...options });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  async listChildFolders(params: { folderId: string | null; includeArchived?: boolean; limit?: number; cursor?: string }) {
    return await this.request("list_child_folders", params);
  }

  async listFolderOperations(folderId: string, limit?: number, cursor?: string) {
    return await this.request("list_folder_operations", { folderId, limit, cursor });
  }

  async createFolder(params: FolderActorParams & {
    parentFolderId?: string | null;
    name: string;
    description?: string;
    checklistEnabled?: boolean;
    initialContext?: unknown;
    sortOrder?: number;
    idempotencyKey: string;
  }): Promise<FolderIdentityMutationResult> {
    return await this.mutate<FolderIdentityMutationResult>("create_folder", params);
  }

  async renameFolder(params: FolderActorParams & { folderId: string; expectedVersion: number; name?: string; parentFolderId?: string | null; sortOrder?: number; settings?: Record<string, unknown>; reason?: string | null; idempotencyKey: string }): Promise<FolderIdentityMutationResult> {
    return await this.mutate<FolderIdentityMutationResult>("rename_folder", params);
  }

  async setFolderArchived(params: FolderActorParams & { folderId: string; expectedVersion: number; archived: boolean; reason?: string | null; idempotencyKey: string }): Promise<FolderIdentityMutationResult> {
    const { archived, ...input } = params;
    return await this.mutate<FolderIdentityMutationResult>(archived ? "archive_folder" : "unarchive_folder", input);
  }

  async setFolderStatus(params: FolderActorParams & { folderId: string; expectedVersion: number; status: FolderStatus; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    return await this.mutate("set_folder_status", params);
  }

  async setFolderChecklistEnabled(params: FolderActorParams & { folderId: string; expectedVersion: number; checklistEnabled: boolean; reason?: string | null; idempotencyKey: string }): Promise<FolderMutationResult> {
    return await this.mutate("set_folder_checklist_enabled", params);
  }

  async listCards(params: { folderId?: string; status?: CardStatus; actorSessionId?: string } = {}) {
    const query = new URLSearchParams();
    if (params.folderId !== undefined) query.set("folderId", params.folderId);
    if (params.status !== undefined) query.set("status", params.status);
    return this.cardRequest("GET", `/api/cards${query.size ? `?${query}` : ""}`, undefined, params.actorSessionId);
  }

  async getCard(cardId: string, actorSessionId?: string): Promise<CardDetail> {
    return this.cardRequest("GET", `/api/cards/${encodeURIComponent(cardId)}`, undefined, actorSessionId);
  }

  async createCard(params: FolderActorParams & { folderId: string; title: string; request: string; assignee?: CardAssigneeInput | null; nodeId?: string; modelPreset?: string; queue?: boolean }) {
    const { actorSessionId, actorKind, actorUserId, ...body } = params;
    return this.cardRequest("POST", "/api/cards", { ...body, idempotencyKey: randomUUID() }, actorSessionId ?? undefined);
  }

  async updateCardBrief(params: FolderActorParams & { cardId: string; brief: string }) {
    return this.cardMutation(params, "PATCH", "", { brief: params.brief }, true);
  }

  async addCardReport(params: FolderActorParams & { cardId: string; title: string; format: "markdown" | "html"; body: string }) {
    return this.cardMutation(params, "POST", "/reports", { title: params.title, format: params.format, body: params.body });
  }

  async requestCardReview(params: FolderActorParams & { cardId: string }) {
    return this.cardMutation(params, "POST", "/status", { status: "review" }, true);
  }

  async askCardQuestion(params: FolderActorParams & { cardId: string; text: string; options?: string[] }) {
    return this.cardMutation(params, "POST", "/questions", { text: params.text, ...(params.options !== undefined ? { options: params.options } : {}) });
  }

  async moveCard(params: FolderActorParams & { cardId: string; folderId: string; afterCardId?: string | null }) {
    return this.cardMutation(params, "POST", "/move", { folderId: params.folderId, ...(params.afterCardId !== undefined ? { afterCardId: params.afterCardId } : {}) }, true);
  }

  private async cardMutation(params: FolderActorParams & { cardId: string }, method: "POST" | "PATCH", suffix: string, body: object, cas = false) {
    const actorSessionId = params.actorSessionId ?? undefined;
    const expected = cas ? { expectedVersion: (await this.getCard(params.cardId, actorSessionId)).card.version } : {};
    return this.cardRequest(method, `/api/cards/${encodeURIComponent(params.cardId)}${suffix}`, { ...body, ...expected, idempotencyKey: randomUUID() }, actorSessionId);
  }

  private async cardRequest<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, actorSessionId?: string): Promise<T> {
    const response = await this.transport.send(method, path, body, {
      headers: actorSessionId ? { "x-soulstream-agent-session-id": actorSessionId } : {},
    });
    if (!response.ok) {
      const failure = await readOrchErrorEnvelope(response);
      throw Object.assign(new Error(failure.message), { statusCode: response.status, code: failure.code });
    }
    return await response.json() as T;
  }

  private async mutate<T extends FolderMutationResult>(operation: string, input: object): Promise<T> {
    const actor = input as { actorKind?: unknown };
    return await this.request<T>(operation, { ...input, actorKind: actor.actorKind ?? "agent" });
  }

  private async request<T = unknown>(operation: string, input: object): Promise<T> {
    const response = await this.transport.send("POST", `/api/folders/host/${encodeURIComponent(operation)}`, snakeCaseFields(input));
    if (!response.ok) {
      const failure = await readOrchErrorEnvelope(response);
      if (response.status === 409 && isVersionConflictDetails(failure.details)) {
        throw new FolderVersionConflict(failure.details.targetKind, failure.details.targetId, failure.details.expectedVersion, failure.details.actualVersion);
      }
      const error = Object.assign(new Error(`folder host ${operation} failed: ${failure.message}`), { statusCode: response.status });
      this.config.logger.warn({ operation, status: response.status, message: failure.message }, "folder host request failed");
      throw error;
    }
    return await response.json() as T;
  }
}

function snakeCaseFields(value: object): Record<string, unknown> {
  const { assignee, ...fields } = value as Record<string, unknown>;
  const assigneeFields = assignee === undefined ? {} : assignee === null
    ? { assigneeKind: null }
    : {
      assigneeKind: (assignee as CardAssigneeInput).kind,
      assigneeAgentId: (assignee as CardAssigneeInput).agentId,
      assigneeSessionId: (assignee as CardAssigneeInput).sessionId,
      assigneeUserId: (assignee as CardAssigneeInput).userId,
    };
  return Object.fromEntries(Object.entries({ ...fields, ...assigneeFields })
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), child]));
}

function isVersionConflictDetails(value: Record<string, unknown> | undefined): value is {
  targetKind: "folder" | "card";
  targetId: string;
  expectedVersion: number;
  actualVersion: number;
} {
  return value !== undefined
    && (value.targetKind === "folder" || value.targetKind === "card")
    && typeof value.targetId === "string"
    && typeof value.expectedVersion === "number"
    && typeof value.actualVersion === "number";
}
