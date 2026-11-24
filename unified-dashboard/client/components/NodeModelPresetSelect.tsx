import { useEffect, useMemo } from "react";
import { Badge } from "@seosoyoung/soul-ui";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

import { CatalogSelectionField } from "./CatalogSelectionField";

import {
  modelPresetDisplayLabel,
  modelPresetOptionLabel,
  modelPresetUnavailableReason,
  modelPresetSelectionState,
} from "../lib/model-presets";
import {
  type NodeModelPresetCatalog,
  useNodeModelPresetCatalog,
} from "../lib/use-node-model-preset-catalog";

export function NodeModelPresetSelect({
  nodeId,
  value,
  label,
  ariaLabel,
  disabled = false,
  className,
  triggerClassName,
  modelPresetCatalog,
  missingPresetLabel,
  onValueChange,
  onPresetChange,
  onValidityChange,
  onError,
}: {
  nodeId: string;
  value: string;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  modelPresetCatalog?: NodeModelPresetCatalog;
  missingPresetLabel?(id: string): string;
  onValueChange(value: string): void;
  onPresetChange?(preset: ModelPresetAvailability | null): void;
  onValidityChange?(valid: boolean): void;
  onError?(message: string): void;
}) {
  const reuseExternalCatalog = Boolean(
    modelPresetCatalog
    && modelPresetCatalog.nodeId === nodeId,
  );
  const internalCatalog = useNodeModelPresetCatalog(
    reuseExternalCatalog ? "" : nodeId,
    onError,
  );
  const catalog = reuseExternalCatalog ? modelPresetCatalog! : internalCatalog;
  const catalogMatchesNode = catalog.nodeId === nodeId;
  const catalogStatus = catalogMatchesNode
    ? catalog.status
    : nodeId ? "loading" : "idle";
  const presets = catalogMatchesNode ? catalog.presets : [];
  const loading = catalogStatus === "loading";
  const loaded = catalogStatus === "ready";

  const selection = useMemo(
    () => modelPresetSelectionState(value, presets, loaded),
    [loaded, presets, value],
  );
  useEffect(() => {
    onPresetChange?.(selection.preset);
    onValidityChange?.(selection.valid);
  }, [onPresetChange, onValidityChange, selection.preset, selection.valid]);
  const selectedPresetMissing = Boolean(
    value && !presets.some((preset) => preset.id === value),
  );
  const triggerLabel = modelPresetDisplayLabel({
    selectedId: value,
    preset: selection.preset,
    status: catalogStatus,
    missingLabel: missingPresetLabel?.(value),
  });
  const missingText = selectedPresetMissing && loaded && missingPresetLabel ? "이 노드 목록에 없음" : null;

  return <CatalogSelectionField className={className} label={label} ariaLabel={ariaLabel ?? label}
    value={value} disabled={disabled || !nodeId} selectedLabel={selection.preset?.reason === "quota_exhausted" ? <span className="text-destructive">{triggerLabel}</span> : triggerLabel}
    triggerClassName={triggerClassName} invalid={Boolean(selection.warning)}
    options={[
      { value: "", label: "미지정" },
      ...(selectedPresetMissing ? [{ value, disabled: loaded, label: loading ? "선택한 모델 확인 중…" : missingPresetLabel?.(value) ?? "선택한 모델" }] : []),
      ...presets.map(preset => {
        const reason = modelPresetUnavailableReason(preset);
        return {
          value: preset.id,
          disabled: !preset.available,
          label: reason
            ? <span className="flex flex-col"><span>{preset.label}</span><span className="text-sm sm:text-xs">{reason}</span></span>
            : <span className={preset.reason === "quota_exhausted" ? "text-destructive" : undefined}>{modelPresetOptionLabel(preset)}</span>,
        };
      }),
    ]}
    adornment={selection.preset?.usage_warning ? <Badge variant="warning">사용량 확인 지연</Badge> : null}
    message={missingText ?? selection.warning} onValueChange={onValueChange}/>;
}
