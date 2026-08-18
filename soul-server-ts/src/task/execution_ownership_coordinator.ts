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

  constructor(readonly persistence: EventPersistence) {}

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
    return await this.persistence.reserveExecutionOwnershipAndWaitForApplication(sessionId, input);
  }

  async reserveAdoption(
    sessionId: string,
    input: Parameters<EventPersistence["reserveExecutionAdoptionAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    return await this.persistence.reserveExecutionAdoptionAndWaitForApplication(sessionId, input);
  }

  async prove(
    sessionId: string,
    ownershipGeneration: number,
    proof: Parameters<EventPersistence["proveExecutionOwnershipAndWaitForApplication"]>[2],
  ): Promise<EventSessionTransitionApplication> {
    return await this.persistence.proveExecutionOwnershipAndWaitForApplication(
      sessionId,
      ownershipGeneration,
      proof,
    );
  }

  async activate(
    sessionId: string,
    input: Parameters<EventPersistence["activateExecutionOwnershipAndWaitForApplication"]>[1],
  ): Promise<EventSessionTransitionApplication> {
    return await this.persistence.activateExecutionOwnershipAndWaitForApplication(sessionId, input);
  }

  async fail(
    sessionId: string,
    ownershipGeneration: number,
    failureReason: string,
  ): Promise<EventSessionTransitionApplication> {
    return await this.persistence.failExecutionOwnershipAndWaitForApplication(
      sessionId,
      ownershipGeneration,
      failureReason,
    );
  }

  async markOrphanedSpawn(
    sessionId: string,
    ownershipGeneration: number,
    proof: Parameters<EventPersistence["markExecutionOrphanedSpawnAndWaitForApplication"]>[2],
  ): Promise<EventSessionTransitionApplication> {
    return await this.persistence.markExecutionOrphanedSpawnAndWaitForApplication(
      sessionId,
      ownershipGeneration,
      proof,
    );
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
      && matchesOptional(canonical.registrationId, expected.registrationId)
      && matchesOptional(canonical.pid, expected.pid)
      && matchesOptional(canonical.startIdentity, expected.startIdentity)
      && matchesOptional(canonical.executionCommandId, expected.executionCommandId)
      && (expected.failureReason === undefined
        || canonical.failureReason === expected.failureReason);
  }
}

function matchesOptional<T>(actual: T, expected: T | undefined): boolean {
  return expected === undefined || actual === expected;
}
