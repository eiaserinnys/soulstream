import type { RunnerHostCall } from "./runner_process_dispatcher.js";

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
  execution_ownership: { renew: true },
} as const satisfies Record<HostService, Record<string, boolean>>;

/** Payload-free IPC replay receipt; exactly-once belongs to each mutation owner. */
export class RunnerHostCallIdempotency {
  constructor(private readonly journal: RunnerHostCallReceiptStore) {}

  async execute(
    call: RunnerHostCall,
    apply: (idempotencyKey: string) => Promise<unknown>,
  ): Promise<{ data: unknown; replayed: boolean }> {
    if (!isMutatingRunnerHostCall(call.service, call.operation)) {
      return { data: await apply(call.correlationId), replayed: false };
    }
    const applied = await this.journal.readHostCallApplied(call.correlationId);
    if (applied) {
      if (applied.service !== call.service || applied.operation !== call.operation) {
        throw new Error("runner host-call correlation id was reused for a different operation");
      }
    }
    // The durable owner, not this runner-local journal, provides exactly-once.
    // A new host must reapply the call to rebuild host memory; the owner consumes
    // correlationId and returns its committed result without repeating mutation.
    const data = await apply(call.correlationId);
    if (!applied) {
      await this.journal.recordHostCallApplied({
        correlationId: call.correlationId,
        service: call.service,
        operation: call.operation,
        createdAt: new Date().toISOString(),
      });
    }
    return { data, replayed: applied !== null };
  }

  async acknowledge(correlationId: string): Promise<void> {
    await this.journal.acknowledgeHostCall(correlationId);
  }
}

export interface RunnerHostCallReceiptStore {
  readHostCallApplied(correlationId: string): Promise<{
    correlationId: string;
    service: string;
    operation: string;
  } | null>;
  recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): Promise<void>;
  acknowledgeHostCall(correlationId: string): Promise<void>;
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
