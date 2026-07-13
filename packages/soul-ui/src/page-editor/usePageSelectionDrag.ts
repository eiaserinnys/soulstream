import { useEffect, useState } from "react";

export function usePageSelectionDrag({
  onStart,
  onEnter,
}: {
  onStart(blockId: string): void;
  onEnter(blockId: string): void;
}) {
  const [anchorId, setAnchorId] = useState<string | null>(null);

  useEffect(() => {
    const finish = () => setAnchorId(null);
    document.addEventListener("mouseup", finish);
    return () => document.removeEventListener("mouseup", finish);
  }, []);

  return {
    start(blockId: string) {
      setAnchorId(blockId);
      onStart(blockId);
    },
    enter(blockId: string) {
      if (anchorId !== null) onEnter(blockId);
    },
  };
}
