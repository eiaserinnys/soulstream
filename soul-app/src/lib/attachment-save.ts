import type { AttachmentView } from './attachment-view';
import type { AuthScopeSnapshot } from './auth-scope';

export type AttachmentSaveResult = 'shared' | 'cancelled';

export type AttachmentSaveInput = {
  view: AttachmentView;
  scope: AuthScopeSnapshot;
  signal?: AbortSignal;
  anchor?: number;
};

export type AttachmentSaveErrorCode =
  | 'INVALID_ATTACHMENT_URL'
  | 'DOWNLOAD_FAILED'
  | 'SHARE_FAILED'
  | 'UNSUPPORTED_PLATFORM';

export class AttachmentSaveError extends Error {
  readonly code: AttachmentSaveErrorCode;

  constructor(code: AttachmentSaveErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentSaveError';
    this.code = code;
  }
}

export function resolveAttachmentOriginalUrl(view: AttachmentView, scope: AuthScopeSnapshot): string {
  if (view.source.kind !== 'ready' || !view.source.originalUrl) {
    throw new AttachmentSaveError('INVALID_ATTACHMENT_URL', '첨부 원본을 사용할 수 없습니다.');
  }

  try {
    const url = new URL(view.source.originalUrl, `${scope.serverUrl.replace(/\/+$/, '')}/`);
    const server = new URL(scope.serverUrl);
    if (url.origin !== server.origin || url.username || url.password) throw new Error('origin mismatch');
    return url.toString();
  } catch (error) {
    throw new AttachmentSaveError('INVALID_ATTACHMENT_URL', '첨부 원본 주소가 올바르지 않습니다.');
  }
}

export function attachmentSaveFilename(name: string): string {
  const safe = name
    .replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/^\.+$/, '');
  return safe || 'attachment';
}

export function attachmentSaveHeaders(scope: AuthScopeSnapshot): Record<string, string> {
  return scope.jwt ? { Authorization: `Bearer ${scope.jwt}` } : {};
}
