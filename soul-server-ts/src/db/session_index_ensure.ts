import type { Logger } from "pino";

export interface StableSessionOrderIndexDb {
  ensureStableSessionOrderIndex(): Promise<void>;
}

export function ensureStableSessionOrderIndexInBackground(
  db: StableSessionOrderIndexDb,
  logger: Logger,
): void {
  void db
    .ensureStableSessionOrderIndex()
    .then(() => {
      logger.info("Stable session order index ensure completed");
    })
    .catch((err: unknown) => {
      logger.error(
        { err },
        "Stable session order index ensure failed; continuing without index",
      );
    });
}
