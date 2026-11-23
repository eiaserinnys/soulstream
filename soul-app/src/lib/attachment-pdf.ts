import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

export type AttachmentReadFailureKind =
  | 'unauthorized'
  | 'denied'
  | 'not-found'
  | 'conflict'
  | 'retryable'
  | 'preview-failed';

/** Carries the failure class the preview modal already knows how to phrase. */
export class AttachmentReadFailure extends Error {
  readonly kind: AttachmentReadFailureKind;

  constructor(kind: AttachmentReadFailureKind) {
    super(`attachment read failed: ${kind}`);
    this.name = 'AttachmentReadFailure';
    this.kind = kind;
  }
}

const PDF_CACHE_DIRECTORY = 'attachment-pdf';
let temporarySequence = 0;

/**
 * Resolve a URI the platform document viewer can open without HTTP headers.
 *
 * iOS WebView loads file URLs without the app's Authorization header, and the
 * server sends PDF as `Content-Disposition: attachment`, so the document is
 * downloaded once into the cache directory. Web has no such WebView: the
 * response becomes a blob URL an iframe can draw.
 */
export async function attachmentPdfViewerUri({
  uri,
  headers,
  cacheKey,
  cache = 'persistent',
  signal,
}: {
  uri: string;
  headers?: Record<string, string>;
  cacheKey: string;
  cache?: 'persistent' | 'none';
  signal: AbortSignal;
}): Promise<string> {
  if (!uri) throw new AttachmentReadFailure('preview-failed');
  if (Platform.OS === 'web') {
    if (/^(?:blob|data):/i.test(uri)) return uri;
    let response: Response;
    try {
      response = await fetch(uri, { ...(headers ? { headers } : {}), signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AttachmentReadFailure('retryable');
    }
    if (!response.ok) throw new AttachmentReadFailure(pdfFailureKindForStatus(response.status));
    const blob = await response.blob();
    if (blob.size === 0) throw new AttachmentReadFailure('preview-failed');
    return URL.createObjectURL(blob);
  }
  if (/^file:/i.test(uri)) return uri;
  const directory = new Directory(Paths.cache, PDF_CACHE_DIRECTORY);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${pdfCacheName(cacheKey)}${cache === 'none' ? `-${Date.now()}-${temporarySequence++}` : ''}.pdf`);
  if (cache === 'persistent' && file.exists) return file.uri;
  try {
    const downloaded = await File.downloadFileAsync(uri, file, {
      ...(headers ? { headers } : {}),
      idempotent: true,
      signal,
    });
    return downloaded.uri;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AttachmentReadFailure(pdfFailureKindForStatus(pdfStatusFromError(error)));
  }
}

export function pdfFailureKindForStatus(status: number | undefined): AttachmentReadFailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === undefined || status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'preview-failed';
}

function pdfStatusFromError(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = Number((error as { status: unknown }).status);
    if (Number.isInteger(status)) return status;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(?:status|code)[ :]*(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** Cache names keep a readable tail of the attachment key and stay filesystem safe. */
export function pdfCacheName(cacheKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < cacheKey.length; index += 1) {
    hash ^= cacheKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const readable = cacheKey.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(-60);
  return `${readable || 'attachment'}-${(hash >>> 0).toString(16)}`;
}

export function releaseTemporaryPdf(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn('Failed to remove temporary PDF', error);
  }
}
