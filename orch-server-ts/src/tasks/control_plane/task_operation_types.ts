export function taskPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_task";
  if (archived === false) return "unarchive_task";
  return "update_task";
}

export function sectionPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_checklist_section";
  if (archived === false) return "unarchive_checklist_section";
  return "update_checklist_section";
}

export function itemPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_checklist_item";
  if (archived === false) return "unarchive_checklist_item";
  return "update_checklist_item";
}
