import type { Logger } from "pino";

import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventOutboxPumpStore,
} from "../upstream/event_outbox_pump.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";

export interface ClosedRunnerTailOutbox extends EventOutboxPumpStore {
  readLatestPendingRecord(): Promise<EventOutboxRecord | null>;
  close(): void;
}

interface ClosedRunnerTailDrainerOptions {
  pumpMux: Pick<EventOutboxPumpMux, "register">;
  logger: Pick<Logger, "error" | "info" | "warn">;
  openOutbox?: (databasePath: string) => Promise<ClosedRunnerTailOutbox>;
}

/** Drains only orch-bound events retained after a runner is durably closed. */
export class ClosedRunnerTailDrainer {
  constructor(private readonly options: ClosedRunnerTailDrainerOptions) {}

  async drain(registration: RunnerRegistration): Promise<void> {
    const openOutbox = this.options.openOutbox ?? RunnerSqliteEventOutbox.open;
    const outbox = await openOutbox(registration.config.paths.databasePath);
    let unregister: (() => void) | undefined;
    try {
      const tail = await outbox.readLatestPendingRecord();
      if (!tail) return;
      const pump = new EventOutboxPump(outbox, (error) => {
        this.options.logger.error(
          { error, sessionId: registration.config.sessionId },
          "closed runner tail pump failed",
        );
      }, {
        onQuarantine: (result) => {
          this.options.logger.warn({
            path: result.path,
            sourceSeq: result.sourceSeq,
            sessionId: result.sessionId,
            code: result.code,
            attempts: result.attempts,
          }, "closed runner durable event tail quarantined after repeated rejection");
        },
      });
      const acknowledgement = pump.waitForAcknowledgement(tail);
      unregister = this.options.pumpMux.register(pump);
      const eventId = await acknowledgement;
      this.options.logger.info(
        {
          sessionId: registration.config.sessionId,
          sourceSeq: tail.source_seq,
          eventId,
        },
        "closed runner durable event tail acknowledged",
      );
    } finally {
      unregister?.();
      outbox.close();
    }
  }
}
