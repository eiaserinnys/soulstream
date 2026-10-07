"use client";

import { useId, useState } from "react";
import {
  CollapsibleCaptionBody,
  CollapsibleCaptionHeader,
} from "./CollapsibleCaption";
import type { PersistentInstructionRecordedData } from "../../shared/types";
import { formatPersistentInstructionRecorded, persistentInstructionRecordedTitle } from "../../lib/persistent-instruction-recorded";

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
  persistentInstructionCaption,
}: {
  treeNodeId?: string;
  usageCaption?: TurnUsageCaption;
  summaryCaption?: TurnSummaryCaption;
  persistentInstructionCaption?: PersistentInstructionRecordedData;
}) {
  const [usageExpanded, setUsageExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [instructionExpanded, setInstructionExpanded] = useState(false);
  const usageBodyId = useId();
  const summaryBodyId = useId();
  const instructionBodyId = useId();

  if (!usageCaption && !summaryCaption && !persistentInstructionCaption) return null;
  const instructionLines = persistentInstructionCaption
    ? formatPersistentInstructionRecorded(persistentInstructionCaption)
    : [];

  return (
    <div className="flex justify-end py-1" data-slot="turn-end-captions" data-tree-node-id={treeNodeId}>
      <div className="min-w-0 flex w-full flex-col items-end">
        <div className="flex w-full min-w-0 max-w-full flex-wrap items-center justify-end gap-3">
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
          {persistentInstructionCaption && <CollapsibleCaptionHeader
            id={instructionBodyId}
            expanded={instructionExpanded}
            title={persistentInstructionRecordedTitle(persistentInstructionCaption)}
            align="end"
            alignmentInset="content"
            onToggle={() => setInstructionExpanded(value => !value)}
          />}
        </div>
        {usageCaption && <CollapsibleCaptionBody id={usageBodyId} expanded={usageExpanded} align="end">
          {usageCaption.contextText && <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground">{usageCaption.contextText}</div>}
          {usageCaption.completeText && <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground">{usageCaption.completeText}</div>}
        </CollapsibleCaptionBody>}
        {summaryCaption && <CollapsibleCaptionBody
          id={summaryBodyId}
          expanded={summaryExpanded}
          align="end"
          className={usageCaption && usageExpanded && summaryExpanded ? "mt-2" : undefined}
        >
          <div className="min-w-0 whitespace-pre-line break-keep break-words text-xs text-muted-foreground">{summaryCaption.content}</div>
        </CollapsibleCaptionBody>}
        {persistentInstructionCaption && <CollapsibleCaptionBody
          id={instructionBodyId}
          expanded={instructionExpanded}
          align="end"
          className={instructionExpanded && (usageExpanded || summaryExpanded) ? "mt-2" : undefined}
        >
          {instructionLines.map((line, index) => <div className="min-w-0 whitespace-normal break-keep break-words text-xs text-muted-foreground" key={`${index}-${line}`}>{line}</div>)}
        </CollapsibleCaptionBody>}
      </div>
    </div>
  );
}
