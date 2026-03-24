/**
 * NewSessionDialog -- 새 세션 생성 다이얼로그.
 *
 * 노드 선택 드롭다운 + 프롬프트 입력.
 * 특정 노드에서 호출하면 해당 노드로 고정.
 */

import { useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogClose,
  Button,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";

interface NewSessionDialogProps {
  /** 특정 노드에서 열면 해당 노드로 고정. undefined면 드롭다운 표시. */
  nodeId?: string;
  nodeColor?: string;
}

export function NewSessionDialog({ nodeId, nodeColor }: NewSessionDialogProps) {
  const nodes = useOrchestratorStore((s) => s.nodes);

  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState(nodeId ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aliveNodes = Array.from(nodes.values()).filter(
    (n) => n.status === "connected",
  );

  async function handleSubmit() {
    const targetNode = nodeId ?? selectedNodeId;
    if (!targetNode || !prompt.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), nodeId: targetNode }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const { sessionId } = await res.json();
      setOpen(false);
      setPrompt("");
      // 생성된 세션을 활성화
      useDashboardStore.getState().setActiveSession(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground/70 py-1 transition-colors"
          style={nodeColor ? { color: `color-mix(in srgb, ${nodeColor} 50%, transparent)` } : undefined}
        >
          + New Session
        </button>
      </DialogTrigger>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 mt-4">
          {/* Node selection -- shown when nodeId is not fixed */}
          {!nodeId && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Node
              </label>
              <Select value={selectedNodeId} onValueChange={setSelectedNodeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a node..." />
                </SelectTrigger>
                <SelectPopup>
                  {aliveNodes.map((n) => (
                    <SelectItem key={n.nodeId} value={n.nodeId}>
                      {n.nodeId}
                      <span className="ml-2 text-[10px] font-mono text-muted-foreground/50">
                        {n.host}:{n.port}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}

          {/* Fixed node display */}
          {nodeId && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Node
              </label>
              <div
                className="text-sm font-mono px-3 py-2 rounded-md bg-muted border border-input"
                style={nodeColor ? { borderLeftColor: nodeColor, borderLeftWidth: 3 } : undefined}
              >
                {nodeId}
              </div>
            </div>
          )}

          {/* Prompt */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Prompt
            </label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter the prompt for the session..."
              rows={4}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  handleSubmit();
                }
              }}
            />
          </div>

          {error && (
            <div className="text-xs text-destructive">{error}</div>
          )}

          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={loading || !prompt.trim() || (!nodeId && !selectedNodeId)}
            >
              {loading ? "Creating..." : "Create Session"}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
