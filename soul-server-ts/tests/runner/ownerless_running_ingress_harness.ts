import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";

import { SessionReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import type {
  EventAppendBatch,
  EventIngressResult,
  EventSessionEffectApplication,
} from "../../../orch-server-ts/src/node/event_ingress_types.js";
import {
  buildEventOutboxAppendInput,
  EventPersistence,
} from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  computeEventOutboxPayloadHash,
  EventOutbox,
  type EventOutboxRecord,
  type EventOutboxSessionEffect,
} from "../../src/upstream/event_outbox.js";
import {
  EventOutboxPump,
  type EventAppendAck,
} from "../../src/upstream/event_outbox_pump.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import {
  LIVE_OWNER_IDENTITY,
  OWNERLESS_NODE_ID,
} from "./ownerless_running_reconciliation_fixture.js";

const logger = pino({ level: "silent" });

export interface IngressApplicationLog {
  sessionId: string;
  kind: string | null;
  outcome: "committed" | "dead_lettered" | "injected_failure";
  applied: boolean | null;
}

export class OwnerlessIngressHarness {
  readonly persistence: EventPersistence;
  readonly sessionReads: SessionReadRepository;
  readonly applications: IngressApplicationLog[] = [];
  terminalCommitAttempts = 0;

  private readonly directory: string;
  private readonly ingress: EventIngressRepository;
  private readonly outbox: EventOutbox;
  private readonly pump: EventOutboxPump;
  private directSourceSeq = 0;
  private terminalFailuresRemaining = 0;
  private terminalBarrier: (() => Promise<void>) | undefined;

  private constructor(
    readonly postgres: FullSchemaPostgresHarness,
    directory: string,
    ingress: EventIngressRepository,
    outbox: EventOutbox,
    pump: EventOutboxPump,
  ) {
    this.directory = directory;
    this.ingress = ingress;
    this.outbox = outbox;
    this.pump = pump;
    this.persistence = new EventPersistence(
      {} as SessionDB,
      {} as SessionBroadcaster,
      logger,
      outbox,
      pump,
    );
    this.sessionReads = new SessionReadRepository(
      postgres.sql as ConstructorParameters<typeof SessionReadRepository>[0],
    );
  }

  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<OwnerlessIngressHarness> {
    const directory = await mkdtemp(join(tmpdir(), "ownerless-running-red-"));
    const outbox = await EventOutbox.open(directory);
    const ingress = new EventIngressRepository(
      { resolveSql: async () => postgres.sql as unknown as EventIngressSql },
      applyEventSessionEffect,
    );
    const pump = new EventOutboxPump(outbox, () => undefined, {
      acknowledgementTimeoutMs: 5_000,
    });
    const harness = new OwnerlessIngressHarness(
      postgres,
      directory,
      ingress,
      outbox,
      pump,
    );
    void pump.connect(async (batch) => await harness.commitPumpBatch(batch));
    return harness;
  }

  async cleanup(): Promise<void> {
    this.pump.disconnect();
    await rm(this.directory, { recursive: true, force: true });
  }

  failNextTerminalCommit(): void {
    this.terminalFailuresRemaining += 1;
  }

  beforeNextTerminalCommit(barrier: () => Promise<void>): void {
    this.terminalBarrier = barrier;
  }

  clearInjections(): void {
    this.terminalFailuresRemaining = 0;
    this.terminalBarrier = undefined;
  }

  countApplications(sessionId: string, kind: string, applied?: boolean): number {
    return this.applications.filter((entry) =>
      entry.sessionId === sessionId
      && entry.kind === kind
      && (applied === undefined || entry.applied === applied)).length;
  }

  latestApplication(
    sessionId: string,
    kind: string,
  ): IngressApplicationLog | undefined {
    return this.applications.findLast(
      (entry) => entry.sessionId === sessionId && entry.kind === kind,
    );
  }

