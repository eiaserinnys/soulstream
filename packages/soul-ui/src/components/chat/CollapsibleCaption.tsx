"use client";

import { useId, useState, type ReactNode } from "react";
import { DisclosureActionIcon } from "../DisclosureActionIcon";
import { Button } from "../ui/button";

export interface CollapsibleCaptionProps {
  title: string;
  children: ReactNode;
  initiallyCollapsed?: boolean;
}

export function CollapsibleCaption({
  title,
  children,
  initiallyCollapsed = true,
}: CollapsibleCaptionProps) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(() => !initiallyCollapsed);

  return (
    <div className="flex gap-2 px-3 py-1" data-slot="collapsible-caption">
      <span className="w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <Button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="-ms-2 w-full justify-start gap-2 px-2 !text-xs !font-medium text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="ghost"
        >
          <span className="min-w-0 truncate text-left">{title}</span>
          <DisclosureActionIcon expanded={expanded} />
        </Button>
        <div className="min-w-0 space-y-0.5" hidden={!expanded} id={contentId}>
          {children}
        </div>
      </div>
    </div>
  );
}
