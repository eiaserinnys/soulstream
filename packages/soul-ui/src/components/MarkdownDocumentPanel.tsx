import { useEffect, useState } from "react";
import { Save, Trash2 } from "lucide-react";

import type { MarkdownDocument } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { Button } from "./ui/button";
import { MarkdownContent } from "./MarkdownContent";
import { cn } from "../lib/cn";

type Mode = "read" | "write";

export function MarkdownDocumentPanel() {
  const documentId = useDashboardStore((s) => s.activeBoardDocumentId);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [mode, setMode] = useState<Mode>("read");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    setDocument(null);
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
      })
      .catch(() => {
        if (!cancelled) setActiveBoardDocument(null);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, setActiveBoardDocument]);

  if (!documentId) return null;

  const save = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/catalog/markdown-documents/${encodeURIComponent(documentId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      if (!res.ok) throw new Error(`Save markdown document failed: ${res.status}`);
      const updated = await res.json() as MarkdownDocument;
      setDocument(updated);
      setTitle(updated.title);
      setBody(updated.body);
      setMode("read");
    } catch (err) {
      console.error("Markdown document save failed:", err);
    } finally {
      setIsSaving(false);
    }
  };

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
          onChange={(event) => setTitle(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
          aria-label="Document title"
        />
        <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
          {(["read", "write"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded px-2 py-1 text-xs",
                mode === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setMode(value)}
            >
              {value === "read" ? "Read" : "Write"}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" onClick={save} disabled={isSaving} title="Save document">
          <Save className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={remove} title="Delete document">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!document ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : mode === "write" ? (
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="h-full min-h-[360px] w-full resize-none rounded-md border border-border bg-background p-3 font-mono text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            aria-label="Document body"
          />
        ) : (
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <MarkdownContent content={body || "Empty document"} />
          </div>
        )}
      </div>
    </div>
  );
}
