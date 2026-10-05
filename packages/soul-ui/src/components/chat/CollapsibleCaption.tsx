"use client";

import { useId, useState, type ReactNode } from "react";
import { DisclosureActionIcon } from "../DisclosureActionIcon";
import { Button } from "../ui/button";

export interface CollapsibleCaptionProps {
  title: string;
  children: ReactNode;
  initiallyCollapsed?: boolean;
  align?: "start" | "end";
}

export function CollapsibleCaption({
  title,
  children,
  initiallyCollapsed = true,
  align = "start",
}: CollapsibleCaptionProps) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(() => !initiallyCollapsed);

  return (
    <div
      className={align === "end" ? "flex justify-end gap-2 px-3 py-1" : "flex gap-2 px-3 py-1"}
      data-slot="collapsible-caption"
    >
      {align === "start" && <span className="w-8 shrink-0" />}
      <div className={align === "end" ? "min-w-0 max-w-[86%]" : "min-w-0 flex-1"}>
        <Button
          aria-controls={contentId}
          aria-expanded={expanded}
          className={`${align === "end" ? "-me-2 justify-end" : "-ms-2 justify-start"} max-w-full h-6 sm:h-6 gap-2 !text-xs !font-medium text-muted-foreground`}
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="ghost"
        >
          <span className={`min-w-0 truncate ${align === "end" ? "text-right" : "text-left"}`}>{title}</span>
          <DisclosureActionIcon expanded={expanded} />
        </Button>
        <div className={`mt-0.5 min-w-0 space-y-0.5 ${align === "end" ? "text-right" : ""}`} hidden={!expanded} id={contentId}>
          {children}
        </div>
      </div>
      {align === "end" && <span className="w-8 shrink-0" />}
    </div>
  );
}
