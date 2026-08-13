import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";
import type { TaskManager } from "../task/task_manager.js";
import type { Task } from "../task/task_models.js";
import type {
  RunnerRecoveryDisposition,
  RunnerRegistration,
} from "./runner_process_registry.js";

export const RUNNER_RECOVERY_HYDRATION_DEADLINE_MS = 10_000;
export const RUNNER_RECOVERY_HYDRATION_CONCURRENCY = 4;

export type RunnerRecoveryHydrationCandidate = {
  registration: RunnerRegistration;
  disposition: RunnerRecoveryDisposition;
};

export type RunnerRecoveryHydrationOutcome = RunnerRecoveryHydrationCandidate & (
  | { status: "ready"; task: Task }
  | { status: "missing" }
  | { status: "failed"; error: unknown; retryable: boolean }
  | { status: "deferred"; error: RunnerRecoveryHydrationDeadlineError }
);

type HydrationResult =
  | { status: "ready"; task: Task }
  | { status: "missing" }
  | { status: "failed"; error: unknown; retryable: boolean };

type HydrationJob = {
  promise: Promise<HydrationResult>;
  result?: HydrationResult;
};

export class RunnerRecoveryHydrationDeadlineError extends Error {
  readonly code = "runner_recovery_hydration_deadline";

  constructor(readonly sessionId: string, readonly deadlineMs: number) {
    super(`Runner recovery hydration exceeded ${deadlineMs}ms: ${sessionId}`);
    this.name = "RunnerRecoveryHydrationDeadlineError";
  }
}

export class RunnerRecoveryHydrationPhase {
  private readonly jobs = new Map<string, HydrationJob>();
  private readonly deadlineMs: number;
  private readonly concurrency: number;

  constructor(private readonly options: {
    hydrate: Pick<TaskManager, "hydrateRunnerRecoveryTask">["hydrateRunnerRecoveryTask"];
    deadlineMs?: number;
    concurrency?: number;
  }) {
    this.deadlineMs = options.deadlineMs ?? RUNNER_RECOVERY_HYDRATION_DEADLINE_MS;
    this.concurrency = options.concurrency ?? RUNNER_RECOVERY_HYDRATION_CONCURRENCY;
    requirePositiveInteger(this.deadlineMs, "runner recovery hydration deadline");
    requirePositiveInteger(this.concurrency, "runner recovery hydration concurrency");
  }

  async run(
    candidates: RunnerRecoveryHydrationCandidate[],
  ): Promise<RunnerRecoveryHydrationOutcome[]> {
    if (candidates.length === 0) return [];
    const candidateIds = new Set(
      candidates.map(({ registration }) => registration.config.sessionId),
    );
    for (const sessionId of this.jobs.keys()) {
      if (!candidateIds.has(sessionId)) this.jobs.delete(sessionId);
    }

    const queue = candidates.filter(({ registration }) =>
      !this.jobs.has(registration.config.sessionId));
    let activeCount = 0;
    let phaseOpen = true;
    let finishPhase!: () => void;
    const phaseFinished = new Promise<void>((resolve) => { finishPhase = resolve; });
    const observed = new Set<HydrationJob>();

    const maybeFinish = () => {
      if (queue.length === 0 && activeCount === 0) finishPhase();
    };
    const observe = (job: HydrationJob) => {
      if (job.result || observed.has(job)) return;
      observed.add(job);
      activeCount += 1;
      void job.promise.then(() => {
        activeCount -= 1;
        if (phaseOpen) startQueued();
        maybeFinish();
      });
    };
    const startQueued = () => {
      while (phaseOpen && activeCount < this.concurrency && queue.length > 0) {
        const candidate = queue.shift()!;
        const sessionId = candidate.registration.config.sessionId;
        const job = this.startJob(sessionId);
        this.jobs.set(sessionId, job);
        observe(job);
      }
      maybeFinish();
    };

    for (const candidate of candidates) {
      const existing = this.jobs.get(candidate.registration.config.sessionId);
      if (existing) observe(existing);
    }
    startQueued();

    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineHandle = setTimeout(resolve, this.deadlineMs);
    });
    await Promise.race([phaseFinished, deadline]);
    phaseOpen = false;
    if (deadlineHandle) clearTimeout(deadlineHandle);

    return candidates.map((candidate) => {
      const sessionId = candidate.registration.config.sessionId;
      const job = this.jobs.get(sessionId);
      if (!job?.result) {
        return {
          ...candidate,
          status: "deferred" as const,
          error: new RunnerRecoveryHydrationDeadlineError(sessionId, this.deadlineMs),
        };
      }
      this.jobs.delete(sessionId);
      return { ...candidate, ...job.result };
    });
  }

  private startJob(sessionId: string): HydrationJob {
    const job: HydrationJob = {
      promise: Promise.resolve()
        .then(async () => await this.options.hydrate(sessionId))
        .then(
          (task): HydrationResult => task
            ? { status: "ready", task }
            : { status: "missing" },
          (error): HydrationResult => ({
            status: "failed",
            error,
            retryable: isRetryableHydrationFailure(error),
          }),
        ),
    };
    void job.promise.then((result) => { job.result = result; });
    return job;
  }
}

function isRetryableHydrationFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (isSessionDataHostError(current)) return current.retryable;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
