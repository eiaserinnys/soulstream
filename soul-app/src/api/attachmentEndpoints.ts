import type { ApiRequestContext } from './clientCore';
import { File } from 'expo-file-system';
import { appendNativeUploadFile, type NativeUploadFile } from './nativeUpload';
import { NATIVE_MULTIPART_THRESHOLD_BYTES, uploadNativeMultipart } from './nativeMultipartUpload';

export function createAttachmentEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    // 첨부 파일 업로드 (multipart). multipart Content-Type은 boundary 때문에 fetch가 자동 부착한다.
    uploadAttachment: async (
      sessionId: string,
      nodeId: string,
      file: NativeUploadFile,
      options: { folderId?: string; signal?: AbortSignal } = {},
    ): Promise<{
      path?: string;
      filename?: string;
      [k: string]: any;
    }> => {
      const localFile = new File(file.uri);
      if (!localFile.exists) throw new Error('[uploadAttachment] 첨부 파일을 찾을 수 없습니다');
      const size = localFile.size;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('[uploadAttachment] 첨부 파일 크기를 확인할 수 없습니다');
      }
      if (size >= NATIVE_MULTIPART_THRESHOLD_BYTES) {
        return uploadNativeMultipart({
          base,
          authFetch,
          readJson,
          sessionId,
          nodeId,
          file,
          folderId: options.folderId,
          signal: options.signal,
        });
      }

      const form = new FormData();
      form.append('session_id', sessionId);
      if (options.folderId !== undefined) form.append('folder_id', options.folderId);
      appendNativeUploadFile(form, 'file', file);
      return authFetch(
        `${base}/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`,
        {
          method: 'POST',
          body: form,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      ).then((r) => readJson(r, 'uploadAttachment'));
    },
  };
}
