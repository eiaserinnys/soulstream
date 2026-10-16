import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";

import { formatAttachmentPathNote } from "./attachment_path_note.js";
import { splitAttachmentPaths } from "./attachment_context.js";

export interface AttachmentTurnSource {
  sessionId: string;
  text: string;
  attachmentIds?: string[];
  attachmentPaths?: string[];
  attachmentBindings?: AttachmentPathBinding[];
  deliveryId?: string;
}

export type PreparedAttachmentInput = {
  text: string;
  attachmentPaths: string[];
  imageAttachmentPaths: string[];
};

export type PrepareAttachmentInput = (
  input: AttachmentTurnSource,
  signal?: AbortSignal,
) => Promise<PreparedAttachmentInput>;

type AttachmentMaterializer = ReturnType<
  typeof import("../attachments/attachment_materializer.js").createAttachmentMaterializer
>;

export function createAttachmentInputPreparer(
  materializer: AttachmentMaterializer,
): PrepareAttachmentInput {
  return async (input, signal) => {
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    const legacyPaths = [...new Set(input.attachmentPaths ?? [])];
    const materializedPaths = new Map<string, string>();

    for (const attachmentId of attachmentIds) {
      const request = {
        sessionId: input.sessionId,
        attachmentId,
        mode: "input" as const,
        ...(input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId }),
      };
      const attachment = await materializer.materialize(request, signal);
      materializedPaths.set(attachmentId, attachment.local_path);
    }

    const currentIds = new Set(attachmentIds);
    const currentLegacyPaths = new Set(legacyPaths);
    const boundLegacyPaths = new Set(
      (input.attachmentBindings ?? [])
        .filter((binding) => currentIds.has(binding.attachment_id) && currentLegacyPaths.has(binding.path))
        .map((binding) => binding.path),
    );
    const attachmentPaths: string[] = [];
    const seenPaths = new Set<string>();
    const appendPath = (path: string) => {
      if (seenPaths.has(path)) return;
      seenPaths.add(path);
      attachmentPaths.push(path);
    };

    for (const attachmentId of attachmentIds) {
      const cachePath = materializedPaths.get(attachmentId);
      if (cachePath !== undefined) appendPath(cachePath);
    }
    for (const path of legacyPaths) {
      if (!boundLegacyPaths.has(path)) appendPath(path);
    }

    return {
      text: input.text,
      attachmentPaths,
      imageAttachmentPaths: splitAttachmentPaths(attachmentPaths).imagePaths,
    };
  };
}

export function stripManagedAttachmentPathNotes(
  text: string,
  bindings: readonly AttachmentPathBinding[],
): string {
  const managedNotes = new Set(bindings.map((binding) => formatAttachmentPathNote(binding.path)));
  if (managedNotes.size === 0) return text;

  const lines = splitTextLines(text);
  let firstManagedLine = lines.length;
  while (firstManagedLine > 0 && managedNotes.has(lines[firstManagedLine - 1]!.text)) {
    firstManagedLine -= 1;
  }
  if (firstManagedLine === lines.length) return text;

  let result = text.slice(0, lines[firstManagedLine]!.start);
  for (let removedSeparators = 0; removedSeparators < 2; removedSeparators += 1) {
    if (result.endsWith("\r\n")) result = result.slice(0, -2);
    else if (result.endsWith("\n")) result = result.slice(0, -1);
    else break;
  }
  return result;
}

function splitTextLines(text: string): Array<{ start: number; text: string }> {
  const lines: Array<{ start: number; text: string }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    lines.push({ start, text: line.endsWith("\r") ? line.slice(0, -1) : line });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}
