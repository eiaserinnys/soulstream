import { z } from "zod";
import { CHECKLIST_ITEM_STATUSES } from "@soulstream/wire-schema";
import type { ChecklistControlPlaneService } from "../checklist/checklist_control_plane_service.js";
import type { FolderActorParams } from "../checklist/control_plane/checklist_types.js";
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";
import { serializeChecklistMutation, serializeChecklistRow, serializeFolderSnapshot } from "./folder_contracts.js";

export interface FolderOperationServices {
  checklist: ChecklistControlPlaneService;
  identity: Pick<FolderProjectIdentityService, "create" | "mutateFromFolder">;
}

const id = z.string().min(1);
const version = z.number().int().positive();
const assigneeFields = {
  assigneeKind: z.enum(["agent", "human", "session"]).nullable().optional(),
  assigneeAgentId: id.nullable().optional(), assigneeSessionId: id.nullable().optional(), assigneeUserId: id.nullable().optional(),
};
const mutation = z.object({ expectedVersion: version, idempotencyKey: id, reason: z.string().nullable().optional() });
const sectionPatch = mutation.extend({ title: z.string().optional(), ...assigneeFields });
const itemPatch = sectionPatch.extend({ howTo: z.string().optional() });
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
    settings: z.record(z.string(), z.unknown()).optional(), checklistEnabled: z.boolean().default(false),
    description: z.string().optional(), initialContext: context.optional(), idempotencyKey: id }),
  rename_folder: mutation.extend({ name: id.optional(), parentFolderId: id.nullable().optional(),
    sortOrder: z.number().int().optional(), settings: z.record(z.string(), z.unknown()).optional() }),
  archive_folder: mutation,
  unarchive_folder: mutation,
  set_folder_status: mutation.extend({ status: z.enum(["open", "completed"]) }),
  set_folder_checklist_enabled: mutation.extend({ checklistEnabled: z.boolean() }),
  create_checklist_section: z.object({ title: id, ...assigneeFields, afterSectionId: id.nullable().optional(), beforeSectionId: id.nullable().optional(), idempotencyKey: id }),
  update_checklist_section: sectionPatch,
  archive_checklist_section: mutation,
  unarchive_checklist_section: mutation,
  move_checklist_section: mutation.extend({ afterSectionId: id.nullable().optional(), beforeSectionId: id.nullable().optional() }),
  set_checklist_section_assignee: mutation.extend(assigneeFields),
  create_checklist_item: z.object({ title: id, howTo: z.string().optional(), ...assigneeFields, afterItemId: id.nullable().optional(), beforeItemId: id.nullable().optional(), idempotencyKey: id }),
  update_checklist_item: itemPatch,
  archive_checklist_item: mutation,
  unarchive_checklist_item: mutation,
  move_checklist_item: mutation.extend({ sectionId: id.nullable().optional(), afterItemId: id.nullable().optional(), beforeItemId: id.nullable().optional() }),
  set_checklist_item_assignee: mutation.extend(assigneeFields),
  set_checklist_item_status: mutation.extend({ status: z.enum(CHECKLIST_ITEM_STATUSES) }),
} as const;
export type FolderOperation = keyof typeof folderOperationSchemas;

