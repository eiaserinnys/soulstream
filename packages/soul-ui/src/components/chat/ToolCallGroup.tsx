import { memo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Clock, Wrench, X } from "lucide-react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";
import { DisclosureActionIcon } from "../DisclosureActionIcon";
import { useLazyLoadContent, useLazyLoadToolTrace } from "./hooks";
import { ShowFullContentButton } from "./ShowFullContentButton";
import { ThinkingMessage } from "./ThinkingMessage";

/** 그룹 내 개별 tool call 항목 (truncation lazy load 포함) */
const ToolCallItem = memo(function ToolCallItem({
  msg,
  presentation = "default",
}: {
  msg: ChatMessage;
  presentation?: "default" | "manuscript";
}) {
  const [expanded, setExpanded] = useState(false);
  const legacyContent = useLazyLoadContent(msg);
  const traceContent = useLazyLoadToolTrace(msg);
  const isDone = msg.toolResult !== undefined || msg.toolDurationMs !== undefined;
  const statusIcon = msg.isError ? "\u274C" : isDone ? "\u2705" : "\u{1F528}";
  const hasTrace = !!msg.toolTraceId;
  const inputContent = traceContent.inputContent;
  const resultContent = hasTrace ? traceContent.resultContent : legacyContent.displayContent;
  const shortName = (msg.toolName ?? msg.content).replace(/^mcp__.*?__/, "");
  const duration = msg.toolDurationMs
    ? `(${(msg.toolDurationMs / 1000).toFixed(1)}s)`
    : "";

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) traceContent.loadTrace();
  };

  const details = (
    <>
      {expanded && inputContent && (
        <pre data-slot="chat-tool-body" className="text-xs text-muted-foreground bg-input rounded px-2 py-1.5 ml-5 mt-0.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono">
          {inputContent}
        </pre>
      )}
      {expanded && resultContent && (
        <div className="ml-5 mt-0.5">
          <pre data-slot="chat-tool-body" className={cn(
            "text-xs bg-input rounded px-2 py-1.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono",
            msg.isError ? "chat-tone-danger-text" : "text-muted-foreground",
          )}>
            {resultContent}
          </pre>
          {!hasTrace && legacyContent.isTruncated && (
            <ShowFullContentButton
              loading={legacyContent.loading}
              error={legacyContent.error}
              onClick={legacyContent.loadFullContent}
            />
          )}
        </div>
      )}
      {expanded && traceContent.progressContent && (
        <pre data-slot="chat-tool-body" className="text-xs text-muted-foreground bg-input rounded px-2 py-1.5 ml-5 mt-0.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono">
          {traceContent.progressContent}
        </pre>
      )}
      {expanded && hasTrace && (traceContent.loading || traceContent.error) && (
        <div className="ml-5">
          <ShowFullContentButton
            loading={traceContent.loading}
            error={traceContent.error}
            onClick={traceContent.loadTrace}
          />
        </div>
      )}
    </>
  );

  if (presentation === "manuscript") {
    const StatusIcon = msg.isError ? X : isDone ? Check : Clock;
    return (
      <div data-slot="manuscript-tool-call-item" data-tree-node-id={msg.treeNodeId}>
        <button
          type="button"
          aria-expanded={expanded}
          data-slot="tool-call-item-toggle"
          onClick={toggleExpanded}
          className={cn(
            "flex h-6 w-full min-w-0 items-center gap-1.5 overflow-hidden hover:text-foreground",
            msg.isError ? "chat-tone-danger-text" : "text-muted-foreground",
          )}
        >
          {expanded
            ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
          <StatusIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate text-left">{shortName}</span>
          {duration && <span className="shrink-0 text-muted-foreground">{duration}</span>}
        </button>
        {details}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        data-slot="tool-call-item-toggle"
        onClick={toggleExpanded}
        className={cn(
          "text-xs font-mono flex items-center gap-1",
          msg.isError ? "chat-tone-danger-text" : "text-muted-foreground",
          "hover:text-foreground",
        )}
      >
        <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{statusIcon}</span>
        <span className="truncate">{msg.content}</span>
      </button>
      {details}
    </div>
  );
});

/** 연속된 tool 메시지를 하나로 묶어 표시하는 그룹 컴포넌트 */
export const ToolCallGroup = memo(function ToolCallGroup({
  messages,
  presentation = "default",
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  messages: ChatMessage[];
  presentation?: "default" | "manuscript";
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const toggleExpanded = () => {
    const next = !expanded;
    if (onExpandedChange) onExpandedChange(next);
    else setInternalExpanded(next);
  };
  const hasError = messages.some((m) => m.isError);
  const failureCount = messages.filter((m) => m.role === "tool" && m.isError).length;
  const toolMessages = messages.filter((message) => message.role === "tool");
  const allDone = messages.length > 0 && messages.every(
    (m) => m.toolResult !== undefined || m.toolDurationMs !== undefined,
  );
  const statusLabel = hasError ? "실패" : allDone ? "완료" : "실행 중";
  const statusClassName = hasError
    ? "chat-tone-danger-text"
    : allDone
      ? "chat-tone-success-text"
      : undefined;
  const hasRunningTool = toolMessages.some(
    (message) => !message.isError && message.toolResult === undefined && message.toolDurationMs === undefined,
  );

  if (presentation === "manuscript") {
    return (
      <div className="flex py-1" data-slot="chat-activity-row" data-tree-node-id={toolMessages[0]?.treeNodeId}>
        <div className="w-full min-w-0">
          <button
            type="button"
            aria-expanded={expanded}
            data-slot="manuscript-activity-toggle"
            onClick={toggleExpanded}
            className="flex h-6 w-full min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground hover:text-foreground"
          >
            <Wrench className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate font-medium">도구 {toolMessages.length}회</span>
            {hasRunningTool && <span className="shrink-0">실행 중</span>}
            {failureCount > 0 && <span className="shrink-0 chat-tone-danger-text">실패 {failureCount}</span>}
            <DisclosureActionIcon expanded={expanded} className="size-3.5 shrink-0" />
          </button>
          {expanded && (
            <div data-slot="manuscript-activity-items" className="ml-5 mt-1 space-y-0.5">
              {messages.map((msg) => msg.role === "tool"
                ? <ToolCallItem key={msg.id} msg={msg} presentation="manuscript" />
                : <ThinkingMessage key={msg.id} msg={msg} presentation="manuscript" />)}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 px-3 py-1" data-slot="chat-tool-row" data-tree-node-id={messages[0]?.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <button
          type="button"
          aria-expanded={expanded}
          data-slot="tool-call-group-toggle"
          onClick={toggleExpanded}
          className="flex h-6 w-full min-w-0 items-center gap-1.5 overflow-hidden text-xs leading-[18px] text-muted-foreground hover:text-foreground"
        >
          {expanded
            ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
          <Wrench className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate font-medium">
            Tool Calls {messages.length} · <span className={statusClassName}>{statusLabel}</span>
          </span>
        </button>
        {expanded && (
          <div data-slot="tool-call-group-items" className="ml-4 mt-1 space-y-0.5">
            {messages.map((msg) => (
              <ToolCallItem key={msg.id} msg={msg} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
