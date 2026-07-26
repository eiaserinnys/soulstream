import type { SessionDB } from "../db/session_db.js";

export async function preflightPersistentRuntimeSchema(
  db: SessionDB,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  try {
    await db.assertRuntimeSchemaReady();
  } catch (error) {
    await db.close();
    throw error;
  }
}
