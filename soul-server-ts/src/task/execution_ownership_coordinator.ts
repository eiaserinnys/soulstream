import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { EventSessionTransitionApplication } from
  "../db/event_transition_publisher.js";

import type {
  CanonicalExecutionOwnership,
  ExecutionOwnershipPhase,
} from "./execution_ownership.js";

export type ExecutionOwnershipOperation =
  | "reserve"
  | "spawn"
  | "attach"
  | "adopt"
  | "recovery";

export interface ExpectedCanonicalExecutionOwnership {
  ownershipGeneration: number;
  ownerKind?: CanonicalExecutionOwnership["ownerKind"];
  manifestId?: string;
  runtimeEnvIdentity?: string;
  registrationId?: string;
  pid?: number;
  startIdentity?: string;
  executionCommandId?: string;
  phases: readonly ExecutionOwnershipPhase[];
  failureReason?: string | null;
}

/**
 * One host-side entry gate for all execution ownership paths.
 *
 * The promise tail is only a local optimization. Every caller must still use
 * the generation-fenced persistence transitions; their canonical owner token
 * is the final authority after restart or cross-process races.
 */
export class ExecutionOwnershipCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    readonly persistence: EventPersistence,
    private readonly logger?: Pick<Logger, "info">,
  ) {}

  async withSessionLease<T>(
    sessionId: string,
    _operation: ExecutionOwnershipOperation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }

  async reserve(
    sessionId: string,
    input: Parameters<EventPersistence["reserveExecutionOwnershipAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .reserveExecutionOwnershipAndWaitForApplication(sessionId, input);
    this.logTransition("reserve", sessionId, input.ownershipGeneration, application);
    return application;
  }

  async reserveAdoption(
    sessionId: string,
    input: Parameters<EventPersistence["reserveExecutionAdoptionAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .reserveExecutionAdoptionAndWaitForApplication(sessionId, input);
    this.logTransition("adopt_reserve", sessionId, input.ownershipGeneration, application);
    return application;
  }

  async prove(
    sessionId: string,
    ownershipGeneration: number,
    proof: Parameters<EventPersistence["proveExecutionOwnershipAndWaitForApplication"]>[2],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence.proveExecutionOwnershipAndWaitForApplication(
      sessionId,
      ownershipGeneration,
      proof,
    );
    this.logTransition("prove", sessionId, ownershipGeneration, application);
    return application;
  }

  async activate(
    sessionId: string,
    input: Parameters<EventPersistence["activateExecutionOwnershipAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .activateExecutionOwnershipAndWaitForApplication(sessionId, input);
    this.logTransition("activate", sessionId, input.ownershipGeneration, application);
    return application;
  }

  async fail(
    sessionId: string,
    ownershipGeneration: number,
    failureReason: string,
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence.failExecutionOwnershipAndWaitForApplication(
      sessionId,
      ownershipGeneration,
      failureReason,
    );
    this.logTransition("fail", sessionId, ownershipGeneration, application, failureReason);
    return application;
  }

  async expireDeadOwner(
    sessionId: string,
    input: Parameters<EventPersistence["expireDeadExecutionOwnerAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence
      .expireDeadExecutionOwnerAndWaitForApplication(sessionId, input);
    this.logTransition(
      "expire_dead_owner",
      sessionId,
      input.ownershipGeneration,
      application,
      input.failureReason,
    );
    return application;
  }

  async markOrphanedSpawn(
    sessionId: string,
    ownershipGeneration: number,
    proof: Parameters<EventPersistence["markExecutionOrphanedSpawnAndWaitForApplication"]>[2],
  ): Promise<EventSessionTransitionApplication> {
    const application = await this.persistence.markExecutionOrphanedSpawnAndWaitForApplication(
      sessionId,
      ownershipGeneration,
      proof,
    );
    this.logTransition("orphaned_spawn", sessionId, ownershipGeneration, application);
    return application;
  }

  isAppliedOrSameOwner(
    application: EventSessionTransitionApplication,
    expected: ExpectedCanonicalExecutionOwnership,
  ): boolean {
    if (application.applied) return true;
    const canonical = application.canonicalExecutionOwnership;
    return canonical !== null
      && canonical !== undefined
      && canonical.ownershipGeneration === expected.ownershipGeneration
      && expected.phases.includes(canonical.phase)
      && matchesOptional(canonical.ownerKind, expected.ownerKind)
      && matchesOptional(canonical.manifestId, expected.manifestId)
      && matchesOptional(canonical.runtimeEnvIdentity, expected.runtimeEnvIdentity)
      && matchesOptional(canonical.registrationId, expected.registrationId)
      && matchesOptional(canonical.pid, expected.pid)
      && matchesOptional(canonical.startIdentity, expected.startIdentity)
      && matchesOptional(canonical.executionCommandId, expected.executionCommandId)
      && (expected.failureReason === undefined
        || canonical.failureReason === expected.failureReason);
  }

  private logTransition(
    operation:
      | "reserve"
      | "adopt_reserve"
      | "prove"
      | "activate"
      | "fail"
      | "expire_dead_owner"
      | "orphaned_spawn",
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

function matchesOptional<T>(actual: T, expected: T | undefined): boolean {
  return expected === undefined || actual === expected;
}
