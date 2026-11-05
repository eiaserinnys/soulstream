import type { EventPersistence } from "../db/event_persistence.js";
import { EventAcknowledgementTimeoutError } from "../upstream/event_outbox_pump_protocol.js";

export async function savePersistentMetadata(
  persistence: EventPersistence,
  sessionId: string,
  entry: Record<string, unknown>,
  replaceExistingType: string,
  apply: () => void,
): Promise<void> {
  try {
    await persistence.enqueueMetadataEffect(sessionId, entry, { replaceExistingType, waitForAck: true });
  } catch (error) {
    if (error instanceof EventAcknowledgementTimeoutError) apply();
    throw error;
  }
  apply();
}
