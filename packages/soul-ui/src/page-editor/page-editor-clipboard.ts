import {
  decodeStructuredClipboard,
  encodeStructuredClipboard,
  PAGE_BLOCK_CLIPBOARD_MIME,
  parseClipboard,
  serializeBlockSelection,
  type EditorBlockSnapshot,
  type ParsedClipboard,
} from "@soulstream/page-editor-core";

export interface ClipboardDataPort {
  readonly files: ArrayLike<{ readonly type?: string; readonly name?: string }>;
  getData(type: string): string;
  setData(type: string, value: string): void;
  clearData?(): void;
}

export function writeBlockSelectionClipboard(
  clipboard: ClipboardDataPort,
  snapshot: readonly EditorBlockSnapshot[],
  selectedBlockIds: readonly string[],
): boolean {
  try {
    const payload = serializeBlockSelection(snapshot, selectedBlockIds);
    clipboard.setData(PAGE_BLOCK_CLIPBOARD_MIME, encodeStructuredClipboard(payload.structured));
    clipboard.setData("text/plain", payload.plainText);
    return true;
  } catch {
    try { clipboard.clearData?.(); } catch { /* the source selection remains untouched */ }
    return false;
  }
}

export function readPageEditorClipboard(clipboard: ClipboardDataPort): ParsedClipboard {
  const structuredText = clipboard.getData(PAGE_BLOCK_CLIPBOARD_MIME);
  const structured = structuredText
    ? decodeStructuredClipboard(structuredText)
    : undefined;
  return parseClipboard({
    plainText: clipboard.getData("text/plain"),
    html: clipboard.getData("text/html") || undefined,
    structured,
    files: Array.from(clipboard.files).map((file) => ({ type: file.type, name: file.name })),
  });
}
