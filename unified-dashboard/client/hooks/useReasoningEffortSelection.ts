import { useCallback, useEffect, useRef, useState } from "react";

import {
  defaultEffortForPreset,
  effortOptionsForPreset,
  isEffortSupported,
  reasoningEffortForSubmit,
  type EffortPreset,
} from "../utils/reasoningEffort";

export interface ReasoningEffortSelection {
  /** Advertised choices for the current preset. Empty means "no effort control". */
  options: readonly string[];
  /** Value to render: the manual pick, else the preset default, else undefined. */
  effective: string | undefined;
  /** Manual pick only; null means "follow the preset". */
  selected: string | null;
  setSelected: (value: string | null) => void;
  /** Value to send. Undefined lets the node apply the preset default. */
  submitValue: string | undefined;
  /** True when the current value is not advertised by the current preset. */
  unsupported: boolean;
  reset: () => void;
}

/**
 * Shared effort state for every web creation surface.
 *
 * Refill is keyed on **node + preset id**, not on the loaded preset object, for
 * two reasons:
 *
 *  - requirement: changing model or node must adopt the new preset's default,
 *    even when the previous manual pick happens to be legal on the new preset
 *    (Opus `low` -> Astra must show Astra's `medium`, not keep `low`), and even
 *    when two nodes advertise the same preset id with different defaults;
 *  - the key is known synchronously while the advertisement is still loading, so
 *    an in-flight catalog fetch can never wipe a seeded value, and a refresh for
 *    the same node+preset leaves a manual pick alone.
 */
export function useReasoningEffortSelection(params: {
  /**
   * Identity of the *advertised* preset, i.e. node + preset id. Two nodes can
   * advertise the same preset id with different defaults, so the id alone is not
   * a switch. Conversely a catalogue refresh for the same node+preset is not a
   * switch either, and must not discard a manual pick.
   */
  presetKey: string | null;
  preset: EffortPreset | null | undefined;
  /** Effort carried over from a predecessor, honoured while the preset is unchanged. */
  initialEffort?: string | null;
}): ReasoningEffortSelection {
  const { presetKey, preset, initialEffort = null } = params;
  const [selected, setSelected] = useState<string | null>(initialEffort);
  const lastPresetKey = useRef<string | null>(presetKey);

  useEffect(() => {
    if (lastPresetKey.current === presetKey) return;
    lastPresetKey.current = presetKey;
    // A different node+preset owns a different default; the previous manual pick
    // and any inherited value stop applying.
    setSelected(null);
  }, [presetKey]);

  const options = effortOptionsForPreset(preset);
  const effective = selected ?? defaultEffortForPreset(preset);
  const reset = useCallback(() => {
    lastPresetKey.current = presetKey;
    setSelected(initialEffort);
  }, [initialEffort, presetKey]);

  return {
    options,
    effective,
    selected,
    setSelected,
    submitValue: reasoningEffortForSubmit(preset, selected),
    unsupported: !isEffortSupported(preset, selected),
    reset,
  };
}
