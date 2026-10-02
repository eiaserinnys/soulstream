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
import { uploadSessionFile } from "./uploadSessionFile";

export interface UploadDestination {
  uploadUrl: string;
  sessionId: string;
}

function sameDestination(a: UploadDestination | undefined, b: UploadDestination): boolean {
  return a?.uploadUrl === b.uploadUrl && a.sessionId === b.sessionId;
}

export interface UploadedFile {
  id: string;
  file: File;
  path: string | null;
  status: "uploading" | "done" | "error";
  destination?: UploadDestination;
  errorMessage?: string;
}

export interface UseFileUploadOptions {
  /** 업로드 URL. query string 포함 가능 (예: "/api/attachments/sessions?nodeId=node-1") */
  uploadUrl: string;
  /** 세션 ID — 프론트엔드에서 미리 생성한 UUID */
  sessionId: string;
  folderId?: string | null;
}

export interface UseFileUploadReturn {
  files: UploadedFile[];
  isUploading: boolean;
  /** Every retained attachment has a path at the current destination. */
  isReady: boolean;
  addFiles: (fileList: FileList | File[]) => void;
  removeFile: (id: string) => void;
  cancel: () => Promise<void>;
  resetLocal: () => void;
  restoreUploadedFiles: (files: UploadedFile[]) => void;
  uploadedPaths: string[];
}

export function useFileUpload({
  uploadUrl,
  sessionId,
  folderId,
}: UseFileUploadOptions): UseFileUploadReturn {
  const [entries, setEntries] = useState<UploadedFile[]>([]);
  const entriesRef = useRef(entries);
  const destinationRef = useRef<UploadDestination>({ uploadUrl, sessionId });
  destinationRef.current = { uploadUrl, sessionId };
  const previousDestinationRef = useRef(destinationRef.current);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const updateFiles = useCallback((update: (files: UploadedFile[]) => UploadedFile[]) => {
    entriesRef.current = update(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);
  const resetLocal = useCallback(() => {
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    updateFiles(() => []);
  }, [updateFiles]);

  const upload = useCallback((entry: UploadedFile, destination: UploadDestination) => {
    const controller = new AbortController();
    abortControllersRef.current.set(entry.id, controller);
    const currentRequest = () => abortControllersRef.current.get(entry.id) === controller
      && sameDestination(destination, destinationRef.current);
    uploadSessionFile({ file: entry.file, uploadUrl: destination.uploadUrl, sessionId: destination.sessionId, folderId, signal: controller.signal })
      .then(path => {
        if (!currentRequest()) return;
        updateFiles(files => files.map(file => file.id === entry.id ? { ...file, path, status: "done" } : file));
      })
      .catch(error => {
        if (!currentRequest()) return;
        updateFiles(files => files.map(file => file.id === entry.id ? { ...file, path: null, status: "error", errorMessage: error instanceof Error ? error.message : "첨부 업로드 실패" } : file));
      })
      .finally(() => {
        if (abortControllersRef.current.get(entry.id) === controller) abortControllersRef.current.delete(entry.id);
      });
  }, [folderId, updateFiles]);

  useEffect(() => () => {
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
  }, []);

  useEffect(() => {
    const destination = { uploadUrl, sessionId };
    const previous = previousDestinationRef.current;
    previousDestinationRef.current = destination;
    if (previous.sessionId !== sessionId) {
      // A different conversation keeps its own attachments; never migrate them.
      resetLocal();
      return;
    }
    if (sameDestination(previous, destination)) return;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    const next = entriesRef.current.map(entry => ({
      ...entry, path: null, errorMessage: undefined, status: uploadUrl ? "uploading" as const : "error" as const, destination,
    }));
    updateFiles(() => next);
    if (uploadUrl) for (const entry of next) upload(entry, destination);
  }, [uploadUrl, sessionId, resetLocal, updateFiles, upload]);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const destination = { uploadUrl, sessionId };
    const added = Array.from(fileList).map(file => ({
      id: crypto.randomUUID(), file, path: null,
      status: uploadUrl ? "uploading" as const : "error" as const, destination,
    }));
    updateFiles(files => [...files, ...added]);
    if (uploadUrl) for (const entry of added) upload(entry, destination);
  }, [uploadUrl, sessionId, updateFiles, upload]);

  const removeFile = useCallback((id: string) => {
    // 진행 중인 업로드는 abort
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }
    // 로컬 목록에서만 제거 (서버 DELETE 없음)
    updateFiles(files => files.filter(file => file.id !== id));
  }, [updateFiles]);

  const cancel = useCallback(async () => {
    resetLocal();

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
  }, [uploadUrl, sessionId, resetLocal]);

  const restoreUploadedFiles = useCallback((restored: UploadedFile[]) => {
    if (!restored.length) return;
    const destination = destinationRef.current;
    const normalized = restored.map(file => ({ ...file, destination: file.destination ?? destination }));
    updateFiles(current => {
      const ids = new Set(normalized.map(file => file.id));
      return [...normalized, ...current.filter(file => !ids.has(file.id))];
    });
  }, [updateFiles]);

  // Invalidate paths during render, before the node-change upload effect runs.
  const files = previousDestinationRef.current.sessionId !== sessionId ? [] : entries.map(file => (
    sameDestination(file.destination, destinationRef.current) ? file : { ...file, path: null, status: "uploading" as const }
  ));
  const isUploading = files.some((f) => f.status === "uploading");
  const uploadedPaths = files
    .filter((f) => f.status === "done" && f.path !== null)
    .map((f) => f.path as string);

  return {
    files,
    isUploading,
    isReady: files.every(file => file.status === "done" && file.path !== null),
    addFiles,
    removeFile,
    cancel,
    resetLocal,
    restoreUploadedFiles,
    uploadedPaths,
  };
}
