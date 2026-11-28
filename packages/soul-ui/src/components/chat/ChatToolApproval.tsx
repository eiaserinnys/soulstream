import { useTranslation } from "react-i18next";
import { memo, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { submitToolApproval } from "../../lib/input-request-actions";
import { actionFailureMessage } from "../../lib/action-failure";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { useGlassSurface } from "../LiquidGlassProvider";

export const ChatToolApproval = memo(function ChatToolApproval({
  msg,
  sessionId,
  presentation = "default",
}: {
  msg: ChatMessage;
  sessionId: string;
  presentation?: "default" | "manuscript";
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<"approved" | "rejected" | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(cardRef, { enabled: presentation !== "manuscript" });
  const isResolved = !!msg.approvalResolved || !!selected;

  const handleDecision = async (decision: "approved" | "rejected") => {
    if (isResolved || !msg.approvalId) return;
    setFailureMessage(null);
    setSelected(decision);
    const result = await submitToolApproval(
      sessionId,
      msg.approvalId,
      msg.treeNodeId,
      decision,
      decision === "rejected" ? "Rejected by user" : undefined,
    );
    if (!result.sent) {
      setSelected(null);
      if (result.reason === "failed") {
        setFailureMessage(actionFailureMessage("tool-approval", {
          status: result.status,
          body: result.body,
        }));
      }
    }
  };

  const finalDecision = selected ?? msg.approvalDecision;

  return (
    <div className="px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <div
        ref={cardRef}
        className={presentation === "manuscript"
          ? "flex flex-col gap-2 rounded-floor border border-[var(--persistent-session-line)] bg-[var(--persistent-session-panel)] px-4 py-3"
          : "flex flex-col gap-2 rounded-floor border border-glass-border glass-strong glass-shadow-md px-4 py-3"}
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {t("ui.chat.toolApproval")}
        </div>
        <div className="text-sm font-semibold leading-[1.5] text-foreground">{msg.toolName}</div>
        {msg.toolResult && (
          <div data-slot="chat-tool-body" className="text-xs text-muted-foreground">{msg.toolResult}</div>
        )}
        {msg.toolInput && (
          <pre data-slot="chat-tool-body" className="max-h-32 overflow-auto rounded-floor border border-[var(--lg-line)] bg-muted/40 p-2 text-xs text-muted-foreground">
            {JSON.stringify(msg.toolInput, null, 2)}
          </pre>
        )}
        {isResolved ? (
          <div className={cn(
            "text-xs",
            finalDecision === "approved" ? "chat-tone-success-text" : "chat-tone-danger-text",
          )}>
            {finalDecision === "approved" ? t("ui.chat.approved") : t("ui.chat.denied")}
            {msg.approvalMessage ? ` — ${msg.approvalMessage}` : ""}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="destructive-outline"
                size="xs"
                onClick={() => handleDecision("rejected")}
                className="h-auto rounded-full px-3.5 py-1.5 text-xs font-normal"
              >
                {t("ui.chat.deny")}
              </Button>
              <Button
                variant="success"
                size="xs"
                onClick={() => handleDecision("approved")}
                className="h-auto rounded-full px-3.5 py-1.5 text-xs font-semibold"
              >
                {t("ui.chat.approve")}
              </Button>
            </div>
            {failureMessage && (
              <div role="alert" className="text-xs text-destructive">
                {failureMessage}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
