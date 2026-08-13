import type {
  ChecklistTaskBlockProperties,
  ChecklistTaskReference,
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
  if (type === "task_ref") {
    return requiredFields(["taskId", "string"], ["primary", "boolean"]);
  }
  if (type === "checklist") {
    const checkedError = required("checked", "boolean");
    if (checkedError) return checkedError;
    const hasTaskId = value.taskId !== undefined;
    const hasItemId = value.itemId !== undefined;
    if (hasTaskId || hasItemId) {
      return requiredFields(["taskId", "string"], ["itemId", "string"]);
    }
    return null;
  }
  if (type === "custom_view") return required("customViewId", "string");
  if (type === "image") {
    return requiredFields(["assetId", "string"], ["alt", "string"]);
  }
  return null;
}

/** Exact reachable properties for a Task-backed checklist block. */
export function checklistTaskBlockProperties(
  reference: ChecklistTaskReference,
  checked: boolean,
): ChecklistTaskBlockProperties {
  return {
    checked,
    taskId: reference.taskId,
    itemId: reference.itemId,
  };
}
