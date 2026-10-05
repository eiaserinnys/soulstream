import type { Logger } from "pino";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import type {
  CatalogBoardItemRow,
  CatalogFolderRow,
  CatalogSessionAssignmentRow,
  FolderRow,
  FolderSnapshot,
} from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import type { CardReferenceLookupResult, SupervisedCardSnapshot } from "@soulstream/mcp-contract";

export class FolderHostClient {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {
    this.transport = new PersistenceHostTransport(config);
  }

  getAssignedCardContext(sessionId: string): Promise<import("../context/assigned_card_context.js").AssignedCardContext> {
    return this.request("get_assigned_card_context", { session_id: sessionId });
  }
  getSupervisedCardContext(params: {
    sessionId: string;
    folderIds: string[] | null;
    cardLimit: number;
    questionLimit: number;
  }): Promise<SupervisedCardSnapshot> {
    return this.request("get_supervised_card_context", {
      session_id: params.sessionId,
      folder_ids: params.folderIds,
      card_limit: params.cardLimit,
      question_limit: params.questionLimit,
    });
  }
  resolveCardReferences(refs: string[]): Promise<CardReferenceLookupResult[]> {
    return this.request("resolve_card_references", { refs });
  }
  async assignSessionToFolder(sessionId: string, folderId: string | null): Promise<void> {
    await this.request("assign_session", { session_id: sessionId, folder_id: folderId });
  }
  getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    return this.request("get_default", { name });
  }
  async getFolderById(folderId: string): Promise<FolderRow | null> {
    try {
      const snapshot = await this.request<FolderSnapshot>("get_folder", { folder_id: folderId });
      return folderHostRowToDbRow(snapshot.folder);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
  getAllFolders(): Promise<FolderRow[]> {
    return this.request("get_all", {});
  }
  getCatalog(): Promise<{
    folders: CatalogFolderRow[];
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
    boardItems: CatalogBoardItemRow[];
  }> {
    return this.request("get_catalog", {});
  }
  getSessionAssignmentsByIds(sessionIds: readonly string[]): Promise<CatalogSessionAssignmentRow[]> {
    return this.request("get_session_assignments", { session_ids: sessionIds });
  }
  private async request<T>(operation: string, body: object): Promise<T> {
    const response = await this.transport.send(
      "POST",
      `/api/folders/host/${encodeURIComponent(operation)}`,
      body,
    );
    if (!response.ok) {
      const detail = await readOrchErrorEnvelope(response);
      this.config.logger.warn({ operation, status: response.status, message: detail.message }, "folder host request failed");
      throw Object.assign(new Error(`folder host ${operation} failed: ${detail.message}`), { statusCode: response.status });
    }
    return await response.json() as T;
  }
}

function folderHostRowToDbRow(row: FolderSnapshot["folder"]): FolderRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value,
  ])) as unknown as FolderRow;
}
