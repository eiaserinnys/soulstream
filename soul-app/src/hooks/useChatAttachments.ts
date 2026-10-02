import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert as RNAlert } from 'react-native';
import { ActionSheetIOS, DocumentPicker, ImagePicker } from './attachmentPickers';
import type { ApiClient } from '../api/client';
import type { NativeUploadFile } from '../api/nativeUpload';

export interface ChatAttachment {
  path: string;
  name: string;
  nodeId?: string;
  mimeType?: string;
  originalFile?: NativeUploadFile;
}

export type AttachmentUploadInput = NativeUploadFile;

interface UseChatAttachmentsArgs {
  /** API client. null이면 업로드 시도 시 no-op. */
  api: ApiClient | null;
  /** 현재 세션 ID. undefined면 업로드 시도 시 no-op. */
  sessionId: string | undefined;
  /** 세션이 속한 노드 ID (session?.nodeId). undefined면 사용자 알림 후 종료. */
  nodeId: string | undefined;
  /** current-open session이 offline인 동안 picker와 direct upload를 모두 막는다. */
  disabled?: boolean;
  /** Optional display URL for consumers outside chat; upload transport stays the same. */
  mapUploadedPath?: (path: string, nodeId: string) => string;
  /** Draft cards keep their files when the execution node changes. */
  reuploadOnNodeChange?: boolean;
}

export interface UseChatAttachmentsResult {
  attachments: ChatAttachment[];
  uploading: boolean;
  attachmentsReady: boolean;
  error: string | null;
  pickAttachment: () => void;
  uploadAttachment: (file: AttachmentUploadInput) => Promise<void>;
  removeAttachment: (idx: number) => void;
  restoreAttachments: (attachments: ChatAttachment[]) => void;
  /**
   * 첨부 목록을 비운다. `useCallback(..., [])`로 안정 참조이므로
   * 호출자(마운트 effect, handleSend)가 deps에 추가하지 않아도 클로저 손실이 없다.
   */
  clearAttachments: () => void;
}

/**
 * 채팅 첨부 파일 picker + 업로드 + 목록 상태 훅.
 *
 * 책임: ActionSheet → ImagePicker/DocumentPicker → api.uploadAttachment → 목록 갱신.
 * 본 훅은 첨부 관련 사이드이펙트의 정본이며, 상위 컴포넌트는 결과 목록과 트리거 함수만 사용한다.
 */
