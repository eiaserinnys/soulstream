import { useEffect, useRef, useState } from "react";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

import { fetchNodeModelPresets } from "@seosoyoung/soul-ui/shared/model-presets";
import { useTranslation } from "react-i18next";
import { modelPresetFetchError } from "./model-presets";

const MODEL_PRESET_FETCH_TIMEOUT_MS = 10_000;

export interface NodeModelPresetCatalog {
  status: "idle" | "loading" | "ready" | "error";
  nodeId: string;
  presets: ModelPresetAvailability[];
}

export function useNodeModelPresetCatalog(
  nodeId: string,
  onError?: (message: string) => void,
): NodeModelPresetCatalog {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<NodeModelPresetCatalog>({
    status: "idle",
    nodeId: "",
    presets: [],
  });
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!nodeId) {
      setCatalog({ status: "idle", nodeId: "", presets: [] });
      return;
    }

    let active = true;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      MODEL_PRESET_FETCH_TIMEOUT_MS,
    );
    setCatalog({ status: "loading", nodeId, presets: [] });
    void fetchNodeModelPresets(nodeId, globalThis.fetch, controller.signal)
      .then((presets) => {
        if (active) setCatalog({ status: "ready", nodeId, presets });
      })
      .catch(() => {
        if (!active) return;
        setCatalog({ status: "error", nodeId, presets: [] });
        onErrorRef.current?.(modelPresetFetchError(t));
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [nodeId,t]);

  return catalog;
}
