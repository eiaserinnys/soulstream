import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

import type { ReasoningEffort } from "./protocol.js";

/**
 * Adapter-boundary vocabulary.
 *
 * The internal accept-set (`ReasoningEffort`) is deliberately wider than either
 * SDK union, because it must also be able to *read* legacy rows and forward
 * values the newer app-server transport accepts:
 *
 *   internal : minimal low medium high xhigh max ultra
 *   Claude   :         low medium high xhigh max          (no minimal/ultra)
 *   Codex SDK: minimal low medium high xhigh              (no max/ultra)
 *   Codex app-server: free-form string advertised by the model (accepts all)
 *
 * These converters make the narrowing explicit instead of casting. They only
 * return `undefined` for values the SDK genuinely cannot express — which cannot
 * happen for a session created after this change, because creation validates the
 * requested effort against the preset's advertised `supported_efforts`. The
 * reachable case is a legacy row written before that validation existed.
 *
 * Returning `undefined` means "send nothing", i.e. the backend default. That is
 * not a silent downgrade of a supported choice: callers log it.
 */

const CLAUDE_SDK_EFFORTS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const CODEX_SDK_EFFORTS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function toClaudeSdkEffort(
  effort: ReasoningEffort | undefined,
): EffortLevel | undefined {
  if (effort === undefined) return undefined;
  return (CLAUDE_SDK_EFFORTS as readonly string[]).includes(effort)
    ? (effort as EffortLevel)
    : undefined;
}

export function toCodexSdkEffort(
  effort: ReasoningEffort | undefined,
): ModelReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  return (CODEX_SDK_EFFORTS as readonly string[]).includes(effort)
    ? (effort as ModelReasoningEffort)
    : undefined;
}
