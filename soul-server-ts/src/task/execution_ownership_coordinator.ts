import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { EventSessionTransitionApplication } from
  "../db/event_transition_publisher.js";

/**
 * One persistence boundary for all execution ownership paths.
 */
export class ExecutionOwnershipCoordinator {
  constructor(
    readonly persistence: EventPersistence,
    private readonly logger?: Pick<Logger, "info">,
  ) {}

  async release(
    sessionId: string,
    event: Parameters<EventPersistence["releaseExecutionOwnershipAndWaitForApplication"]>[1],
    input: Parameters<EventPersistence["releaseExecutionOwnershipAndWaitForApplication"]>[2],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .releaseExecutionOwnershipAndWaitForApplication(sessionId, event, input);
    this.logTransition(
      "release",
      sessionId,
      input.ownershipGeneration,
      application,
    );
    return application;
  }

  private logTransition(
    operation: "release",
    sessionId: string,
    ownershipGeneration: number,
    application: EventSessionTransitionApplication,
    failureReason?: string,
  ): void {
    this.logger?.info({
      sessionId,
      ownershipGeneration,
      operation,
      applied: application.applied,
      canonicalPhase: application.canonicalExecutionOwnership?.phase ?? null,
      ...(failureReason ? { failureReason } : {}),
    }, "Execution ownership lifecycle transition applied");
  }
}
