import { useTranslation } from "react-i18next";
import { useEffect, useMemo } from "react";
import { Badge } from "@seosoyoung/soul-ui";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

import { CatalogSelectionField } from "./CatalogSelectionField";

import {
  hasNoAvailableModelPreset,
  modelPresetDisplayLabel,
  modelPresetOptionLabel,
  modelPresetReasonText,
  modelPresetSelectionState,
  modelPresetsByAgentBackend,
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
  agentBackend,
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
  agentBackend?: string | null;
  onValueChange(value: string): void;
  onPresetChange?(preset: ModelPresetAvailability | null): void;
  onValidityChange?(valid: boolean): void;
  onError?(message: string): void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const reuseExternalCatalog = Boolean(
    modelPresetCatalog
    && modelPresetCatalog.nodeId === nodeId,
  );
  const internalCatalog = useNodeModelPresetCatalog(
    reuseExternalCatalog ? "" : nodeId,
    onError ? () => onError(t("accounts.models.loadError")) : undefined,
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
    () => modelPresetSelectionState(value, presets, loaded, t),
    [loaded, presets, t, value],
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
  }, t, locale);
  const missingText = selectedPresetMissing && loaded && missingPresetLabel ? t("accounts.models.missingOnNode") : null;

  return <CatalogSelectionField className={className} label={label} ariaLabel={ariaLabel ?? label}
    value={value} disabled={disabled || !nodeId} selectedLabel={selection.preset?.reason === "quota_exhausted" ? <span className="text-destructive">{triggerLabel}</span> : triggerLabel}
    triggerClassName={triggerClassName} invalid={Boolean(selection.warning)}
    options={[
      { value: "", label: t("accounts.models.unspecified") },
      ...(selectedPresetMissing ? [{ value, disabled: loaded, label: loading ? t("accounts.models.checkingSelected") : missingPresetLabel?.(value) ?? t("accounts.models.selected") }] : []),
      ...modelPresetsByAgentBackend(presets, agentBackend).map(preset => {
        const reason = modelPresetReasonText(preset, t, locale);
        return {
          value: preset.id,
          disabled: !preset.available,
          label: reason
            ? <span className="flex flex-col"><span className={preset.reason === "quota_exhausted" ? "text-destructive" : undefined}>{preset.label}</span><span className="text-sm sm:text-xs">{reason}</span></span>
            : modelPresetOptionLabel(preset, undefined, true, t, locale),
        };
      }),
    ]}
    adornment={selection.preset?.usage_warning ? <Badge variant="warning">{t("accounts.quota.delayed")}</Badge> : null}
    message={missingText ?? selection.warning ?? (hasNoAvailableModelPreset({ status: catalogStatus, presets }) ? t("accounts.models.none") : null)} onValueChange={onValueChange}/>;
}
