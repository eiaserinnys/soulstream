import { useEffect, useMemo } from "react";
import {
  Badge,
  type ModelPresetAvailability,
} from "@seosoyoung/soul-ui";

import { CatalogSelectionField } from "./CatalogSelectionField";

import {
  modelPresetDisplayLabel,
  modelPresetOptionLabel,
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
  disabled = false,
  className,
  triggerClassName,
  modelPresetCatalog,
  onValueChange,
  onPresetChange,
  onValidityChange,
  onError,
}: {
  nodeId: string;
  value: string;
  label: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  modelPresetCatalog?: NodeModelPresetCatalog;
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
  });

  return <CatalogSelectionField className={className} label={label} ariaLabel={label}
    value={value} disabled={disabled || !nodeId} selectedLabel={selection.preset?.reason === "quota_exhausted" ? <span className="text-destructive">{triggerLabel}</span> : triggerLabel}
    triggerClassName={triggerClassName} invalid={Boolean(selection.warning)}
    options={[
      { value: "", label: "미지정" },
      ...(selectedPresetMissing ? [{ value, disabled: loaded, label: loading ? "선택한 모델 확인 중…" : "선택한 모델" }] : []),
      ...presets.map(preset => ({ value: preset.id, disabled: !preset.available, label: <span className={preset.reason === "quota_exhausted" ? "text-destructive" : undefined}>{modelPresetOptionLabel(preset)}</span> })),
    ]}
    adornment={selection.preset?.usage_warning ? <Badge variant="warning">사용량 확인 지연</Badge> : null}
    message={selection.warning} onValueChange={onValueChange}/>;
}
