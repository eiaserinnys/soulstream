import {
  UnknownModelPresetError,
  type ModelCatalog,
  type ModelPreset,
} from "../model_catalog.js";
import type { ReasoningEffort } from "../engine/protocol.js";

export type ReasoningEffortPresetResolver = Pick<ModelCatalog, "resolve">;

/** Preset facts the effort decision depends on. */
export type ReasoningEffortPreset = Pick<
  ModelPreset,
  "id" | "supported_efforts" | "default_effort"
>;

/**
 * Thrown when a create request names an effort the selected preset does not
 * advertise. Never downgrade instead of throwing: the product contract is that
 * an unusable effort is reported, not silently replaced.
 */
export class UnsupportedReasoningEffortError extends Error {
  readonly code = "UNSUPPORTED_REASONING_EFFORT";

  constructor(
    readonly requested: string,
    readonly presetId: string | undefined,
    readonly supported: readonly ReasoningEffort[] | undefined,
  ) {
    super(
      supported && supported.length > 0
        ? `Reasoning effort "${requested}" is not supported by model preset `
          + `"${presetId}". Supported: ${supported.join(", ")}.`
        : presetId
          ? `Model preset "${presetId}" does not support reasoning effort selection.`
          : "Reasoning effort requires a model preset that advertises supported efforts.",
    );
    this.name = "UnsupportedReasoningEffortError";
  }
}

/**
 * Single canonical decision for a *new* session's effort (D6/D7).
 *
 * Order: explicit request > preset `default_effort` > undefined (backend default).
 *
 * Validation uses the preset's advertised `supported_efforts` — the accept-set in
 * `engine/protocol.ts` is only about what older rows and wire consumers may still
 * carry, and must not be used to admit new requests.
 */
export function resolveReasoningEffortForCreate(
  preset: ReasoningEffortPreset | undefined,
  requested: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (requested === undefined) return preset?.default_effort;

  const supported = preset?.supported_efforts;
  if (!supported || !supported.includes(requested)) {
    throw new UnsupportedReasoningEffortError(requested, preset?.id, supported);
  }
  return requested;
}

/**
 * Resolves the preset used for the effort decision without letting a stale or
 * removed preset id fail session creation on its own. An unresolvable preset
 * yields `undefined`, which then makes any *explicit* effort a hard error while
 * leaving effort-less creation untouched.
 */
export function resolveEffortPreset(
  presetId: string | null | undefined,
  catalog: ReasoningEffortPresetResolver | undefined,
): ReasoningEffortPreset | undefined {
  const id = presetId?.trim();
  if (!id || !catalog) return undefined;
  try {
    return catalog.resolve(id);
  } catch (error) {
    if (error instanceof UnknownModelPresetError) return undefined;
    throw error;
  }
}
