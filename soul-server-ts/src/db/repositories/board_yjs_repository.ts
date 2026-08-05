import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  SqlClient,
} from "../session_db_types.js";

/** Worker-side read boundary for resolving legacy container references. */
export class BoardYjsRepository {
  constructor(private readonly sql: SqlClient) {}

  async resolveBoardYjsContainerScope(
    containerInput: string | BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null> {
    const container = normalizeBoardYjsContainerInput(containerInput);
    if (container.containerKind === "folder") {
      return {
        folderId: container.containerId,
        containerKind: "folder",
        containerId: container.containerId,
      };
    }
    const rows = await this.sql<Array<{ folder_id: string }>>`
      SELECT bi.folder_id
      FROM tasks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE r.id = ${container.containerId}
      LIMIT 1
    `;
    const folderId = rows[0]?.folder_id;
    return folderId
      ? { folderId, containerKind: container.containerKind, containerId: container.containerId }
      : null;
  }
}

function normalizeBoardYjsContainerInput(
  containerInput: string | BoardYjsContainerRef,
): BoardYjsContainerRef {
  if (typeof containerInput !== "string") return containerInput;
  return { containerKind: "folder", containerId: containerInput };
}
