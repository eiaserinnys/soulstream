import type { CardMutationResult, FolderRow, FolderSnapshot } from "../cards/control_plane/card_types.js";

/** Row keys change at the boundary. Opaque JSON content is preserved. */
export function serializeCardRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key,value])=>[
    key.replace(/_([a-z])/g,(_match,letter:string)=>letter.toUpperCase()),value instanceof Date ? value.toISOString() : value,
  ]));
}
export function serializeFolder(row:FolderRow) { return serializeCardRow(row); }
export function serializeFolderSnapshot(snapshot:FolderSnapshot,cardId?:string,outline=false) {
  return { folder:serializeFolder(snapshot.folder),cards:snapshot.cards.filter(c=>!cardId || c.id === cardId).map(c=>{
    const row=serializeCardRow(c);
    if (outline) { delete row.request; delete row.brief; }
    return row;
  }) };
}
export function serializeCardMutation(result:CardMutationResult) {
  const operation=serializeCardRow(result.operation);
  if (result.operation.target_kind === "folder") return { folder:serializeFolder(result.snapshot.folder),operation,idempotent:result.idempotent ?? false };
  const card=result.snapshot.cards.find(c=>c.id === result.operation.target_id);
  return { folderId:result.snapshot.folder.id,card:card ? serializeCardRow(card) : null,operation,idempotent:result.idempotent ?? false };
}
