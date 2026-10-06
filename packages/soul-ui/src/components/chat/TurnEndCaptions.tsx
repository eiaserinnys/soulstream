"use client";

import { useId, useState } from "react";
import {
  CollapsibleCaptionBody,
  CollapsibleCaptionHeader,
} from "./CollapsibleCaption";

interface TurnUsageCaption {
  title: string;
  contextText?: string;
  completeText?: string;
}

interface TurnSummaryCaption {
  treeNodeId: string;
  content: string;
}

export function TurnEndCaptions({
  treeNodeId,
  usageCaption,
  summaryCaption,
}: {
  treeNodeId?: string;
  usageCaption?: TurnUsageCaption;
  summaryCaption?: TurnSummaryCaption;
}) {
  const [usageExpanded, setUsageExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const usageBodyId = useId();
  const summaryBodyId = useId();

  if (!usageCaption && !summaryCaption) return null;

  return (
    <div className="flex justify-end py-1" data-slot="turn-end-captions" data-tree-node-id={treeNodeId}>
      <div className="min-w-0 flex w-full flex-col items-end">
        <div className="flex min-w-0 max-w-full items-center justify-end gap-3">
          {usageCaption && <CollapsibleCaptionHeader
            id={usageBodyId}
            expanded={usageExpanded}
            title={usageCaption.title}
            align="end"
            alignmentInset="content"
            onToggle={() => setUsageExpanded(value => !value)}
          />}
          {summaryCaption && <CollapsibleCaptionHeader
            id={summaryBodyId}
            expanded={summaryExpanded}
            title="요약"
            align="end"
            alignmentInset="content"
            onToggle={() => setSummaryExpanded(value => !value)}
          />}
        </div>
        {usageCaption && <CollapsibleCaptionBody id={usageBodyId} expanded={usageExpanded} align="end">
          {usageCaption.contextText && <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground">{usageCaption.contextText}</div>}
          {usageCaption.completeText && <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground">{usageCaption.completeText}</div>}
        </CollapsibleCaptionBody>}
        {summaryCaption && <CollapsibleCaptionBody id={summaryBodyId} expanded={summaryExpanded} align="end">
          <div className="min-w-0 whitespace-pre-line break-keep break-words text-xs text-muted-foreground">{summaryCaption.content}</div>
        </CollapsibleCaptionBody>}
      </div>
    </div>
  );
}
