import type { Logger } from "pino";

import type { FolderSnapshot, FolderStatus, TaskItemStatus } from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import { FolderVersionConflict, type ChecklistAssigneeInput } from "./folder_models.js";
import type { FolderActorParams, FolderHandoffNotifierPort, FolderIdentityMutationResult, FolderMutationResult } from "./folder_service_models.js";

export type { FolderActorParams, FolderMutationResult } from "./folder_service_models.js";

/** Worker facade for the single folder/checklist owner in orch. */
export class FolderService {
  private handoffNotifier?: FolderHandoffNotifierPort;
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {
    this.transport = new PersistenceHostTransport(config);
  }

  setHandoffNotifier(notifier: FolderHandoffNotifierPort): void {
    this.handoffNotifier = notifier;
  }

  async getFolder(folderId: string, options: { view?: "full" | "outline"; itemId?: string } = {}): Promise<FolderSnapshot | null> {
    try {
      return await this.request("get_folder", { folderId, ...options });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  async listChildFolders(params: { folderId: string | null; includeArchived?: boolean; limit?: number }) {
    return await this.request("list_child_folders", params);
  }

  async listMyTurnItems(params: { userId?: string | null; limit?: number } = {}) {
    return await this.request("list_my_turn_items", params);
  }

  async listFolderOperations(folderId: string, limit?: number) {
    return await this.request("list_folder_operations", { folderId, limit });
  }

  async listAgentSubscriberSessionIds(folderId: string): Promise<string[]> {
    return await this.request("list_agent_subscribers", { folderId });
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

  async createChecklistSection(params: FolderActorParams & { folderId: string; title: string; assignee?: ChecklistAssigneeInput | null; afterSectionId?: string | null; beforeSectionId?: string | null; idempotencyKey: string }): Promise<FolderMutationResult> {
    return await this.mutate("create_checklist_section", params);
  }

  async updateChecklistSection(params: FolderActorParams & { folderId: string; sectionId: string; expectedVersion: number; title?: string; archived?: boolean; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    const operation = params.archived === true ? "archive_checklist_section" : params.archived === false ? "unarchive_checklist_section" : "update_checklist_section";
    const { archived, ...input } = params;
    return await this.mutate(operation, input);
  }

  async setChecklistSectionAssignee(params: FolderActorParams & { folderId: string; sectionId: string; expectedVersion: number; assignee?: ChecklistAssigneeInput | null; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    return await this.mutate("set_checklist_section_assignee", params);
  }

  async moveChecklistSection(params: FolderActorParams & { folderId: string; sectionId: string; expectedVersion: number; afterSectionId?: string | null; beforeSectionId?: string | null; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    return await this.mutate("move_checklist_section", params);
  }

  async createChecklistItem(params: FolderActorParams & { folderId: string; sectionId: string; title: string; howTo?: string; assignee?: ChecklistAssigneeInput | null; afterItemId?: string | null; beforeItemId?: string | null; idempotencyKey: string }): Promise<FolderMutationResult> {
    return await this.mutate("create_checklist_item", params);
  }

  async updateChecklistItem(params: FolderActorParams & { folderId: string; itemId: string; expectedVersion: number; title?: string; howTo?: string; archived?: boolean; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    const operation = params.archived === true ? "archive_checklist_item" : params.archived === false ? "unarchive_checklist_item" : "update_checklist_item";
    const { archived, ...input } = params;
    return await this.mutate(operation, input);
  }

  async setChecklistItemAssignee(params: FolderActorParams & { folderId: string; itemId: string; expectedVersion: number; assignee?: ChecklistAssigneeInput | null; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    return await this.mutate("set_checklist_item_assignee", params);
  }

  async moveChecklistItem(params: FolderActorParams & { folderId: string; itemId: string; expectedVersion: number; sectionId?: string | null; afterItemId?: string | null; beforeItemId?: string | null; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    return await this.mutate("move_checklist_item", params);
  }

  async setChecklistItemStatus(params: FolderActorParams & { folderId: string; itemId: string; expectedVersion: number; status: TaskItemStatus; reason?: string | null; idempotencyKey?: string | null }): Promise<FolderMutationResult> {
    return await this.mutate("set_checklist_item_status", params);
  }

  private async mutate<T extends FolderMutationResult>(operation: string, input: object): Promise<T> {
    const actor = input as { actorKind?: unknown };
    const result = await this.request<T>(operation, { ...input, actorKind: actor.actorKind ?? "agent" });
    if (result.handoff) {
      try {
        this.handoffNotifier?.notifyHumanHandoff(result.handoff);
      } catch (error) {
        this.config.logger.warn({ err: error, operation }, "folder handoff notifier failed");
      }
    }
    return result;
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
      assigneeKind: (assignee as ChecklistAssigneeInput).kind,
      assigneeAgentId: (assignee as ChecklistAssigneeInput).agentId,
      assigneeSessionId: (assignee as ChecklistAssigneeInput).sessionId,
      assigneeUserId: (assignee as ChecklistAssigneeInput).userId,
    };
  return Object.fromEntries(Object.entries({ ...fields, ...assigneeFields })
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), child]));
}

function isVersionConflictDetails(value: Record<string, unknown> | undefined): value is {
  targetKind: "folder" | "section" | "item";
  targetId: string;
  expectedVersion: number;
  actualVersion: number;
} {
  return value !== undefined
    && (value.targetKind === "folder" || value.targetKind === "section" || value.targetKind === "item")
    && typeof value.targetId === "string"
    && typeof value.expectedVersion === "number"
    && typeof value.actualVersion === "number";
}
