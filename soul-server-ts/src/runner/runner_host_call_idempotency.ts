import type { RunnerHostCall } from "./runner_process_dispatcher.js";
import type { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";

type HostService = RunnerHostCall["service"];

const OPERATION_MUTABILITY = {
  session_store: {
    append: true,
    load: false,
    listSessions: false,
    delete: true,
    listSubkeys: false,
  },
  snapshot: {
    persistRunState: true,
    persistSessionItems: true,
  },
  claude_runtime: { observe: true },
  detached_event: { publish: true },
} as const satisfies Record<HostService, Record<string, boolean>>;

/** Durable, payload-free exactly-once guard for host-owned mutations. */
export class RunnerHostCallIdempotency {
  constructor(private readonly journal: RunnerSqliteEventOutbox) {}

  async execute(
    call: RunnerHostCall,
    apply: () => Promise<unknown>,
  ): Promise<{ data: unknown; replayed: boolean }> {
    if (!isMutatingRunnerHostCall(call.service, call.operation)) {
      return { data: await apply(), replayed: false };
    }
    const applied = await this.journal.readHostCallApplied(call.correlationId);
    if (applied) {
      if (applied.service !== call.service || applied.operation !== call.operation) {
        throw new Error("runner host-call correlation id was reused for a different operation");
      }
      return { data: null, replayed: true };
    }
    const data = await apply();
    await this.journal.recordHostCallApplied({
      correlationId: call.correlationId,
      service: call.service,
      operation: call.operation,
      createdAt: new Date().toISOString(),
    });
    return { data, replayed: false };
  }

  async acknowledge(correlationId: string): Promise<void> {
    await this.journal.acknowledgeHostCall(correlationId);
  }
}

export function isMutatingRunnerHostCall(
  service: HostService,
  operation: string,
): boolean {
  const inventory = OPERATION_MUTABILITY[service] as Record<string, boolean>;
  const mutating = inventory[operation];
  if (mutating === undefined) {
    throw new Error(`unsupported runner host call inventory: ${service}.${operation}`);
  }
  return mutating;
}
