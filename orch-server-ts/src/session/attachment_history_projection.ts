export interface InputAttachmentProjection {
  attachment_ids: string[];
  attachments: string[];
  attachment_count: number;
}

export function projectInputAttachments(input: {
  attachment_ids?: unknown;
  attachments?: unknown;
  attachment_count?: unknown;
}): InputAttachmentProjection {
  const attachmentIds = uniqueNonEmptyStrings(input.attachment_ids);
  const attachments = uniqueNonEmptyStrings(input.attachments);
  const storedAttachmentCount = input.attachment_count;
  const useStoredAttachmentCount = typeof storedAttachmentCount === "number"
    && Number.isSafeInteger(storedAttachmentCount)
    && (attachmentIds.length > 0
      ? storedAttachmentCount >= attachmentIds.length
        && storedAttachmentCount <= attachmentIds.length + attachments.length
      : storedAttachmentCount === attachments.length);
  return {
    attachment_ids: attachmentIds,
    attachments,
    attachment_count: useStoredAttachmentCount
      ? storedAttachmentCount
      : attachmentIds.length > 0 ? attachmentIds.length : attachments.length,
  };
}

function uniqueNonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) unique.add(item);
  }
  return [...unique];
}
