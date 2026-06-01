export const ATTACHMENT_PATH_NOTE_PREFIX = "[첨부 파일 로컬 경로: ";

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
