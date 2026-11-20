import { clearAuthForScope, isAuthScopeCurrent } from './auth-scope';
import {
  attachmentSaveFilename,
  attachmentSaveHeaders,
  AttachmentSaveError,
  resolveAttachmentOriginalUrl,
  type AttachmentSaveInput,
  type AttachmentSaveResult,
} from './attachment-save-core';

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