export async function executeFolderOperation(
  services: FolderOperationServices,
  operation: FolderOperation,
  body: unknown,
  scope: { folderId?: string; sectionId?: string; itemId?: string },
  actor: FolderActorParams,
) {
  const parsed = folderOperationSchemas[operation].strict().parse(body);
  if (operation === "create_folder") {
    const value = folderOperationSchemas.create_folder.parse(parsed);
    const result = await services.identity.create({ ...value, actor: { ...actor, actorKind: actor.actorKind ?? "agent" } });
    return { folder: result.folder, operation: serializeChecklistRow(result.operation), idempotent: result.idempotent ?? false };
  }
  const folderId = id.parse(scope.folderId);
  if (folderId === "claude" || folderId === "llm") throw Object.assign(new Error("System folders cannot be changed"), { statusCode: 403 });
  const snapshot = await services.checklist.getFolder(folderId);
  if (!snapshot) throw Object.assign(new Error("Folder not found"), { statusCode: 404 });
  if (scope.sectionId && !snapshot.sections.some((section) => section.id === scope.sectionId)) {
    throw Object.assign(new Error("Checklist section not found in folder"), { statusCode: 404 });
  }
  if (scope.itemId && !snapshot.items.some((item) => item.id === scope.itemId)) {
    throw Object.assign(new Error("Checklist item not found in folder"), { statusCode: 404 });
  }
  if (operation === "rename_folder" || operation === "archive_folder" || operation === "unarchive_folder") {
    const value = folderOperationSchemas.rename_folder.parse(parsed);
    const { expectedVersion, idempotencyKey, reason, ...update } = value;
    const result = await services.identity.mutateFromFolder({
      folderId, expectedVersion, idempotencyKey, reason, actor: { ...actor, actorKind: actor.actorKind ?? "agent" }, update,
      ...(operation !== "rename_folder" ? { archived: operation === "archive_folder" } : {}),
    });
    return { folder: result.folder, operation: serializeChecklistRow(result.operation), idempotent: result.idempotent ?? false };
  }
  const assignment = z.object(assigneeFields).parse(parsed);
  const common = { ...actor, folderId, ...(assignment.assigneeKind === undefined ? {} : {
    assignee: { kind: assignment.assigneeKind, agentId: assignment.assigneeAgentId,
      sessionId: assignment.assigneeSessionId, userId: assignment.assigneeUserId },
  }) };
  const sectionId = scope.sectionId;
  const itemId = scope.itemId;
  const service = services.checklist;
  const result = await (async () => {
    switch (operation) {
      case "set_folder_status": return service.setFolderStatus({ ...common, ...folderOperationSchemas.set_folder_status.parse(parsed) });
      case "set_folder_checklist_enabled": return service.setFolderChecklistEnabled({ ...common, ...folderOperationSchemas.set_folder_checklist_enabled.parse(parsed) });
      case "create_checklist_section": return service.createSection({ ...common, ...folderOperationSchemas.create_checklist_section.parse(parsed) });
      case "update_checklist_section": return service.patchSection({ ...common, sectionId: id.parse(sectionId), ...sectionPatch.parse(parsed) });
      case "archive_checklist_section":
      case "unarchive_checklist_section": return service.patchSection({ ...common, sectionId: id.parse(sectionId), ...mutation.parse(parsed), archived: operation === "archive_checklist_section" });
      case "move_checklist_section": return service.moveSection({ ...common, sectionId: id.parse(sectionId), ...folderOperationSchemas.move_checklist_section.parse(parsed) });
      case "set_checklist_section_assignee": return service.setSectionAssignee({ ...common, sectionId: id.parse(sectionId), ...folderOperationSchemas.set_checklist_section_assignee.parse(parsed) });
      case "create_checklist_item": return service.createItem({ ...common, sectionId: id.parse(sectionId), ...folderOperationSchemas.create_checklist_item.parse(parsed) });
      case "update_checklist_item": return service.patchItem({ ...common, itemId: id.parse(itemId), ...itemPatch.parse(parsed) });
      case "archive_checklist_item":
      case "unarchive_checklist_item": return service.patchItem({ ...common, itemId: id.parse(itemId), ...mutation.parse(parsed), archived: operation === "archive_checklist_item" });
      case "move_checklist_item": return service.moveItem({ ...common, itemId: id.parse(itemId), ...folderOperationSchemas.move_checklist_item.parse(parsed) });
      case "set_checklist_item_assignee": return service.setItemAssignee({ ...common, itemId: id.parse(itemId), ...folderOperationSchemas.set_checklist_item_assignee.parse(parsed) });
      case "set_checklist_item_status": return service.setItemStatus({ ...common, itemId: id.parse(itemId), ...folderOperationSchemas.set_checklist_item_status.parse(parsed) });
    }
  })();
  return serializeChecklistMutation(result);
}

export async function readFolderSnapshot(service: ChecklistControlPlaneService, folderId: string, itemId?: string, view?: string) {
  z.enum(["full", "outline"]).parse(view ?? "full");
  const snapshot = await service.getFolder(folderId);
  if (!snapshot) throw Object.assign(new Error("Folder not found"), { statusCode: 404 });
  return serializeFolderSnapshot(snapshot, itemId, view === "outline");
}
