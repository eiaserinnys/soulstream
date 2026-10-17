import * as FileSystem from 'expo-file-system/legacy';
import { Platform, Share } from 'react-native';
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

export async function saveAttachmentOriginal({ view, scope, signal, anchor }: AttachmentSaveInput): Promise<AttachmentSaveResult> {
  if (Platform.OS !== 'ios') {
    throw new AttachmentSaveError('UNSUPPORTED_PLATFORM', '이 기기에서는 첨부 파일을 저장할 수 없습니다.');
  }
  if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';

  const url = resolveAttachmentOriginalUrl(view, scope);
  if (!FileSystem.cacheDirectory) {
    throw new AttachmentSaveError('DOWNLOAD_FAILED', '첨부 파일을 임시 저장할 수 없습니다.');
  }

  const directory = `${FileSystem.cacheDirectory}attachment-save/${createOperationId()}/`;
  const destination = `${directory}${attachmentSaveFilename(view.name)}`;
  let temporaryUri: string | null = null;

  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    temporaryUri = destination;
    const result = await FileSystem.downloadAsync(url, destination, {
      headers: attachmentSaveHeaders(scope),
    });
    if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';

    if (result.status < 200 || result.status >= 300) {
      if (result.status === 401) clearAuthForScope(scope);
      throw new AttachmentSaveError('DOWNLOAD_FAILED', `첨부 다운로드에 실패했습니다 (${result.status}).`);
    }

    const info = await FileSystem.getInfoAsync(temporaryUri);
    if (!info.exists || info.isDirectory || (view.byteSize !== null && info.size !== view.byteSize)) {
      throw new AttachmentSaveError('DOWNLOAD_FAILED', '내려받은 첨부 파일을 확인할 수 없습니다.');
    }
    if (signal?.aborted || !isAuthScopeCurrent(scope)) return 'cancelled';

    try {
      const shareOptions = anchor === undefined ? undefined : { anchor };
      const result = await Share.share({ url: temporaryUri }, shareOptions);
      return result.action === Share.sharedAction ? 'shared' : 'cancelled';
    } catch (error) {
      throw new AttachmentSaveError('SHARE_FAILED', '첨부 파일 공유를 열지 못했습니다.');
    }
  } finally {
    if (temporaryUri) await FileSystem.deleteAsync(temporaryUri, { idempotent: true });
  }
}

function createOperationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
