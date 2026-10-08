import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";
import { CollapsibleCaption } from "./CollapsibleCaption";
import { TurnEndCaptions } from "./TurnEndCaptions";
import { LabeledDivider } from "./LabeledDivider";
import { formatPersistentJevCandidates } from "../../lib/persistent-jev-candidates";
import { formatPersistentInstructionRecorded, persistentInstructionRecordedTitle } from "../../lib/persistent-instruction-recorded";
import { ManuscriptAgentMessageGroup } from "./ManuscriptAgentMessageGroup";

export const SystemMessage = memo(function SystemMessage({ msg, presentation = "default" }: { msg: ChatMessage; presentation?: "default" | "manuscript" }) {
  if (msg.manuscriptAgentMessages) {
    return <ManuscriptAgentMessageGroup messages={msg.manuscriptAgentMessages} />;
  }
  const alignmentInset = presentation === "manuscript" ? "content" : "avatar";
  if (msg.treeNodeType === "generation_started") return <LabeledDivider label={msg.contextReset ? "새 세대 · 문맥 초기화" : "새 세대"} alignmentInset={alignmentInset} />;
  if (msg.treeNodeType === "persistent_jev_candidates") {
    const candidates = msg.jevCandidates ?? [];
    const lines = formatPersistentJevCandidates({ selected: candidates });
    return <CollapsibleCaption title={`Jev 후보 ${candidates.length}`} align="end" alignmentInset={alignmentInset}>
      {lines.map((line, index) => <div className="min-w-0 truncate text-xs text-muted-foreground" key={`${index}-${line}`}>{line}</div>)}
    </CollapsibleCaption>;
  }
  if (msg.treeNodeType === "persistent_instruction_recorded") {
    const recorded = msg.persistentInstructionRecorded;
    if (!recorded) return null;
    const lines = formatPersistentInstructionRecorded(recorded);
    return <CollapsibleCaption
      title={persistentInstructionRecordedTitle(recorded)}
      align="end"
      alignmentInset={alignmentInset}
    >
      {lines.map((line, index) => <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground" key={`${index}-${line}`}>{line}</div>)}
    </CollapsibleCaption>;
  }
  const isError = msg.isError;
  const isRetrying = msg.isRetrying;
  const isComplete = msg.treeNodeType === "complete";
  const isTurnSummary = msg.treeNodeType === "turn_summary";
  const isAssignedCardContext = msg.treeNodeType === "assigned_card_context";
  const hasCompleteStats = isComplete
    && (msg.usage !== undefined || msg.totalCostUsd !== undefined);
  const hasCaptionStats = isComplete && msg.captionStats !== undefined;
  const isResult = msg.treeNodeType === "result" || !!hasCompleteStats;
  const usageCaption = presentation === "manuscript" ? msg.turnUsageCaption : undefined;

  const renderUsageCaption = () => usageCaption && <CollapsibleCaption
    title={usageCaption.title}
    expandedTitle={usageCaption.contextText ?? usageCaption.completeText ?? usageCaption.title}
    wrapExpandedTitle
    expandedByDefault={usageCaption.expandedByDefault}
    alignmentInset="content"
  >
    {usageCaption.contextText && usageCaption.completeText
      ? <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground">{usageCaption.completeText}</div>
      : null}
  </CollapsibleCaption>;

  if (presentation === "manuscript" && isComplete) {
    return <TurnEndCaptions
      treeNodeId={msg.treeNodeId}
      usageCaption={usageCaption}
      summaryCaption={msg.turnSummaryCaption}
      persistentInstructionCaption={msg.persistentInstructionRecorded}
    />;
  }

  if (presentation === "manuscript" && isTurnSummary) {
    return <TurnEndCaptions
      treeNodeId={msg.treeNodeId}
      summaryCaption={{ treeNodeId: msg.treeNodeId, content: msg.content }}
      persistentInstructionCaption={msg.persistentInstructionRecorded}
    />;
  }

  return (
    <>
      <div className={presentation === "manuscript" ? "flex gap-2 py-1" : "flex gap-2 px-3 py-1"} data-tree-node-id={msg.treeNodeId}>
        <span className="w-8 shrink-0" />
        <div className={cn(
          presentation === "default"
            ? "flex-1 min-w-0 text-xs px-2 py-1 rounded text-left"
            : "flex-1 min-w-0 text-xs px-2 py-1 rounded text-left",
          (isTurnSummary || isAssignedCardContext) && "whitespace-pre-line",
          hasCaptionStats && "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1",
          isRetrying
            ? "chat-tone-warning"
            : isError
              ? "chat-tone-danger"
              : isResult
                ? "chat-tone-success"
                : "text-muted-foreground bg-input",
        )}>
          {hasCaptionStats ? (
            <>
              <span data-slot="complete-caption-label">{msg.content}</span>
              <span
                className="ml-auto max-w-full text-right"
                data-slot="complete-caption-stats"
              >
                {msg.captionStats}
              </span>
            </>
          ) : msg.content}
        </div>
      </div>
      {isError && renderUsageCaption()}
    </>
  );
});
