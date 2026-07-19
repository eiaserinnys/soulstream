import { memo, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { submitToolApproval } from "../../lib/input-request-actions";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { useGlassSurface } from "../LiquidGlassProvider";

export const ChatToolApproval = memo(function ChatToolApproval({
  msg,
  sessionId,
}: {
  msg: ChatMessage;
  sessionId: string;
}) {
  const [selected, setSelected] = useState<"approved" | "rejected" | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(cardRef, { enabled: true });
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
    <div className="px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <div
        ref={cardRef}
        className="flex flex-col gap-2 rounded-[18px] border border-glass-border glass-strong glass-shadow-md px-4 py-3"
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Approval
        </div>
        <div className="text-sm font-semibold leading-[1.5] text-foreground">{msg.toolName}</div>
        {msg.toolResult && (
          <div data-slot="chat-tool-body" className="text-xs text-muted-foreground">{msg.toolResult}</div>
        )}
        {msg.toolInput && (
          <pre data-slot="chat-tool-body" className="max-h-32 overflow-auto rounded-[13px] border border-[var(--lg-line)] bg-muted/40 p-2 text-xs text-muted-foreground">
            {JSON.stringify(msg.toolInput, null, 2)}
          </pre>
        )}
        {isResolved ? (
          <div className={cn(
            "text-xs",
            finalDecision === "approved" ? "chat-tone-success-text" : "chat-tone-danger-text",
          )}>
            {finalDecision === "approved" ? "승인됨" : "거부됨"}
            {msg.approvalMessage ? ` — ${msg.approvalMessage}` : ""}
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="destructive-outline"
              size="xs"
              onClick={() => handleDecision("rejected")}
              className="h-auto rounded-full px-3.5 py-1.5 text-xs font-normal"
            >
              거부
            </Button>
            <Button
              variant="success"
              size="xs"
              onClick={() => handleDecision("approved")}
              className="h-auto rounded-full px-3.5 py-1.5 text-xs font-semibold"
            >
              승인
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
