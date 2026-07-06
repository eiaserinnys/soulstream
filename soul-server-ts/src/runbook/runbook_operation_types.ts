export function runbookPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_runbook";
  if (archived === false) return "unarchive_runbook";
  return "update_runbook";
}

export function sectionPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_runbook_section";
  if (archived === false) return "unarchive_runbook_section";
  return "update_runbook_section";
}

export function itemPatchOperationType(archived: boolean | undefined): string {
  if (archived === true) return "archive_runbook_item";
  if (archived === false) return "unarchive_runbook_item";
  return "update_runbook_item";
}
