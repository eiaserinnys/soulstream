"use client";

import { useId, useState, type ReactNode } from "react";
import { DisclosureActionIcon } from "../DisclosureActionIcon";
import { Button } from "../ui/button";

export interface CollapsibleCaptionProps {
  title: string;
  children: ReactNode;
  expandedTitle?: string;
  wrapExpandedTitle?: boolean;
  initiallyCollapsed?: boolean;
  align?: "start" | "end";
  alignmentInset?: "avatar" | "content";
}

export function CollapsibleCaption({
  title,
  children,
  expandedTitle,
  wrapExpandedTitle = false,
  initiallyCollapsed = true,
  align = "start",
  alignmentInset = "avatar",
}: CollapsibleCaptionProps) {
  const [expanded, setExpanded] = useState(() => !initiallyCollapsed);
  const contentAligned = alignmentInset === "content";
  const wrapTitle = expanded && wrapExpandedTitle && expandedTitle !== undefined;
  const visibleTitle = expanded && expandedTitle !== undefined ? expandedTitle : title;
  const contentId = useId();

  return (
    <div
      className={contentAligned ? (align === "end" ? "flex justify-end py-1" : "flex py-1") : (align === "end" ? "flex justify-end gap-2 px-3 py-1" : "flex gap-2 px-3 py-1")}
      data-slot="collapsible-caption"
    >
      {align === "start" && !contentAligned && <span className="w-8 shrink-0" />}
      <div className={align === "end" ? (contentAligned ? "min-w-0 flex w-full flex-col items-end" : "min-w-0 flex w-full max-w-[86%] flex-col items-end") : "min-w-0 flex-1"}>
        <Button
          aria-controls={contentId}
          aria-expanded={expanded}
          className={`${contentAligned ? (align === "end" ? "-me-px justify-end !pe-0" : "-ms-px justify-start !ps-0") : (align === "end" ? "-me-2 justify-end !pe-2" : "-ms-2 justify-start")} ${wrapTitle ? "w-full !h-auto min-h-6" : "max-w-full h-6 sm:h-6"} gap-2 !text-xs !font-medium text-muted-foreground`}
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="ghost"
        >
          <span className={`min-w-0 ${wrapTitle ? "max-w-full whitespace-normal break-words" : "truncate"} ${align === "end" ? "text-right" : "text-left"}`}>{visibleTitle}</span>
          <DisclosureActionIcon expanded={expanded} />
        </Button>
        <div className={`mt-0.5 min-w-0 space-y-0.5 ${align === "end" ? "max-w-full text-right" : ""}`} hidden={!expanded} id={contentId}>
          {children}
        </div>
      </div>
      {align === "end" && !contentAligned && <span className="w-8 shrink-0" />}
    </div>
  );
}
