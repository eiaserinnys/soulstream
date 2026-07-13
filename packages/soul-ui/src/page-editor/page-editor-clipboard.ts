import {
  decodeStructuredClipboard,
  encodeStructuredClipboard,
  PAGE_BLOCK_CLIPBOARD_MIME,
  parseClipboard,
  serializeBlockSelection,
  type EditorBlockSnapshot,
  type ParsedClipboard,
  type StructuredClipboardCutSource,
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
  cut?: StructuredClipboardCutSource,
): boolean {
  try {
    const payload = serializeBlockSelection(snapshot, selectedBlockIds, cut);
    clipboard.setData(PAGE_BLOCK_CLIPBOARD_MIME, encodeStructuredClipboard(payload.structured));
    clipboard.setData("text/plain", payload.plainText);
    return true;
  } catch {
    try { clipboard.clearData?.(); } catch { /* the source selection remains untouched */ }
    return false;
  }
}

export function readPageEditorClipboard(clipboard: ClipboardDataPort): ParsedClipboard {
  return readPageEditorClipboardEnvelope(clipboard).payload;
}

export function readPageEditorClipboardEnvelope(clipboard: ClipboardDataPort): {
  payload: ParsedClipboard;
  cut?: StructuredClipboardCutSource;
} {
  const structuredText = clipboard.getData(PAGE_BLOCK_CLIPBOARD_MIME);
  let structured: ReturnType<typeof decodeStructuredClipboard> | undefined;
  let forcePlainText = false;
  try {
    structured = structuredText ? decodeStructuredClipboard(structuredText) : undefined;
  } catch {
    structured = undefined;
    forcePlainText = true;
  }
  return {
    payload: parseClipboard({
    plainText: clipboard.getData("text/plain"),
    html: clipboard.getData("text/html") || undefined,
    structured,
    files: Array.from(clipboard.files).map((file) => ({ type: file.type, name: file.name })),
    forcePlainText,
    }),
    ...(structured?.cut === undefined ? {} : { cut: structured.cut }),
  };
}

export function encodeClipboardStateVector(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
