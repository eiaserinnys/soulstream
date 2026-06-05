import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import type { MarkdownDocument } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { Button } from "./ui/button";
import { MarkdownContent } from "./MarkdownContent";

type SaveStatus = "idle" | "dirty" | "saving" | "saved";

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
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [isEditingBody, setIsEditingBody] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [savedTitle, setSavedTitle] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef({ documentId: "", title: "", body: "", savedTitle: "", savedBody: "" });

  const clearSaveTimer = useCallback(() => {
    if (!saveTimerRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  const saveNow = useCallback(async () => {
    if (!documentId) return;
    clearSaveTimer();
    const currentTitle = title.trim() || "Untitled document";
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
  }, [body, clearSaveTimer, documentId, savedBody, savedTitle, title]);

  useEffect(() => {
    const previous = latestDraftRef.current;
    if (
      previous.documentId &&
      (previous.title.trim() || "Untitled document") !== previous.savedTitle ||
      previous.documentId &&
      previous.body !== previous.savedBody
    ) {
      void saveMarkdownDocument(
        previous.documentId,
        previous.title.trim() || "Untitled document",
        previous.body,
      ).catch((err) => {
        console.error("Markdown document save during switch failed:", err);
      });
    }
    clearSaveTimer();
    if (!documentId) return;
    let cancelled = false;
    setDocument(null);
    setIsEditingBody(false);
    setSaveStatus("idle");
    fetch(`/api/catalog/markdown-documents/${encodeURIComponent(documentId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Load markdown document failed: ${res.status}`);
        return res.json() as Promise<MarkdownDocument>;
      })
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
  }, [clearSaveTimer, documentId, setActiveBoardDocument]);

  useEffect(() => {
    latestDraftRef.current = { documentId: documentId ?? "", title, body, savedTitle, savedBody };
  }, [body, documentId, savedBody, savedTitle, title]);

  useEffect(() => {
    if (!documentId || !document) return;
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
  }, [body, clearSaveTimer, document, documentId, saveNow, savedBody, savedTitle, title]);

  useEffect(() => () => {
    const latest = latestDraftRef.current;
    clearSaveTimer();
    if (!latest.documentId) return;
    if ((latest.title.trim() || "Untitled document") === latest.savedTitle && latest.body === latest.savedBody) return;
    void saveMarkdownDocument(
      latest.documentId,
      latest.title.trim() || "Untitled document",
      latest.body,
    ).catch((err) => {
      console.error("Markdown document save during unmount failed:", err);
    });
  }, [clearSaveTimer]);

  if (!documentId) return null;

  const remove = async () => {
    try {
      const res = await fetch(`/api/catalog/markdown-documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete markdown document failed: ${res.status}`);
      removeBoardItem(`markdown:${documentId}`);
      setActiveBoardDocument(null);
    } catch (err) {
      console.error("Markdown document delete failed:", err);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setSaveStatus("dirty");
          }}
          onBlur={() => void saveNow()}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
          aria-label="Document title"
        />
        <span data-testid="markdown-save-status" className="shrink-0 text-xs text-muted-foreground">
          {saveStatus === "saving" ? "저장 중..." : saveStatus === "saved" ? "저장됨" : ""}
        </span>
        <Button variant="ghost" size="icon" onClick={remove} title="Delete document">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!document ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : isEditingBody ? (
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setSaveStatus("dirty");
            }}
            onBlur={() => {
              void saveNow();
              setIsEditingBody(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              clearSaveTimer();
              setTitle(savedTitle);
              setBody(savedBody);
              setSaveStatus("saved");
              setIsEditingBody(false);
            }}
            className="h-full min-h-[360px] w-full resize-none rounded-md border border-border bg-background p-3 font-mono text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            aria-label="Document body"
            autoFocus
          />
        ) : (
          <div
            className="prose prose-sm min-h-full max-w-none cursor-text dark:prose-invert"
            onClick={() => setIsEditingBody(true)}
            data-testid="markdown-read-body"
          >
            <MarkdownContent content={body || "Empty document"} />
          </div>
        )}
      </div>
    </div>
  );
}
