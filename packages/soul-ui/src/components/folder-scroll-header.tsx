import type React from "react";
import { useLayoutEffect, useState } from "react";

export interface FolderScrollHeaderProps {
  scrollHeader?: React.ReactNode;
  scrollHeaderRef: React.RefObject<HTMLDivElement | null>;
}

export function FolderScrollHeader({
  scrollHeader,
  scrollHeaderRef,
}: FolderScrollHeaderProps) {
  if (!scrollHeader) return null;
  return (
    <div ref={scrollHeaderRef} data-testid="folder-session-scroll-header">
      {scrollHeader}
    </div>
  );
}

export function useScrollHeaderMargin(
  scrollHeaderRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) {
      setScrollMargin(0);
      return;
    }

    const header = scrollHeaderRef.current;
    if (!header) {
      setScrollMargin(0);
      return;
    }

    const updateHeight = (height: number) => {
      const nextHeight = Math.max(0, height);
      setScrollMargin((currentHeight) => (
        Math.abs(currentHeight - nextHeight) < 0.5 ? currentHeight : nextHeight
      ));
    };

    updateHeight(header.getBoundingClientRect().height);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateHeight(entry.contentRect.height);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [enabled, scrollHeaderRef]);

  return scrollMargin;
}
