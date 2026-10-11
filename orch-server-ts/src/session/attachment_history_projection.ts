export interface InputAttachmentProjection {
  attachment_ids: string[];
  attachments: string[];
  attachment_count: number;
}

export function projectInputAttachments(input: {
  attachment_ids?: unknown;
  attachments?: unknown;
}): InputAttachmentProjection {
  const attachmentIds = uniqueNonEmptyStrings(input.attachment_ids);
  const attachments = uniqueNonEmptyStrings(input.attachments);
  return {
    attachment_ids: attachmentIds,
    attachments,
    attachment_count: attachmentIds.length > 0 ? attachmentIds.length : attachments.length,
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
