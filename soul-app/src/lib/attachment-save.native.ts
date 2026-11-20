import * as FileSystem from 'expo-file-system/legacy';
import { Platform, Share } from 'react-native';
import { clearAuthForScope, isAuthScopeCurrent } from './auth-scope';
import {
  attachmentSaveFilename,
  attachmentSaveHeaders,
  AttachmentSaveError,
  resolveAttachmentOriginalUrl,
  type AttachmentSaveInput,
  type AttachmentSaveResult,
} from './attachment-save-core';

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
