import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { CardAttachmentAssetEvidence } from '../api/cardTypes';

export const MAX_ATTACHMENT_TEXT_BYTES = 1024 * 1024;

export type AttachmentPreviewKind = 'image' | 'text' | 'info';

export type AttachmentView = {
  loadMetadata?: () => Promise<AttachmentView>;
  /** Loads a bounded body for views whose content is not fetched by ID (legacy paths). */
  loadText?: (signal: AbortSignal) => Promise<{ text: string; truncated: boolean }>;
  key: string;
  name: string;
  mimeType: string | null;
  byteSize: number | null;
  previewKind: AttachmentPreviewKind;
  readContext: AttachmentReadContext;
  source:
    | {
      kind: 'ready';
      attachmentId: string;
      previewUrl: string | null;
      originalUrl: string;
    }
    | {
      kind: 'unavailable';
      availability: 'unresolved' | 'missing' | 'unavailable';
    };
};

export function toCardAttachmentView(evidence: CardAttachmentAssetEvidence): AttachmentView {
  if ('availability' in evidence) {
    return {
      key: evidence.attachment_id,
      name: evidence.label,
      mimeType: null,
      byteSize: null,
      previewKind: evidence.type === 'image' ? 'image' : 'info',
      readContext: evidence.read_context,
      source: { kind: 'unavailable', availability: evidence.availability },
    };
  }

  const { descriptor } = evidence;
  const originalUrl = nonEmptyUrl(evidence.originalUrl);
  return {
    key: evidence.attachment_id,
    name: descriptor.name,
    mimeType: descriptor.mime_type || null,
    byteSize: validByteSize(descriptor.byte_size),
    previewKind: descriptor.preview_kind,
    readContext: evidence.read_context,
    source: originalUrl
      ? {
        kind: 'ready',
        attachmentId: evidence.attachment_id,
        previewUrl: nonEmptyUrl(evidence.previewUrl),
        originalUrl,
      }
      : { kind: 'unavailable', availability: 'unresolved' },
  };
}

export function attachmentContentUrl(
  id: string,
  context: AttachmentReadContext,
  options: { download?: boolean } = {},
): string {
  const query = new URLSearchParams();
  if (context.type !== 'owner') {
    query.set('context_type', context.type);
    query.set('context_id', context.id);
  }
  if (options.download) query.set('download', 'true');
  const queryString = query.toString();
  return `/api/attachments/${encodeURIComponent(id)}/content${queryString ? `?${queryString}` : ''}`;
}

function nonEmptyUrl(value: string | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validByteSize(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Preserve the legacy app image extension contract; descriptor previews use preview_kind. */
export function isLegacyAttachmentImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|heic|avif)$/i.test(path);
}

/** HTML attachments open as documents: text/html (parameters stripped) or an html/htm name. */
export function isHtmlAttachmentView(view: Pick<AttachmentView, 'mimeType' | 'name'>): boolean {
  const mimeType = view.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return mimeType === 'text/html' || /\.html?$/i.test(view.name);
}
