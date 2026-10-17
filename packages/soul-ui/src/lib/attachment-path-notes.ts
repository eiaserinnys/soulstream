import type { ChatAttachmentItem } from "./chat-attachment-model";

export const ATTACHMENT_PATH_NOTE_PREFIX = "[첨부 파일 로컬 경로: ";

/** Display-only removal; the durable message and similar user prose stay intact. */
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

export function appendAttachmentPathNotes(text: string, paths?: readonly string[]): string {
  const notes = collectAttachmentPathNotes(paths);
  if (notes.length === 0) return text;

  const existingLines = new Set(text.split(/\r?\n/));
  const missing = notes.filter((note) => !existingLines.has(note));
  if (missing.length === 0) return text;

  if (text.length === 0) return missing.join("\n");
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${missing.join("\n")}`;
}

function collectAttachmentPathNotes(paths?: readonly string[]): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const path of paths ?? []) {
    if (path.trim().length === 0 || seen.has(path)) continue;
    seen.add(path);
    notes.push(`${ATTACHMENT_PATH_NOTE_PREFIX}${path}]`);
  }
  return notes;
}
