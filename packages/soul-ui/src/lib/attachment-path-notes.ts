import { ATTACHMENT_PATH_NOTE_PREFIX, collectAttachmentPathNotes } from "@soulstream/wire-schema/attachment-path-notes";
import type { ChatAttachmentItem } from "./chat-attachment-model";

export function removeRepresentedAttachmentPathNotes(text: string, items: readonly ChatAttachmentItem[]): string {
  const paths = items.flatMap(item => [
    ...item.legacySources.map(source => source.path),
    ...(item.source.kind === "legacy" || item.source.kind === "unavailable" && item.source.path
      ? [item.source.path!] : []),
  ]);
  const notes = new Set(collectAttachmentPathNotes(paths));
  if (notes.size === 0) return text;
  const lines = text.split(/\r?\n/);
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1]!;
    if (line !== "" && !(line.startsWith(ATTACHMENT_PATH_NOTE_PREFIX) && line.endsWith("]"))) break;
    start -= 1;
  }
  const tail = lines.slice(start);
  if (!tail.some(line => notes.has(line))) return text;
  const remaining = [...lines.slice(0, start), ...tail.filter(line => !notes.has(line))];
  while (remaining.at(-1) === "") remaining.pop();
  return remaining.join("\n");
}
