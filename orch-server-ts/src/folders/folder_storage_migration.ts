import * as Y from "yjs";

/** One-time persisted-data conversion, never used as a request compatibility layer. */
export function transformFolderStorageSnapshot(name: string, snapshot: Uint8Array): {
  name: string; snapshot: Uint8Array; changed: boolean;
} {
  const canonicalName = name.replace(/^board:(?:task|runbook):/, "board-folder:");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  let changed = canonicalName !== name;
  doc.transact(() => {
    if (canonicalName.startsWith("board-folder:")) {
      const items = doc.getMap<Record<string, unknown>>("boardItems");
      for (const [id, value] of items) {
        const next = { ...value };
        let itemChanged = false;
        if (next.item_type === "task" || next.item_type === "runbook") {
          next.item_type = "subfolder"; itemChanged = true;
        }
        for (const key of ["source_task_item_id", "source_runbook_item_id"]) {
          if (key in next) {
            next.source_checklist_item_id = next[key]; delete next[key]; itemChanged = true;
          }
        }
        if (itemChanged) { items.set(id, next); changed = true; }
      }
    }
    if (name.startsWith("page:")) {
      const meta = doc.getMap<unknown>("pageMeta");
      const metadata = meta.get("metadata") as Record<string, unknown> | undefined;
      if (metadata && "taskIdentity" in metadata) {
        const next = { ...metadata }; delete next.taskIdentity;
        meta.set("metadata", next); changed = true;
      }
      for (const value of doc.getMap<Y.Map<unknown>>("blocks").values()) {
        const type = value.get("type");
        const properties = value.get("properties");
        if (!(properties instanceof Y.Map)) continue;
        if (type === "task_ref" || type === "runbook_ref") {
          value.set("type", "folder_ref"); changed = true;
        }
        if (["task_ref", "runbook_ref", "folder_ref", "checklist"].includes(String(type))) {
          for (const key of ["taskId", "runbookId"]) {
            if (properties.has(key)) {
              properties.set("folderId", properties.get(key)); properties.delete(key); changed = true;
            }
          }
        }
        if (type === "guidance" && properties.get("scope") === "task") {
          properties.set("scope", "folder"); changed = true;
        }
      }
      if (changed) meta.set("mutationVersion", Number(meta.get("mutationVersion")) + 1);
    }
  });
  const result = { name: canonicalName, snapshot: changed ? Y.encodeStateAsUpdate(doc) : snapshot, changed };
  doc.destroy();
  return result;
}
