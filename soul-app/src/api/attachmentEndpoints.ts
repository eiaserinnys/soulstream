import type { ApiRequestContext } from './clientCore';
import { appendNativeUploadFile, type NativeUploadFile } from './nativeUpload';

export function createAttachmentEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    // 첨부 파일 업로드 (multipart). multipart Content-Type은 boundary 때문에 fetch가 자동 부착한다.
    uploadAttachment: (
      sessionId: string,
      nodeId: string,
      file: NativeUploadFile,
    ): Promise<{
      path?: string;
      filename?: string;
      [k: string]: any;
    }> => {
      const form = new FormData();
      form.append('session_id', sessionId);
      appendNativeUploadFile(form, 'file', file);
      return authFetch(
        `${base}/api/attachments/sessions?nodeId=${encodeURIComponent(nodeId)}`,
        {
          method: 'POST',
          body: form,
        },
      ).then((r) => readJson(r, 'uploadAttachment'));
    },
  };
}
