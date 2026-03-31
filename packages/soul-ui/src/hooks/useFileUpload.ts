/**
 * useFileUpload - 파일 업로드 상태 및 로직 훅
 *
 * - addFiles: 파일을 즉시 목록에 추가(optimistic) → 서버 업로드 → 결과 반영
 * - removeFile: 로컬 목록에서만 제거 (서버 DELETE 없음 — 세션 디렉토리 전체 단위로만 삭제 가능)
 * - cancel: 로컬 초기화 + 서버 파일 전체 정리
 * - resetLocal: 로컬 초기화만 (제출 성공 후 호출 — 서버 파일은 Claude가 읽어야 하므로 유지)
 * - uploadedPaths: status==="done"인 파일들의 서버 경로 목록
 * - isUploading: 하나라도 uploading이면 true (Submit 버튼 비활성화에 사용)
 */

import { useState, useCallback, useRef, useEffect } from "react";

export interface UploadedFile {
  id: string;
  file: File;
  path: string | null;
  status: "uploading" | "done" | "error";
}

export interface UseFileUploadOptions {
  /** 업로드 URL. query string 포함 가능 (예: "/api/attachments/sessions?nodeId=node-1") */
  uploadUrl: string;
  /** 세션 ID — 프론트엔드에서 미리 생성한 UUID */
  sessionId: string;
}

export interface UseFileUploadReturn {
  files: UploadedFile[];
  isUploading: boolean;
  addFiles: (fileList: FileList | File[]) => void;
  removeFile: (id: string) => void;
  cancel: () => Promise<void>;
  resetLocal: () => void;
  uploadedPaths: string[];
}

export function useFileUpload({
  uploadUrl,
  sessionId,
}: UseFileUploadOptions): UseFileUploadReturn {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // 컴포넌트 unmount 시 진행 중인 업로드 abort
  useEffect(() => {
    return () => {
      for (const controller of abortControllersRef.current.values()) {
        controller.abort();
      }
    };
  }, []);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const fileArray = Array.from(fileList);
      const newEntries: UploadedFile[] = fileArray.map((file) => ({
        id: crypto.randomUUID(),
        file,
        path: null,
        status: "uploading" as const,
      }));

      setFiles((prev) => [...prev, ...newEntries]);

      // 각 파일을 비동기로 업로드
      for (const entry of newEntries) {
        const controller = new AbortController();
        abortControllersRef.current.set(entry.id, controller);

        const formData = new FormData();
        formData.append("file", entry.file);
        formData.append("session_id", sessionId);

        fetch(uploadUrl, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        })
          .then(async (res) => {
            if (!res.ok) {
              throw new Error(`Upload failed: ${res.status}`);
            }
            const data = await res.json();
            const serverPath: string = data.path ?? data.file_path ?? null;

            setFiles((prev) =>
              prev.map((f) =>
                f.id === entry.id
                  ? { ...f, path: serverPath, status: "done" }
                  : f,
              ),
            );
          })
          .catch((err) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              // 의도적 취소 — setFiles 호출 없음
              return;
            }
            setFiles((prev) =>
              prev.map((f) =>
                f.id === entry.id ? { ...f, status: "error" } : f,
              ),
            );
          })
          .finally(() => {
            abortControllersRef.current.delete(entry.id);
          });
      }
    },
    [uploadUrl, sessionId],
  );

  const removeFile = useCallback((id: string) => {
    // 진행 중인 업로드는 abort
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }
    // 로컬 목록에서만 제거 (서버 DELETE 없음)
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const cancel = useCallback(async () => {
    // 진행 중인 업로드 전부 abort
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setFiles([]);

    // 서버 파일 정리 — best-effort (실패해도 무시)
    if (!sessionId) return;
    try {
      // uploadUrl에 query string이 포함될 수 있으므로 split하여 조립
      const [basePath, qs] = uploadUrl.split("?");
      const deleteUrl = `${basePath}/${sessionId}${qs ? "?" + qs : ""}`;
      await fetch(deleteUrl, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      }).catch(() => {
        // best-effort — 실패 무시
      });
    } catch {
      // best-effort — 실패 무시
    }
  }, [uploadUrl, sessionId]);

  const resetLocal = useCallback(() => {
    // 진행 중인 업로드 abort
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    // 로컬 상태만 초기화 — 서버 파일은 보존 (Claude가 읽어야 함)
    setFiles([]);
  }, []);

  const isUploading = files.some((f) => f.status === "uploading");
  const uploadedPaths = files
    .filter((f) => f.status === "done" && f.path !== null)
    .map((f) => f.path as string);

  return {
    files,
    isUploading,
    addFiles,
    removeFile,
    cancel,
    resetLocal,
    uploadedPaths,
  };
}
