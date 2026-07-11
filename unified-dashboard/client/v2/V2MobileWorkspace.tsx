import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { V2_TOKENS } from "./v2-token-fixture";

export function V2MobileWorkspace({
  pageId,
  navigation,
  pageSurface,
  pageOpenRequest = 0,
}: {
  pageId: string | null;
  navigation: ReactNode;
  pageSurface: ReactNode;
  pageOpenRequest?: number;
}) {
  const [showNavigation, setShowNavigation] = useState(pageId === null);
  useEffect(() => {
    if (pageId !== null) setShowNavigation(false);
  }, [pageId, pageOpenRequest]);

  if (showNavigation || pageId === null) {
    return (
      <div data-responsive-mode="single-pane" data-mobile-v2-pane="navigation" className="h-full">
        {navigation}
      </div>
    );
  }

  return (
    <div data-responsive-mode="single-pane" data-mobile-v2-pane="page" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-glass-border p-2">
        <button
          type="button"
          className={`flex items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground ${V2_TOKENS.control}`}
          onClick={() => setShowNavigation(true)}
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          Pages
        </button>
      </div>
      <div className="min-h-0 flex-1">{pageSurface}</div>
    </div>
  );
}
