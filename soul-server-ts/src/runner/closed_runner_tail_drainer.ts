import { performance } from "node:perf_hooks";

import type { Logger } from "pino";

import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventOutboxPumpStore,
} from "../upstream/event_outbox_pump.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import { RunnerParentOutbox } from "./runner_parent_outbox.js";
import type { RunnerRegistration } from "./runner_process_registry.js";

export interface ClosedRunnerTailOutbox extends EventOutboxPumpStore {
  readLatestPendingRecord(): Promise<EventOutboxRecord | null>;
  close(): void;
}

interface ClosedRunnerTailDrainerOptions {
  pumpMux: Pick<EventOutboxPumpMux, "register">;
  logger: Pick<Logger, "error" | "info" | "warn">;
  openOutbox?: (databasePath: string, sessionId: string) => Promise<ClosedRunnerTailOutbox>;
  monotonicNow?: () => number;
}

/** Drains only orch-bound events retained after a runner is durably closed. */
export class ClosedRunnerTailDrainer {
  constructor(private readonly options: ClosedRunnerTailDrainerOptions) {}

  async drain(registration: RunnerRegistration): Promise<void> {
    const startedAt = (this.options.monotonicNow ?? (() => performance.now()))();
    let outcome: "acknowledged" | "fully_acknowledged" | "failed" = "failed";
    let outbox: ClosedRunnerTailOutbox | undefined;
    let unregister: (() => void) | undefined;
    try {
      const openOutbox = this.options.openOutbox ?? (
        registration.closedTailState?.status === "requires_drain"
          ? RunnerParentOutbox.openClosedTail
          : RunnerParentOutbox.open
      );
      outbox = await openOutbox(
        registration.config.paths.databasePath,
        registration.config.sessionId,
      );
      const tail = await outbox.readLatestPendingRecord();
      if (!tail) {
        outcome = "fully_acknowledged";
        return;
      }
      const pump = new EventOutboxPump(outbox, (error) => {
        this.options.logger.error(
          { err: error, sessionId: registration.config.sessionId },
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
      outcome = "acknowledged";
    } finally {
      unregister?.();
      outbox?.close();
      this.options.logger.info({
        sessionId: registration.config.sessionId,
        durationMs: Math.max(
          0,
          (this.options.monotonicNow ?? (() => performance.now()))() - startedAt,
        ),
        outcome,
      }, "closed runner tail drain completed");
    }
  }
}
