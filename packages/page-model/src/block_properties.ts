import type {
  LinkedChecklistBlockProperties,
  ChecklistItemReference,
} from "./types.js";

/** Canonical runtime contract for properties crossing a Page Y.Doc write boundary. */
export function validatePageBlockProperties(
  type: string,
  value: Record<string, unknown>,
): string | null {
  const required = (key: string, kind: "string" | "boolean"): string | null => {
    if (typeof value[key] !== kind || (kind === "string" && !(value[key] as string).trim())) {
      return `${type}.${key} must be a ${kind}`;
    }
    return null;
  };
  const requiredFields = (...fields: Array<readonly [string, "string" | "boolean"]>) => {
    for (const [key, kind] of fields) {
      const error = required(key, kind);
      if (error) return error;
    }
    return null;
  };

  if (type === "session_ref") {
    return requiredFields(["sessionId", "string"], ["primary", "boolean"]);
  }
  if (type === "atom_ref") {
    const requiredError = required("nodeId", "string");
    if (requiredError) return requiredError;
    if (!["atom", "atom-nl"].includes(String(value.instance))) {
      return "atom_ref.instance invalid";
    }
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || Number(value.limit) < 1)) {
      return "atom_ref.limit must be a positive integer";
    }
    return null;
  }
  if (type === "guidance") {
    return requiredFields(["enabled", "boolean"], ["scope", "string"]);
  }
  if (type === "session_defaults") return required("scope", "string");
  if (type === "folder_ref") {
    return requiredFields(["folderId", "string"], ["primary", "boolean"]);
  }
  if (type === "checklist") {
    const checkedError = required("checked", "boolean");
    if (checkedError) return checkedError;
    const hasFolderId = value.folderId !== undefined;
    const hasItemId = value.itemId !== undefined;
    if (hasFolderId || hasItemId) {
      return requiredFields(["folderId", "string"], ["itemId", "string"]);
    }
    return null;
  }
  if (type === "custom_view") return required("customViewId", "string");
  if (type === "image") {
    return requiredFields(["assetId", "string"], ["alt", "string"]);
  }
  return null;
}

/** Exact reachable properties for a Folder-backed checklist block. */
export function checklistFolderBlockProperties(
  reference: ChecklistItemReference,
  checked: boolean,
): LinkedChecklistBlockProperties {
  return {
    checked,
    folderId: reference.folderId,
    itemId: reference.itemId,
  };
}