export function useChatAttachments(
  args: UseChatAttachmentsArgs,
): UseChatAttachmentsResult {
  const { api, sessionId, nodeId, disabled = false, mapUploadedPath, reuploadOnNodeChange = false } = args;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const currentNode = useRef(nodeId);
  if (currentNode.current !== nodeId) {
    currentNode.current = nodeId;
    if (reuploadOnNodeChange) generation.current++;
  }

  useEffect(() => {
    if (!reuploadOnNodeChange || !api || !sessionId || !nodeId) return;
    const files = attachments.filter((item) => item.nodeId !== nodeId && item.originalFile);
    if (!files.length) return;
    const revision = generation.current;
    let active = true;
    setUploading(true); setError(null);
    void (async () => {
      try {
        // All responses belong to one node revision. Removal is checked again at commit.
        const uploaded: Array<{ item: ChatAttachment; path: string }> = [];
        for (const item of files) {
          const response = await api.uploadAttachment(sessionId, nodeId, item.originalFile!);
          if (!active || revision !== generation.current) return;
          if (!response.path) throw new Error('서버 응답에 경로가 없습니다.');
          uploaded.push({ item, path: response.path });
        }
        setAttachments((current) => current.map((item) => {
          const upload = uploaded.find((entry) => entry.item === item);
          return upload ? { ...item, path: upload.path, nodeId } : item;
        }));
      } catch (cause) {
        if (!active || revision !== generation.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message); RNAlert.alert('첨부 실패', message);
      } finally { if (active && revision === generation.current) setUploading(false); }
    })();
    return () => { active = false; };
    // Only a node transition starts reupload. Failure/removal does not auto retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, nodeId, reuploadOnNodeChange]);

  const uploadAttachment = useCallback(
    async (file: AttachmentUploadInput) => {
      if (!api || !sessionId || disabledRef.current) return;
      const targetNodeId = nodeId;
      if (!targetNodeId) {
        RNAlert.alert(
          '첨부 실패',
          '세션의 노드 정보를 알 수 없어 파일을 업로드할 수 없습니다.',
        );
        return;
      }
      setUploading(true);
      setError(null);
      const revision = generation.current;
      const draftFile: ChatAttachment = { path: '', name: file.name, nodeId: '',
        mimeType: file.type || 'application/octet-stream', originalFile: file };
      if (reuploadOnNodeChange) setAttachments((prev) => [...prev, draftFile]);
      try {
        const res = await api.uploadAttachment(sessionId, targetNodeId, file);
        const path = (res as any)?.path;
        if (typeof path !== 'string' || !path) {
          throw new Error('서버 응답에 경로가 없습니다.');
        }
        if (revision !== generation.current) return;
        const uploaded = { ...draftFile, path: mapUploadedPath ? mapUploadedPath(path, targetNodeId) : path, nodeId: targetNodeId };
        setAttachments((prev) => reuploadOnNodeChange
          ? prev.map((item) => item === draftFile ? uploaded : item)
          : [...prev, uploaded]);
      } catch (e: any) {
        if (revision !== generation.current) return;
        setError(e?.message ?? '알 수 없는 오류');
        RNAlert.alert('첨부 실패', e?.message ?? '알 수 없는 오류');
      } finally {
        if (revision === generation.current) setUploading(false);
      }
    },
    [api, sessionId, nodeId, mapUploadedPath, reuploadOnNodeChange],
  );

  const pickAttachment = useCallback(() => {
    if (disabledRef.current) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['사진/동영상 선택', '파일 선택', '취소'],
        cancelButtonIndex: 2,
        title: '첨부',
      },
      async (idx) => {
        if (disabledRef.current || (idx !== 0 && idx !== 1)) return;
        setUploading(true);
        try {
          if (idx === 0) {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (disabledRef.current) return;
            if (!perm.granted) {
              RNAlert.alert(
                '권한 필요',
                '사진 라이브러리 접근 권한을 허용해주세요.',
              );
              return;
            }
            const res = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images', 'videos'],
              quality: 0.9,
              shouldDownloadFromNetwork: true,
            });
            if (disabledRef.current) return;
            if (res.canceled || res.assets.length === 0) return;
            const a = res.assets[0];
            await uploadAttachment({
              uri: a.uri,
              name: a.fileName ?? `image-${Date.now()}.jpg`,
              type: a.mimeType ?? 'image/jpeg',
            });
          } else {
            const res = await DocumentPicker.getDocumentAsync({
              copyToCacheDirectory: true,
            });
            if (disabledRef.current) return;
            if (res.canceled || res.assets.length === 0) return;
            const a = res.assets[0];
            await uploadAttachment({
              uri: a.uri,
              name: a.name,
              type: a.mimeType ?? 'application/octet-stream',
            });
          }
        } catch (e: any) {
          RNAlert.alert('첨부 실패', e?.message ?? '알 수 없는 오류');
        } finally {
          setUploading(false);
        }
      },
    );
  }, [uploadAttachment]);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
    setError(null);
  }, []);

  const clearAttachments = useCallback(() => {
    generation.current++; setAttachments([]); setUploading(false); setError(null);
  }, []);
  const restoreAttachments = useCallback((restored: ChatAttachment[]) => {
    setAttachments((current) => [...restored, ...current]);
  }, []);

  return {
    attachments,
    uploading,
    attachmentsReady: !uploading && (!reuploadOnNodeChange || attachments.every((file) => !!file.path && file.nodeId === nodeId)),
    error,
    pickAttachment,
    uploadAttachment,
    removeAttachment,
    clearAttachments,
    restoreAttachments,
  };
}
