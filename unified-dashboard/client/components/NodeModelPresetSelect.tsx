import { useEffect, useId, useMemo } from "react";
import {
  Badge,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  type ModelPresetAvailability,
} from "@seosoyoung/soul-ui";

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
  const selectId = useId();
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

  return (
    <div className={className}>
      <label htmlFor={selectId}>{label}</label>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Select
          id={selectId}
          value={value}
          disabled={disabled || !nodeId}
          modal={false}
          onValueChange={(next) => onValueChange(next ?? "")}
        >
          <SelectTrigger
            className={triggerClassName}
            aria-label="모델 선택"
            aria-invalid={selection.warning ? true : undefined}
          >
            <span className="flex-1 truncate">{triggerLabel}</span>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">미지정</SelectItem>
            {selectedPresetMissing ? (
              <SelectItem value={value} disabled={loaded}>
                {loading ? "선택한 모델 확인 중…" : "선택한 모델"}
              </SelectItem>
            ) : null}
            {presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id} disabled={!preset.available}>
                {modelPresetOptionLabel(preset)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {selection.preset?.usage_warning ? (
          <Badge variant="warning">사용량 확인 지연</Badge>
        ) : null}
      </div>
      {selection.warning ? <small role="alert">{selection.warning}</small> : null}
    </div>
  );
}
