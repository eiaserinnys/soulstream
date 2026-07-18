export function taskPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_task";
  if (archived === false) return "unarchive_task";
  return "update_task";
}

export function sectionPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_task_section";
  if (archived === false) return "unarchive_task_section";
  return "update_task_section";
}

export function itemPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_task_item";
  if (archived === false) return "unarchive_task_item";
  return "update_task_item";
}
