import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import type { BoardContainerRef, MarkdownDocument } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  getMarkdownPreview,
  getBoardYjsRuntime,
  subscribeBoardYjsRuntime,
  type BoardYjsRuntime,
} from "../board-workspace";
import { Button } from "./ui/button";
import { MarkdownContent } from "./MarkdownContent";
import {
  deleteMarkdownDocument,
  fetchMarkdownDocument,
  MarkdownDocumentConflictError,
  updateMarkdownDocument,
} from "../lib/markdown-document-operations";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "conflict";

const MarkdownCodeMirrorEditor = lazy(async () => {
  const module = await import("./MarkdownCodeMirrorEditor");
  return { default: module.MarkdownCodeMirrorEditor };
});

export function MarkdownDocumentPanel() {
  const documentId = useDashboardStore((s) => s.activeBoardDocumentId);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const activeBoardContainer = useDashboardStore((s) => s.activeBoardContainer);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const boardContainer = useMemo<BoardContainerRef | null>(
    () => activeBoardContainer ?? (selectedFolderId ? { kind: "folder", id: selectedFolderId } : null),
    [activeBoardContainer, selectedFolderId],
  );
  const runtime = useBoardRuntime(boardContainer);
  const yText = useMemo(
    () => (documentId && runtime ? runtime.getMarkdownText(documentId) : null),
    [documentId, runtime],
  );
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [isEditingBody, setIsEditingBody] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [savedTitle, setSavedTitle] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [savedVersion, setSavedVersion] = useState(1);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editBodySnapshotRef = useRef("");
  const skipNextBlurSaveRef = useRef(false);

  const clearSaveTimer = useCallback(() => {
    if (!saveTimerRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  const applyRuntimeSnapshot = useCallback(() => {
    if (!documentId || !runtime) return;
    const item = runtime.getBoardItems().find((candidate) => candidate.id === `markdown:${documentId}`);
    const nextTitle = getMetadataText(item?.metadata, "title") || "Untitled document";
    const nextBody = runtime.getMarkdownText(documentId).toString();
    const nextVersion = getMetadataNumber(item?.metadata, "version") ?? 1;
    const nextDocument = { id: documentId, title: nextTitle, body: nextBody, version: nextVersion };
    setDocument(nextDocument);
    setTitle(nextTitle);
    setBody(nextBody);
    setSavedTitle(nextTitle);
    setSavedBody(nextBody);
    setSavedVersion(nextVersion);
    setSaveError(null);
    setSaveStatus("saved");
  }, [documentId, runtime]);

  const saveNow = useCallback(async () => {
    if (!documentId) return;
    clearSaveTimer();
    const currentTitle = title.trim() || "Untitled document";
    if (runtime) {
      runtime.updateMarkdownTitle(documentId, currentTitle);
      if (!yText || yText.toString() !== body) {
        runtime.updateMarkdownBody(documentId, body);
      }
      setSavedTitle(currentTitle);
      setSavedBody(body);
      setSaveStatus("saved");
      return;
    }
    if (currentTitle === savedTitle && body === savedBody) {
      setSaveStatus("saved");
      return;
    }
    setSaveError(null);
    setSaveStatus("saving");
    try {
      const updated = await updateMarkdownDocument({
        documentId,
        title: currentTitle,
        body,
        expectedVersion: savedVersion,
      });
      setDocument(updated);
      setTitle(updated.title);
      setBody(updated.body);
      setSavedTitle(updated.title);
      setSavedBody(updated.body);
      setSavedVersion(updated.version);
      setSaveStatus("saved");
    } catch (err) {
      if (err instanceof MarkdownDocumentConflictError) {
        setSaveError(null);
        setSaveStatus("conflict");
      } else {
        setSaveError(err instanceof Error ? err.message : "문서를 저장하지 못했습니다.");
        setSaveStatus("dirty");
        console.error("Markdown document save failed:", err);
      }
    }
  }, [body, clearSaveTimer, documentId, runtime, savedBody, savedTitle, savedVersion, title, yText]);

  useEffect(() => {
    clearSaveTimer();
    skipNextBlurSaveRef.current = false;
    if (!documentId) return;
    setDocument(null);
    setIsEditingBody(false);
    setSaveError(null);
    setSaveStatus("idle");
    if (runtime) {
      applyRuntimeSnapshot();
      return;
    }

    let cancelled = false;
    fetchMarkdownDocument(documentId)
      .then((next) => {
        if (cancelled) return;
        setDocument(next);
        setTitle(next.title);
        setBody(next.body);
        setSavedTitle(next.title);
        setSavedBody(next.body);
        setSavedVersion(next.version);
        setSaveStatus("saved");
      })
      .catch(() => {
        if (!cancelled) setActiveBoardDocument(null);
      });
    return () => {
      cancelled = true;
    };
  }, [applyRuntimeSnapshot, clearSaveTimer, documentId, runtime, setActiveBoardDocument]);

  useEffect(() => {
    if (!runtime || !yText) return;
    const refresh = () => applyRuntimeSnapshot();
    yText.observe(refresh);
    const unsubscribe = runtime.subscribe(refresh);
    return () => {
      yText.unobserve(refresh);
      unsubscribe();
    };
  }, [applyRuntimeSnapshot, runtime, yText]);

  useEffect(() => {
    if (!documentId || !document || runtime) return;
    if (title.trim() === savedTitle && body === savedBody) {
      setSaveStatus("saved");
      clearSaveTimer();
      return;
    }
    setSaveStatus("dirty");
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => {
      void saveNow();
    }, 300);
    return clearSaveTimer;
  }, [body, clearSaveTimer, document, documentId, runtime, saveNow, savedBody, savedTitle, title]);

  useEffect(() => () => {
    clearSaveTimer();
  }, [clearSaveTimer]);

  if (!documentId) return null;

  const remove = async () => {
    try {
      if (runtime) {
        runtime.deleteMarkdownDocument(documentId);
      } else {
        await deleteMarkdownDocument(documentId);
      }
      removeBoardItem(`markdown:${documentId}`);
      setActiveBoardDocument(null);
    } catch (err) {
      console.error("Markdown document delete failed:", err);
    }
  };

  const enterEditMode = () => {
    skipNextBlurSaveRef.current = false;
    editBodySnapshotRef.current = yText ? yText.toString() : body;
    setIsEditingBody(true);
  };

  const updateBody = (value: string) => {
    setBody(value);
    setSaveError(null);
    setSaveStatus(runtime ? "saved" : "dirty");
    if (runtime && documentId) {
      setSavedBody(value);
      refreshRuntimeMarkdownPreview(runtime, documentId, value);
    }
  };

  const updateTitle = (value: string) => {
    setTitle(value);
    setSaveError(null);
    setSaveStatus(runtime ? "saved" : "dirty");
    if (runtime && documentId) {
      const normalized = value.trim() || "Untitled document";
      runtime.updateMarkdownTitle(documentId, normalized);
      setSavedTitle(normalized);
    }
  };

  const handleEditorBlur = useCallback(() => {
    if (skipNextBlurSaveRef.current) {
      skipNextBlurSaveRef.current = false;
      return;
    }
    void saveNow();
    setIsEditingBody(false);
  }, [saveNow]);

  const handleEditorEscape = useCallback(() => {
    skipNextBlurSaveRef.current = true;
    clearSaveTimer();
    const reverted = editBodySnapshotRef.current;
    if (runtime && documentId) {
      runtime.updateMarkdownBody(documentId, reverted);
      setBody(reverted);
      setSavedBody(reverted);
    } else {
      setTitle(savedTitle);
      setBody(savedBody);
    }
    setSaveStatus("saved");
    setIsEditingBody(false);
  }, [clearSaveTimer, documentId, runtime, savedBody, savedTitle]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <input
          value={title}
          onChange={(event) => updateTitle(event.target.value)}
          onBlur={() => void saveNow()}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
          aria-label="Document title"
        />
        <span
          data-testid="markdown-save-status"
          className="shrink-0 text-xs text-muted-foreground"
          role={saveError ? "alert" : undefined}
          title={saveError ?? undefined}
        >
          {saveError
            ? "저장 실패 · 다시 시도"
            : saveStatus === "saving"
              ? "저장 중..."
              : saveStatus === "conflict"
                ? "충돌: 새로고침 필요"
                : saveStatus === "saved"
                  ? (runtime ? "동기화됨" : "저장됨")
                  : ""}
        </span>
        <Button variant="ghost" size="icon" onClick={remove} title="Delete document">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!document ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : isEditingBody ? (
          <Suspense fallback={<div className="text-sm text-muted-foreground">Loading editor...</div>}>
            <MarkdownCodeMirrorEditor
              value={body}
              yText={yText}
              awareness={runtime?.awareness ?? null}
              onChange={updateBody}
              onBlur={handleEditorBlur}
              onEscape={handleEditorEscape}
              ariaLabel="Document body"
            />
          </Suspense>
        ) : (
          <div
            className="prose prose-sm min-h-full max-w-none cursor-text dark:prose-invert"
            data-v3-selectable-content="true"
            onClick={enterEditMode}
            data-testid="markdown-read-body"
          >
            <MarkdownContent content={body || "Empty document"} />
          </div>
        )}
      </div>
    </div>
  );
}

function useBoardRuntime(container: BoardContainerRef | null): BoardYjsRuntime | null {
  const [runtime, setRuntime] = useState(() => getBoardYjsRuntime(container));
  useEffect(() => {
    setRuntime(getBoardYjsRuntime(container));
    return subscribeBoardYjsRuntime(() => {
      setRuntime(getBoardYjsRuntime(container));
    });
  }, [container]);
  return runtime;
}

function getMetadataText(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

function getMetadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function refreshRuntimeMarkdownPreview(runtime: BoardYjsRuntime, documentId: string, body: string) {
  const boardItemId = `markdown:${documentId}`;
  const item = runtime.getBoardItems().find((candidate) => candidate.id === boardItemId);
  if (!item) return;
  runtime.upsertBoardItem({
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      preview: getMarkdownPreview(body),
      version: (getMetadataNumber(item.metadata, "version") ?? 1) + 1,
    },
    updatedAt: new Date().toISOString(),
  });
}
