export const ATTACHMENT_PATH_NOTE_PREFIX = "[첨부 파일 로컬 경로: ";

export function formatAttachmentPathNote(path: string): string {
  return `${ATTACHMENT_PATH_NOTE_PREFIX}${path}]`;
}

export function appendAttachmentPathNotes(text: string, paths?: readonly string[]): string {
  const noteLines = collectAttachmentPathNotes(paths);
  if (noteLines.length === 0) return text;

  const existingLines = new Set(text.split(/\r?\n/));
  const missing = noteLines.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return text;

  if (text.length === 0) return missing.join("\n");
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${missing.join("\n")}`;
}

function collectAttachmentPathNotes(paths?: readonly string[]): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const path of paths ?? []) {
    if (path.trim().length === 0 || seen.has(path)) continue;
    seen.add(path);
    notes.push(formatAttachmentPathNote(path));
  }
  return notes;
}
