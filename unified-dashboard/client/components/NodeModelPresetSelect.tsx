import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  type ModelPresetAvailability,
} from "@seosoyoung/soul-ui";

import {
  fetchNodeModelPresets,
  modelPresetOptionLabel,
  modelPresetSelectionState,
} from "../lib/model-presets";

export function NodeModelPresetSelect({
  nodeId,
  value,
  label,
  disabled = false,
  className,
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
  onValueChange(value: string): void;
  onPresetChange?(preset: ModelPresetAvailability | null): void;
  onValidityChange?(valid: boolean): void;
  onError?(message: string): void;
}) {
  const [presets, setPresets] = useState<ModelPresetAvailability[]>([]);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!nodeId) {
      setPresets([]);
      setLoadedNodeId(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void fetchNodeModelPresets(nodeId).then((next) => {
      if (!active) return;
      setPresets(next);
      setLoadedNodeId(nodeId);
    }).catch((caught: unknown) => {
      if (!active) return;
      setPresets([]);
      setLoadedNodeId(null);
      onErrorRef.current?.(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [nodeId]);

  const selection = useMemo(
    () => modelPresetSelectionState(value, presets, loadedNodeId === nodeId && !loading),
    [loadedNodeId, loading, nodeId, presets, value],
  );
  useEffect(() => {
    onPresetChange?.(selection.preset);
    onValidityChange?.(selection.valid);
  }, [onPresetChange, onValidityChange, selection.preset, selection.valid]);
  const selectedPresetMissing = Boolean(
    value && !presets.some((preset) => preset.id === value),
  );

  return (
    <label className={className}>
      <span>{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <select
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/24 disabled:cursor-not-allowed disabled:opacity-64 sm:min-h-8"
          value={value}
          aria-label={`${label} 선택`}
          aria-invalid={selection.warning ? true : undefined}
          disabled={disabled || !nodeId || loading}
          onChange={(event) => onValueChange(event.target.value)}
        >
          <option value="">{loading ? "불러오는 중…" : "미지정"}</option>
          {selectedPresetMissing ? (
            <option value={value} disabled={loadedNodeId === nodeId}>
              {loading ? "선택한 모델 확인 중…" : "선택한 모델"}
            </option>
          ) : null}
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id} disabled={!preset.available}>
              {modelPresetOptionLabel(preset)}
            </option>
          ))}
        </select>
        {selection.preset?.usage_warning ? (
          <Badge variant="warning" size="sm">(사용량 확인 지연)</Badge>
        ) : null}
      </span>
      {selection.warning ? <small role="alert">{selection.warning}</small> : null}
    </label>
  );
}
