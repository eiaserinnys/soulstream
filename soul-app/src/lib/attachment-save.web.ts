import type { AttachmentView } from './attachment-view';
import {
  clearAuthForScope,
  isAuthScopeCurrent,
  type AuthScopeSnapshot,
} from './auth-scope';

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

function resolveAttachmentOriginalUrl(view: AttachmentView, scope: AuthScopeSnapshot): string {
  if (view.source.kind !== 'ready' || !view.source.originalUrl) {
    throw new AttachmentSaveError('INVALID_ATTACHMENT_URL', '첨부 원본을 사용할 수 없습니다.');
  }
  try {
    const url = new URL(view.source.originalUrl, `${scope.serverUrl.replace(/\/+$/, '')}/`);
    const server = new URL(scope.serverUrl);
    if (url.origin !== server.origin || url.username || url.password) throw new Error('origin mismatch');
    return url.toString();
  } catch {
    throw new AttachmentSaveError('INVALID_ATTACHMENT_URL', '첨부 원본 주소가 올바르지 않습니다.');
  }
}

function attachmentSaveFilename(name: string): string {
  const safe = name.replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_').trim().replace(/^\.+$/, '');
  return safe || 'attachment';
}

function attachmentSaveHeaders(scope: AuthScopeSnapshot): Record<string, string> {
  return scope.jwt ? { Authorization: `Bearer ${scope.jwt}` } : {};
}

export async function saveAttachmentOriginal({ view, scope, signal }: AttachmentSaveInput): Promise<AttachmentSaveResult> {
  if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';

  let response: Response;
  try {
    response = await fetch(resolveAttachmentOriginalUrl(view, scope), {
      headers: attachmentSaveHeaders(scope),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) return 'cancelled';
    throw new AttachmentSaveError('DOWNLOAD_FAILED', '첨부 다운로드에 실패했습니다.');
  }
  if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';
  if (!response.ok) {
    if (response.status === 401) clearAuthForScope(scope);
    throw new AttachmentSaveError('DOWNLOAD_FAILED', `첨부 다운로드에 실패했습니다 (${response.status}).`);
  }
  if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';

  const blob = await response.blob();
  if (view.byteSize !== null && blob.size !== view.byteSize) {
    throw new AttachmentSaveError('DOWNLOAD_FAILED', '내려받은 첨부 파일을 확인할 수 없습니다.');
  }
  if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';

  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = attachmentSaveFilename(view.name);
    link.click();
    return 'shared';
  } catch (error) {
    throw new AttachmentSaveError('SHARE_FAILED', '첨부 파일을 저장하지 못했습니다.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
