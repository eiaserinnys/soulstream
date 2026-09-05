import { readClaudeBackgroundDeliveryMetadata } from
  "./claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from
  "./claude_background_provenance.js";
import { isPostResultDrainEvent } from "./claude_event_phase.js";
import { readClaudeResultReceiptMetadata } from
  "./claude_result_receipt_metadata.js";
import { readClaudeSdkSessionMetadata } from
  "./claude_sdk_session_metadata.js";
import { readClaudeToolResultReceiptMetadata } from
  "./claude_tool_result_receipt_metadata.js";

/** Serializes non-public event metadata at every runner transport boundary. */
export function engineEventMetadata(payload: object): Record<string, unknown> | undefined {
  const postResultDrain = isPostResultDrainEvent(payload);
  const provenance = readClaudeBackgroundProvenance(payload);
  const delivery = readClaudeBackgroundDeliveryMetadata(payload);
  const resultReceipt = readClaudeResultReceiptMetadata(payload);
  const toolResultReceipt = readClaudeToolResultReceiptMetadata(payload);
  const sdkSession = readClaudeSdkSessionMetadata(payload);
  if (
    !postResultDrain && !provenance && !delivery && !resultReceipt &&
    !toolResultReceipt && !sdkSession
  ) {
    return undefined;
  }
  return {
    ...(postResultDrain ? { claudePostResultDrain: true } : {}),
    ...(provenance ? { claudeBackgroundProvenance: provenance } : {}),
    ...(delivery ? { claudeBackgroundDelivery: delivery } : {}),
    ...(resultReceipt ? { claudeResultReceipt: resultReceipt } : {}),
    ...(toolResultReceipt ? { claudeToolResultReceipt: toolResultReceipt } : {}),
    ...(sdkSession ? { claudeSdkSession: sdkSession } : {}),
  };
}
