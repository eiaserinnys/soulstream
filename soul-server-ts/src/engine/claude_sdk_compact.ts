import type { Query as ClaudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";
import type { CompactedContextUsage } from "./protocol.js";

export async function readCompactedContextUsage(
  query: Pick<ClaudeSdkQuery, "getContextUsage">,
  logger: Logger,
): Promise<CompactedContextUsage | undefined> {
  try {
    const response = asRecord(await query.getContextUsage());
    const usedTokens = response?.totalTokens;
    const maxTokens = response?.rawMaxTokens;
    if (
      typeof usedTokens !== "number"
      || !Number.isFinite(usedTokens)
      || usedTokens <= 0
      || typeof maxTokens !== "number"
      || !Number.isFinite(maxTokens)
      || maxTokens <= 0
    ) {
      return undefined;
    }
    return {
      usedTokens,
      maxTokens,
      estimated: response?.apiUsage == null,
    };
  } catch (err) {
    logger.warn({ err }, "Claude context usage query after compact failed");
    return undefined;
  }
}

export function buildClaudeCompactRunOptions(
  previous: ClaudeRunOptions,
  workspaceDir: string,
  sessionId: string,
  env: Record<string, string> | undefined,
): ClaudeRunOptions {
  const {
    prompt: _previousPrompt,
    resumeSessionId: _previousResumeSessionId,
    imageAttachmentPaths: _previousImageAttachmentPaths,
    ...preservedOptions
  } = previous;
  return {
    ...preservedOptions,
    prompt: "/compact",
    workspaceDir,
    resumeSessionId: sessionId,
    ...(env !== undefined ? { env } : {}),
  };
}

export async function consumeClaudeCompact(query: ClaudeSdkQuery): Promise<void> {
  let observedCompactBoundary = false;
  for await (const sdkMessage of query) {
    const message = asRecord(sdkMessage);
    if (message?.type === "system" && message.subtype === "compact_boundary") {
      observedCompactBoundary = true;
    }
    if (
      message?.type === "result"
      && (message.subtype !== "success" || message.is_error === true)
    ) {
      const detail = asString(message.result)
        ?? (Array.isArray(message.errors) ? asString(message.errors[0]) : undefined)
        ?? asString(message.subtype)
        ?? "unknown result";
      throw new Error(`Claude compact failed: ${detail}`);
    }
  }
  if (!observedCompactBoundary) {
    throw new Error("Claude compact finished without compact_boundary");
  }
}
