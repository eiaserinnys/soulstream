import { validateChatUiDocument, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import { isRecord } from '../../../../packages/wire-schema/src/json_record';

export type ChatUiPublication =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'unsupported'; document: NormalizedChatUiDocumentV1 }
  | { kind: 'rich'; document: NormalizedChatUiDocumentV1; uiId: string; hash: string; revision: 1 };
export type ChatUiRichPublication = Extract<ChatUiPublication, { kind: 'rich' }>;

export function readChatUiPublication(data: unknown): ChatUiPublication {
  if (!isRecord(data) || !Object.hasOwn(data, 'ui')) return { kind: 'absent' };
  const ui = data.ui;
  if (!isRecord(ui)) return { kind: 'invalid' };
  const result = validateChatUiDocument(ui.document);
  if (!result.ok) return { kind: 'invalid' };
  if (ui.schema_version !== 1) return { kind: 'unsupported', document: result.document };
  if (typeof ui.ui_id !== 'string' || !ui.ui_id.trim()
    || typeof ui.hash !== 'string' || !/^[a-f0-9]{64}$/.test(ui.hash) || ui.revision !== 1) {
    return { kind: 'invalid' };
  }
  return { kind: 'rich', document: result.document, uiId: ui.ui_id, hash: ui.hash, revision: 1 };
}
