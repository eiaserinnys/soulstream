import type { ApiClient } from '../api/client';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import {
  attachmentContentUrl,
  attachmentMediaKind,
  isHtmlAttachmentView,
  isLegacyAttachmentImage,
  type AttachmentView,
} from './attachment-view';

type LegacyAttachmentApi = Pick<ApiClient, 'readLegacyAttachmentText'>
  & Partial<Pick<ApiClient, 'readLegacyAttachmentMedia'>>;

type AttachmentLinkContext = { context: AttachmentReadContext | null; invalid: boolean };
type ExactAttachmentLink =
  | { kind: 'id'; id: string; context: AttachmentLinkContext }
  | { kind: 'legacy'; nodeId: string; path: string; href: string; context: AttachmentLinkContext }
  | { kind: 'invalid' };

export function parseExactAttachmentLink(href: string, serverUrl: string): ExactAttachmentLink | null {
  let url: URL;
  try {
    url = new URL(href, serverUrl);
    if (url.origin !== new URL(serverUrl).origin) return null;
  } catch {
    return null;
  }

  const idMatch = /^\/api\/attachments\/([^/]+)\/content$/.exec(url.pathname);
  if (idMatch) {
    let id: string;
    try { id = decodeURIComponent(idMatch[1]); } catch { return { kind: 'invalid' }; }
    if (!id || id.includes('/')) return { kind: 'invalid' };
    return { kind: 'id', id, context: readContextFromUrl(url) };
  }

  if (url.pathname !== '/api/attachments/files') return null;
  const nodeId = url.searchParams.get('nodeId');
  const path = url.searchParams.get('path');
  if (url.searchParams.getAll('nodeId').length !== 1 || url.searchParams.getAll('path').length !== 1
    || !nodeId || !path) return { kind: 'invalid' };
  return { kind: 'legacy', nodeId, path, href: url.href, context: readContextFromUrl(url) };
}

function readContextFromUrl(url: URL): AttachmentLinkContext {
  const types = url.searchParams.getAll('context_type');
  const ids = url.searchParams.getAll('context_id');
  if (types.length === 0 && ids.length === 0) return { context: null, invalid: false };
  if (types.length !== 1 || ids.length > 1) return { context: null, invalid: true };
  const type = types[0];
  const id = ids[0];
  if (type === 'owner' && id === undefined) return { context: { type: 'owner' }, invalid: false };
  if (!id) return { context: null, invalid: true };
  if (type === 'session' || type === 'card' || type === 'page' || type === 'board_item') {
    return { context: { type, id }, invalid: false };
  }
  return { context: null, invalid: true };
}

export function resolveAttachmentReadContext(
  fromUrl: AttachmentLinkContext,
  fromProvider?: AttachmentReadContext,
): AttachmentReadContext | null {
  if (fromUrl.invalid) return null;
  return fromUrl.context ?? fromProvider ?? null;
}

async function readLegacyAttachmentView({ href, nodeId, path, context, jwt, api }: {
  href: string;
  nodeId: string;
  path: string;
  context: AttachmentReadContext;
  jwt: string | null;
  api: LegacyAttachmentApi | null;
}): Promise<AttachmentView> {
  const url = new URL(href);
  const response = await fetch(url.href, {
    method: 'HEAD',
    ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
  });
  if (!response.ok) throw { status: response.status };

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim() || null;
  const name = filenameFromContentDisposition(response.headers.get('content-disposition')) || filenameFromPath(path);
  const attachmentId = response.headers.get('x-attachment-id') || `${nodeId}:${path}`;
  const kind = previewKindForLegacy(mimeType, name);
  const originalUrl = new URL(url.href);
  originalUrl.searchParams.set('download', 'true');
  const view: AttachmentView = {
    key: attachmentId,
    name,
    mimeType,
    byteSize: null,
    previewKind: kind,
    readContext: context,
    source: {
      kind: 'ready',
      attachmentId,
      previewUrl: url.href,
      originalUrl: originalUrl.href,
    },
  };
  if (kind === 'text' && api) {
    view.loadText = (signal) => api.readLegacyAttachmentText(url.href, signal);
  }
  if (attachmentMediaKind(view) !== null && api?.readLegacyAttachmentMedia) {
    view.loadMedia = (signal) => api.readLegacyAttachmentMedia!(url.href, signal, {
      mimeType: view.mimeType,
      name: view.name,
    });
  }
  return view;
}

function previewKindForLegacy(mimeType: string | null, name: string): AttachmentView['previewKind'] {
  if (isLegacyAttachmentImage(name)) return 'image';
  if (mimeType?.startsWith('text/') || /\.(?:txt|md|json)$/i.test(name)
    || isHtmlAttachmentView({ mimeType: null, name })) return 'text';
  return 'info';
}

function filenameFromPath(path: string): string {
  const filename = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  try { return decodeURIComponent(filename); } catch { return filename; }
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { return null; }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim() || null;
}

export type AttachmentLink = { href: string; label: string };
export function scopedAttachmentUrl(href: string, serverUrl: string, context?: AttachmentReadContext): string {
  const parsed = parseExactAttachmentLink(href, serverUrl);
  if (!parsed || parsed.kind !== 'id' || parsed.context.invalid || parsed.context.context || !context || context.type === 'owner') return href;
  const url = new URL(href, serverUrl);
  url.searchParams.set('context_type', context.type);
  url.searchParams.set('context_id', context.id);
  return url.href;
}

export function attachmentLinkView(link: AttachmentLink, { serverUrl, jwt, api, readContext }: {
  serverUrl: string; jwt: string | null;
  api: Pick<ApiClient, 'getAttachmentMetadata' | 'readLegacyAttachmentText'>
    & Partial<Pick<ApiClient, 'readLegacyAttachmentMedia'>> | null;
  readContext?: AttachmentReadContext;
}): AttachmentView | null {
  const parsed = parseExactAttachmentLink(link.href, serverUrl);
  if (!parsed || parsed.kind === 'invalid') return null;
  const context = resolveAttachmentReadContext(parsed.context, readContext);
  if (!context || (parsed.kind === 'id' && !api)) return null;
  const key = parsed.kind === 'id' ? parsed.id : `${parsed.nodeId}:${parsed.path}`;
  // Hint the document layout before the HEAD resolves: an html/htm legacy path is a document.
  const legacyHtml = parsed.kind === 'legacy'
    && isHtmlAttachmentView({ mimeType: null, name: filenameFromPath(parsed.path) });
  return {
    key: `${key}:${context.type}:${'id' in context ? context.id : ''}`, name: link.label || (parsed.kind === 'legacy' ? filenameFromPath(parsed.path) : parsed.id),
    mimeType: legacyHtml ? 'text/html' : null, byteSize: null, previewKind: 'info', readContext: context,
    source: { kind: 'unavailable', availability: 'unresolved' },
    loadMetadata: async () => {
      if (parsed.kind === 'legacy') return readLegacyAttachmentView({ ...parsed, context, jwt, api });
      const { descriptor } = await api!.getAttachmentMetadata(parsed.id, context);
      return {
        key, name: descriptor.name, mimeType: descriptor.mime_type || null,
        byteSize: Number.isSafeInteger(descriptor.byte_size) && descriptor.byte_size >= 0 ? descriptor.byte_size : null,
        previewKind: descriptor.preview_kind, readContext: context,
        source: { kind: 'ready', attachmentId: parsed.id, previewUrl: attachmentContentUrl(parsed.id, context),
          originalUrl: attachmentContentUrl(parsed.id, context, { download: true }) },
      };
    },
  };
}