  async commitDirectAcquire(
    sessionId: string,
    now: Date,
  ): Promise<EventSessionEffectApplication> {
    this.directSourceSeq += 1;
    const effect: EventOutboxSessionEffect = {
      kind: "execution_acquire",
      owner_kind: LIVE_OWNER_IDENTITY.ownerKind,
      manifest_id: LIVE_OWNER_IDENTITY.manifestId,
      runtime_env_identity: LIVE_OWNER_IDENTITY.runtimeEnvIdentity,
      registration_id: LIVE_OWNER_IDENTITY.registrationId,
      pid: LIVE_OWNER_IDENTITY.pid,
      start_identity: LIVE_OWNER_IDENTITY.startIdentity,
      execution_command_id: LIVE_OWNER_IDENTITY.executionCommandId,
      lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      review_state: "not_required",
      updated_at: now.toISOString(),
    };
    const input = buildEventOutboxAppendInput(
      sessionId,
      {
        type: "metadata",
        metadata_type: "execution_ownership_transition",
        value: { transition_id: `race-acquire-${this.directSourceSeq}` },
        timestamp: now,
        _dedupe_key: `race-acquire:${sessionId}:${this.directSourceSeq}`,
      } as never,
      effect,
    );
    const unsigned = {
      stream_id: "00000000-0000-4000-8000-000000000202",
      source_seq: this.directSourceSeq,
      ...input,
    };
    const record: EventOutboxRecord = {
      ...unsigned,
      payload_hash: computeEventOutboxPayloadHash(unsigned),
    };
    const [result] = await this.ingress.commitBatch(OWNERLESS_NODE_ID, {
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: record.stream_id,
      first_seq: record.source_seq,
      events: [record],
    });
    if (!result || result.outcome !== "committed" || !result.sessionEffectApplication) {
      throw new Error("direct live acquire did not produce an ingress application");
    }
    this.recordApplication(record, result);
    return result.sessionEffectApplication;
  }

  private async commitPumpBatch(batch: EventAppendBatch): Promise<void> {
    const terminalRecords = batch.events.filter(
      (event) => event.session_effect?.kind === "terminal_transition",
    );
    this.terminalCommitAttempts += terminalRecords.length;
    try {
      if (terminalRecords.length > 0 && this.terminalBarrier) {
        const barrier = this.terminalBarrier;
        this.terminalBarrier = undefined;
        await barrier();
      }
      if (terminalRecords.length > 0 && this.terminalFailuresRemaining > 0) {
        this.terminalFailuresRemaining -= 1;
        for (const record of terminalRecords) {
          this.applications.push({
            sessionId: record.session_id,
            kind: "terminal_transition",
            outcome: "injected_failure",
            applied: null,
          });
        }
        throw new Error("injected ownerless terminal ingress failure");
      }
      const results = await this.ingress.commitBatch(OWNERLESS_NODE_ID, batch);
      results.forEach((result, index) => {
        const record = batch.events[index];
        if (record) this.recordApplication(record, result);
      });
      await this.pump.handleAck(toAck(batch, results));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.pump.handleAck({
        type: "event_append_ack",
        stream_id: batch.stream_id,
        acked_through: batch.events.at(-1)!.source_seq,
        events: batch.events.map((event) => ({
          source_seq: event.source_seq,
          dead_letter: {
            code: "OWNERLESS_RED_INJECTED_FAILURE",
            reason,
            rejected_at: new Date().toISOString(),
          },
        })),
      });
    }
  }

  private recordApplication(
    record: EventOutboxRecord,
    result: EventIngressResult,
  ): void {
    this.applications.push({
      sessionId: record.session_id,
      kind: record.session_effect?.kind ?? null,
      outcome: result.outcome,
      applied: result.outcome === "committed"
        ? result.sessionEffectApplication?.applied ?? null
        : null,
    });
  }
}

function toAck(
  batch: EventAppendBatch,
  results: EventIngressResult[],
): EventAppendAck {
  return {
    type: "event_append_ack",
    stream_id: batch.stream_id,
    acked_through: batch.events.at(-1)!.source_seq,
    events: results.map((result) => {
      if (result.outcome === "dead_lettered") {
        return {
          source_seq: result.envelope.source_seq,
          dead_letter: {
            code: result.deadLetter.code,
            reason: result.deadLetter.reason,
            rejected_at: result.deadLetter.rejectedAt,
          },
        };
      }
      return {
        source_seq: result.envelope.source_seq,
        event_id: result.eventId,
        ...(result.sessionEffectApplication?.canonicalSession
          ? {
              effect_application: {
                applied: result.sessionEffectApplication.applied,
                canonical_session: result.sessionEffectApplication.canonicalSession,
                ...(result.sessionEffectApplication.canonicalExecutionOwnership === undefined
                  ? {}
                  : {
                      canonical_execution_ownership:
                        result.sessionEffectApplication.canonicalExecutionOwnership,
                    }),
              },
            }
          : {}),
      };
    }),
  };
}
