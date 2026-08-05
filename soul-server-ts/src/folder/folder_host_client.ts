import type { Logger } from "pino";

import type {
  CatalogBoardItemRow,
  CatalogFolderRow,
  CatalogSessionAssignmentRow,
  FolderRow,
} from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export class FolderHostClient {
  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {}

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
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/folders/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      this.config.logger.warn({ operation, status: response.status, message }, "folder host request failed");
      throw new Error(`folder host ${operation} failed: ${message || response.statusText}`);
    }
    return await response.json() as T;
  }
}
