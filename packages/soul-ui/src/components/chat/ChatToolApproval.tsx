import { memo, useState } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { submitToolApproval } from "../../lib/input-request-actions";
import { cn } from "../../lib/cn";

export const ChatToolApproval = memo(function ChatToolApproval({
  msg,
  sessionId,
}: {
  msg: ChatMessage;
  sessionId: string;
}) {
  const [selected, setSelected] = useState<"approved" | "rejected" | null>(null);
  const isResolved = !!msg.approvalResolved || !!selected;

  const handleDecision = async (decision: "approved" | "rejected") => {
    if (isResolved || !msg.approvalId) return;
    setSelected(decision);
    const ok = await submitToolApproval(
      sessionId,
      msg.approvalId,
      msg.treeNodeId,
      decision,
      decision === "rejected" ? "Rejected by user" : undefined,
    );
    if (!ok) {
      setSelected(null);
    }
  };

  const finalDecision = selected ?? msg.approvalDecision;

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0 text-center">⚠️</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">도구 승인이 필요합니다</div>
        <div className="text-base font-medium text-foreground mb-1">{msg.toolName}</div>
        {msg.toolResult && (
          <div className="text-xs text-muted-foreground mb-1">{msg.toolResult}</div>
        )}
        {msg.toolInput && (
          <pre className="mb-2 max-h-32 overflow-auto rounded border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
            {JSON.stringify(msg.toolInput, null, 2)}
          </pre>
        )}
        {isResolved ? (
          <div className={cn(
            "text-xs",
            finalDecision === "approved" ? "text-success" : "text-destructive",
          )}>
            {finalDecision === "approved" ? "승인됨" : "거부됨"}
            {msg.approvalMessage ? ` — ${msg.approvalMessage}` : ""}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => handleDecision("rejected")}
              className="px-3 py-1 rounded text-xs border border-border bg-input text-foreground hover:bg-muted/50"
            >
              거부
            </button>
            <button
              onClick={() => handleDecision("approved")}
              className="px-3 py-1 rounded text-xs border border-success bg-success text-white hover:opacity-90"
            >
              승인
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
