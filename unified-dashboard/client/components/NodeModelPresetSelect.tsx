import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Badge,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  type ModelPresetAvailability,
} from "@seosoyoung/soul-ui";

import {
  fetchNodeModelPresets,
  modelPresetOptionLabel,
  modelPresetSelectionState,
} from "../lib/model-presets";

const MODEL_PRESET_FETCH_TIMEOUT_MS = 10_000;
const MODEL_PRESET_FETCH_ERROR = "모델 목록을 불러오지 못했습니다";

export function NodeModelPresetSelect({
  nodeId,
  value,
  label,
  disabled = false,
  className,
  triggerClassName,
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
  onValueChange(value: string): void;
  onPresetChange?(preset: ModelPresetAvailability | null): void;
  onValidityChange?(valid: boolean): void;
  onError?(message: string): void;
}) {
  const [presets, setPresets] = useState<ModelPresetAvailability[]>([]);
  const [loadedNodeId, setLoadedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const selectId = useId();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!nodeId) {
      setPresets([]);
      setLoadedNodeId(null);
      setLoading(false);
      setLoadError(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      MODEL_PRESET_FETCH_TIMEOUT_MS,
    );
    setPresets([]);
    setLoadedNodeId(null);
    setLoading(true);
    setLoadError(false);
    void fetchNodeModelPresets(nodeId, globalThis.fetch, controller.signal).then((next) => {
      if (!active) return;
      setPresets(next);
      setLoadedNodeId(nodeId);
    }).catch(() => {
      if (!active) return;
      setPresets([]);
      setLoadedNodeId(null);
      setLoadError(true);
      onErrorRef.current?.(MODEL_PRESET_FETCH_ERROR);
    }).finally(() => {
      window.clearTimeout(timeoutId);
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
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
  const triggerLabel = loadError
    ? MODEL_PRESET_FETCH_ERROR
    : selection.preset
      ? modelPresetOptionLabel(selection.preset, undefined, false)
      : loading
        ? value ? "선택한 모델 확인 중…" : "불러오는 중…"
        : value ? "선택한 모델" : "미지정";

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
              <SelectItem value={value} disabled={loadedNodeId === nodeId}>
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
