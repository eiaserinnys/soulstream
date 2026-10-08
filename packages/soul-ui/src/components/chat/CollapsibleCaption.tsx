"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { DisclosureActionIcon } from "../DisclosureActionIcon";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

export interface CollapsibleCaptionProps {
  title: string;
  children: ReactNode;
  expandedTitle?: string;
  wrapExpandedTitle?: boolean;
  initiallyCollapsed?: boolean;
  expandedByDefault?: boolean;
  align?: "start" | "end";
  alignmentInset?: "avatar" | "content";
}

interface CollapsibleCaptionHeaderProps {
  id: string;
  expanded: boolean;
  title: string;
  expandedTitle?: string;
  wrapExpandedTitle?: boolean;
  align: "start" | "end";
  alignmentInset: "avatar" | "content";
  onToggle: () => void;
}

export function CollapsibleCaptionHeader({
  id,
  expanded,
  title,
  expandedTitle,
  wrapExpandedTitle = false,
  align,
  alignmentInset,
  onToggle,
}: CollapsibleCaptionHeaderProps) {
  const contentAligned = alignmentInset === "content";
  const wrapTitle = expanded && wrapExpandedTitle && expandedTitle !== undefined;
  const visibleTitle = expanded && expandedTitle !== undefined ? expandedTitle : title;

  return (
    <Button
      aria-controls={id}
      aria-expanded={expanded}
      className={`${contentAligned ? (align === "end" ? "-me-px justify-end !pe-0" : "-ms-px justify-start !ps-0") : (align === "end" ? "-me-2 justify-end !pe-2" : "-ms-2 justify-start")} ${wrapTitle ? "max-w-full !h-auto min-h-6" : "max-w-full h-6 sm:h-6"} gap-2 !text-xs !font-medium text-muted-foreground`}
      onClick={onToggle}
      size="xs"
      variant="ghost"
    >
      <span className={`min-w-0 ${wrapTitle ? "max-w-full whitespace-normal break-keep break-words" : "truncate"} ${align === "end" ? "text-right" : "text-left"}`}>{visibleTitle}</span>
      <DisclosureActionIcon expanded={expanded} />
    </Button>
  );
}

export function CollapsibleCaptionBody({
  id,
  expanded,
  align,
  children,
  className,
}: {
  id: string;
  expanded: boolean;
  align: "start" | "end";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(className ?? "mt-0.5", "min-w-0 space-y-0.5", align === "end" && "max-w-full text-right")} hidden={!expanded} id={id}>
      {children}
    </div>
  );
}

export function CollapsibleCaption({
  title,
  children,
  expandedTitle,
  wrapExpandedTitle = false,
  initiallyCollapsed = true,
  expandedByDefault,
  align = "start",
  alignmentInset = "avatar",
}: CollapsibleCaptionProps) {
  const [expanded, setExpanded] = useState(() => expandedByDefault ?? !initiallyCollapsed);
  const contentAligned = alignmentInset === "content";
  const contentId = useId();

  useEffect(() => {
    if (expandedByDefault !== undefined) setExpanded(expandedByDefault);
  }, [expandedByDefault]);

  return (
    <div
      className={contentAligned ? (align === "end" ? "flex justify-end py-1" : "flex py-1") : (align === "end" ? "flex justify-end gap-2 px-3 py-1" : "flex gap-2 px-3 py-1")}
      data-slot="collapsible-caption"
    >
      {align === "start" && !contentAligned && <span className="w-8 shrink-0" />}
      <div className={align === "end" ? (contentAligned ? "min-w-0 flex w-full flex-col items-end" : "min-w-0 flex w-full max-w-[86%] flex-col items-end") : "min-w-0 flex-1"}>
        <CollapsibleCaptionHeader
          id={contentId}
          expanded={expanded}
          title={title}
          expandedTitle={expandedTitle}
          wrapExpandedTitle={wrapExpandedTitle}
          align={align}
          alignmentInset={alignmentInset}
          onToggle={() => setExpanded((value) => !value)}
        />
        <CollapsibleCaptionBody id={contentId} expanded={expanded} align={align}>
          {children}
        </CollapsibleCaptionBody>
      </div>
      {align === "end" && !contentAligned && <span className="w-8 shrink-0" />}
    </div>
  );
}
