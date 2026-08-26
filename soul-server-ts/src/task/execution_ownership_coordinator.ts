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

  async acquire(
    sessionId: string,
    input: Parameters<EventPersistence["acquireExecutionOwnershipAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .acquireExecutionOwnershipAndWaitForApplication(sessionId, input);
    this.logTransition(
      "acquire",
      sessionId,
      application.canonicalExecutionOwnership?.ownershipGeneration ?? 0,
      application,
    );
    return application;
  }

  async renew(
    sessionId: string,
    input: Parameters<EventPersistence["renewExecutionOwnershipAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .renewExecutionOwnershipAndWaitForApplication(sessionId, input);
    this.logTransition(
      "renew",
      sessionId,
      input.ownershipGeneration,
      application,
    );
    return application;
  }

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
    operation:
      | "acquire"
      | "renew"
      | "release",
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
