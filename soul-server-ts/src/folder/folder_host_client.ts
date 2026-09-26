import type { Logger } from "pino";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import type {
  CatalogBoardItemRow,
  CatalogFolderRow,
  CatalogSessionAssignmentRow,
  FolderRow,
} from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export class FolderHostClient {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {
    this.transport = new PersistenceHostTransport(config);
  }

  async assignSessionToFolder(sessionId: string, folderId: string | null): Promise<void> {
    await this.request("assign_session", { session_id: sessionId, folder_id: folderId });
  }
  getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    return this.request("get_default", { name });
  }
  getFolderById(folderId: string): Promise<FolderRow | null> {
    return this.request("get_folder", { folder_id: folderId });
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
  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings" | "parent_folder_id">,
    values: ReadonlyArray<string | null>,
  ): Promise<void> {
    await this.request("update", { folder_id: folderId, columns, values });
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
      throw new Error(`folder host ${operation} failed: ${detail.message}`);
    }
    return await response.json() as T;
  }
}
