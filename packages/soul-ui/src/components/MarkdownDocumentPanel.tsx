import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import type { MarkdownDocument } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  getMarkdownPreview,
  getBoardYjsRuntime,
  subscribeBoardYjsRuntime,
  type BoardYjsRuntime,
} from "../board-workspace";
import { Button } from "./ui/button";
import { MarkdownContent } from "./MarkdownContent";

type SaveStatus = "idle" | "dirty" | "saving" | "saved";

const MarkdownCodeMirrorEditor = lazy(async () => {
  const module = await import("./MarkdownCodeMirrorEditor");
  return { default: module.MarkdownCodeMirrorEditor };
});

async function fetchMarkdownDocument(documentId: string): Promise<MarkdownDocument> {
  const res = await fetch(`/api/catalog/markdown-documents/${encodeURIComponent(documentId)}`);
  if (!res.ok) throw new Error(`Load markdown document failed: ${res.status}`);
  return await res.json() as MarkdownDocument;
}

async function saveMarkdownDocument(
  documentId: string,
  title: string,
  body: string,
): Promise<MarkdownDocument> {
  const res = await fetch(`/api/catalog/markdown-documents/${encodeURIComponent(documentId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) throw new Error(`Save markdown document failed: ${res.status}`);
  return await res.json() as MarkdownDocument;
}

export function MarkdownDocumentPanel() {
  const documentId = useDashboardStore((s) => s.activeBoardDocumentId);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const runtime = useBoardRuntime(selectedFolderId);
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
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
    const nextDocument = { id: documentId, title: nextTitle, body: nextBody };
    setDocument(nextDocument);
    setTitle(nextTitle);
    setBody(nextBody);
    setSavedTitle(nextTitle);
    setSavedBody(nextBody);
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
    setSaveStatus("saving");
    try {
      const updated = await saveMarkdownDocument(documentId, currentTitle, body);
      setDocument(updated);
      setTitle(updated.title);
      setBody(updated.body);
      setSavedTitle(updated.title);
      setSavedBody(updated.body);
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("dirty");
      console.error("Markdown document save failed:", err);
    }
  }, [body, clearSaveTimer, documentId, runtime, savedBody, savedTitle, title, yText]);

  useEffect(() => {
    clearSaveTimer();
    skipNextBlurSaveRef.current = false;
    if (!documentId) return;
    setDocument(null);
    setIsEditingBody(false);
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
        const res = await fetch(`/api/catalog/markdown-documents/${encodeURIComponent(documentId)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Delete markdown document failed: ${res.status}`);
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
    setSaveStatus(runtime ? "saved" : "dirty");
    if (runtime && documentId) {
      setSavedBody(value);
      refreshRuntimeMarkdownPreview(runtime, documentId, value);
    }
  };

  const updateTitle = (value: string) => {
    setTitle(value);
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
        <span data-testid="markdown-save-status" className="shrink-0 text-xs text-muted-foreground">
          {saveStatus === "saving" ? "저장 중..." : saveStatus === "saved" ? (runtime ? "동기화됨" : "저장됨") : ""}
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

function useBoardRuntime(folderId: string | null): BoardYjsRuntime | null {
  const [runtime, setRuntime] = useState(() => getBoardYjsRuntime(folderId));
  useEffect(() => {
    setRuntime(getBoardYjsRuntime(folderId));
    return subscribeBoardYjsRuntime(() => {
      setRuntime(getBoardYjsRuntime(folderId));
    });
  }, [folderId]);
  return runtime;
}

function getMetadataText(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
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
    },
    updatedAt: new Date().toISOString(),
  });
}
