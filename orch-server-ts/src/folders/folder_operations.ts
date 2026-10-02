import { z } from "zod";
import { cardOperationSchemas, executeCardOperation, type CardOperation } from "../cards/card_operations.js";
import type { CardControlPlaneService } from "../cards/card_control_plane_service.js";
import type { FolderActorParams } from "../cards/control_plane/card_types.js";
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";
import { serializeCardMutation, serializeCardRow, serializeFolderSnapshot } from "./folder_contracts.js";

export interface FolderOperationServices {
  cards: CardControlPlaneService;
  identity: Pick<FolderProjectIdentityService, "create" | "mutateFromFolder">;
}

const id = z.string().min(1);
const version = z.number().int().positive();
const mutation = z.object({ expectedVersion: version, idempotencyKey: id, reason: z.string().nullable().optional() });
const context = z.object({
  guidance: z.string(),
  atomReferences: z.array(z.object({
    instance: z.enum(["atom", "atom-nl"]), nodeId: id, nodeTitle: z.string(),
    depth: z.number().int().nonnegative(), titlesOnly: z.boolean(), mode: z.enum(["full", "index", "titles"]).optional(), limit: z.number().int().positive().optional(),
  })),
  sessionDefaults: z.object({ agentId: id, nodeId: id, modelPreset: id.optional() }).optional(),
});

export const folderOperationSchemas = {
  create_folder: z.object({ name: id, parentFolderId: id.nullable().optional(), sortOrder: z.number().int().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(), initialContext: context.optional(), idempotencyKey: id }),
  rename_folder: mutation.extend({ name: id.optional(), parentFolderId: id.nullable().optional(),
    sortOrder: z.number().int().optional(), settings: z.record(z.string(), z.unknown()).optional() }),
  archive_folder: mutation,
  unarchive_folder: mutation,
  set_folder_status: mutation.extend({ status: z.enum(["open", "completed"]) }),
  ...cardOperationSchemas,
} as const;
export type FolderOperation = keyof typeof folderOperationSchemas;

export async function executeFolderOperation(
  services: FolderOperationServices,
  operation: FolderOperation,
  body: unknown,
  scope: { folderId?: string; cardId?: string },
  actor: FolderActorParams,
) {
  if (operation in cardOperationSchemas) {
    return executeCardOperation(services.cards,operation as CardOperation,body,scope.cardId,actor);
  }
  const parsed = folderOperationSchemas[operation].strict().parse(body);
  if (operation === "create_folder") {
    const value = folderOperationSchemas.create_folder.parse(parsed);
    const result = await services.identity.create({ ...value, actor: { ...actor, actorKind: actor.actorKind ?? "agent" } });
    return { folder: result.folder, operation: serializeCardRow(result.operation), idempotent: result.idempotent ?? false };
  }
  const folderId = id.parse(scope.folderId);
  if (folderId === "claude" || folderId === "llm") throw Object.assign(new Error("System folders cannot be changed"), { statusCode: 403 });
  const snapshot = await services.cards.getFolder(folderId);
  if (!snapshot) throw Object.assign(new Error("Folder not found"), { statusCode: 404 });
  if (operation === "rename_folder" || operation === "archive_folder" || operation === "unarchive_folder") {
    const value = folderOperationSchemas.rename_folder.parse(parsed);
    const { expectedVersion, idempotencyKey, reason, ...update } = value;
    const result = await services.identity.mutateFromFolder({
      folderId, expectedVersion, idempotencyKey, reason, actor: { ...actor, actorKind: actor.actorKind ?? "agent" }, update,
      ...(operation !== "rename_folder" ? { archived: operation === "archive_folder" } : {}),
    });
    return { folder: result.folder, operation: serializeCardRow(result.operation), idempotent: result.idempotent ?? false };
  }
  const common={ ...actor,folderId };
  const result = await services.cards.setFolderStatus({
    ...common,
    ...folderOperationSchemas.set_folder_status.parse(parsed),
  });
  return serializeCardMutation(result);
}

export async function readFolderSnapshot(service: CardControlPlaneService, folderId: string, cardId?: string, view?: string, includeCompleted = true) {
  z.enum(["full", "outline"]).parse(view ?? "full");
  const snapshot = await service.getFolder(folderId,includeCompleted);
  if (!snapshot) throw Object.assign(new Error("Folder not found"), { statusCode: 404 });
  return serializeFolderSnapshot(snapshot, cardId, view === "outline");
}
