import type { NodeRegistryEvent } from '../node/registry.js';
import { collectTurnSummaryCompleteJobs, type TurnSummaryCompleteJob } from '../turn-summary/turn_summary_pipeline.js';
import { evaluateCardObservation, type ObservationInput, type ObservationOutcome } from './jev_card_observation.js';

export interface CardObservationJob extends TurnSummaryCompleteJob {
  finalResponseEventId: number; previousCompleteEventId: number; capturedAt: string;
}
export interface CardObservationRepository {
  load(job: TurnSummaryCompleteJob): Promise<{ job: CardObservationJob; input: ObservationInput } | null>;
  claim(job: CardObservationJob, input: ObservationInput): Promise<boolean>;
  append(job: CardObservationJob, input: ObservationInput, outcome: ObservationOutcome): Promise<{ eventId: number; payload: Record<string, unknown> }>;
}
export class JevCardObservationPipeline {
  private readonly inflight = new Map<string, Promise<void>>();
  constructor(private readonly deps: {
    repository: CardObservationRepository; apiKey: string | null;
    publish(job: CardObservationJob, eventId: number, payload: Record<string, unknown>): void;
    log(fields: Record<string, unknown>): void;
    evaluate?: typeof evaluateCardObservation;
  }) {}
  /** Background observer: returns immediately; its output is not fed back into node sinks. */
  accept(events: readonly NodeRegistryEvent[]) {
    for (const complete of collectTurnSummaryCompleteJobs(events)) {
      const key = `${complete.sessionId}:${complete.completeEventId}`;
      if (this.inflight.has(key)) continue;
      const task = this.process(complete).catch(() => {
        this.deps.log({ sessionId: complete.sessionId, completeEventId: complete.completeEventId, status: 'not_evaluated', reason: 'storage_error' });
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
    }
  }
  async drain() { await Promise.all(this.inflight.values()); }
  private async process(complete: TurnSummaryCompleteJob) {
    const loaded = await this.deps.repository.load(complete);
    if (!loaded || loaded.input.cards.length === 0) return;
    const { job, input } = loaded;
    if (!await this.deps.repository.claim(job, input)) return;
    const outcome = await (this.deps.evaluate ?? evaluateCardObservation)(input, this.deps.apiKey);
    const saved = await this.deps.repository.append(job, input, outcome);
    this.deps.publish(job, saved.eventId, saved.payload);
    this.deps.log({ sessionId: job.sessionId, completeEventId: job.completeEventId, status: outcome.status,
      reason: outcome.reason, calls: outcome.calls, latencyMs: outcome.latencyMs, inputBytes: outcome.inputBytes,
      model: outcome.model, usage: outcome.usage, scope: input.scope });
  }
}
