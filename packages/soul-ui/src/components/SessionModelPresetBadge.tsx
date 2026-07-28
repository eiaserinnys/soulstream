import { useEffect, useState } from "react";

import { cn } from "../lib/cn";
import type { SessionSummary } from "../shared/session-types";
import { fetchNodeModelPresets } from "../shared/model-presets";
import { Badge } from "./ui/badge";

export function SessionModelPresetBadge({
  className,
  session,
}: {
  className?: string;
  session: Pick<SessionSummary, "modelPreset" | "nodeId"> | null | undefined;
}) {
  const nodeId = session?.nodeId?.trim() ?? "";
  const presetId = session?.modelPreset?.trim() ?? "";
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(null);
    if (!nodeId || !presetId) return;

    let active = true;
    const controller = new AbortController();
    void fetchNodeModelPresets(nodeId, globalThis.fetch, controller.signal)
      .then((presets) => {
        if (!active) return;
        const nextLabel = presets
          .find((preset) => preset.id === presetId)
          ?.label.trim();
        setLabel(nextLabel || null);
      })
      .catch(() => {
        if (active) setLabel(null);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [nodeId, presetId]);

  if (!label) return null;

  return (
    <Badge
      data-testid="session-model-preset"
      variant="outline"
      size="sm"
      className={cn("max-w-32 text-muted-foreground", className)}
      title={label}
      aria-label={`Selected model: ${label}`}
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}
