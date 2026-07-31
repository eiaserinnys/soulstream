import { useEffect, useRef, useState } from "react";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui";

import {
  fetchNodeModelPresets,
  MODEL_PRESET_FETCH_ERROR,
} from "./model-presets";

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
        onErrorRef.current?.(MODEL_PRESET_FETCH_ERROR);
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [nodeId]);

  return catalog;
}
