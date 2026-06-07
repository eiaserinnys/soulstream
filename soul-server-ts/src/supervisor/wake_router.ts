import { classifyWakeEvent, type WakeClass } from "./wake_classification.js";

export interface SupervisorWakeEvent {
  offset: number;
  sourceSessionId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface SupervisorWakeRouterDeps {
  getCursor(supervisorId: string): Promise<number>;
  readEventsAfter(afterOffset: number, limit: number): Promise<SupervisorWakeEvent[]>;
  setCursor(supervisorId: string, cursorOffset: number): Promise<void>;
  wake(params: {
    supervisorId: string;
    events: SupervisorWakeEvent[];
    wakeClass: Exclude<WakeClass, "quiet">;
  }): Promise<void>;
  logger?: {
    warn(payload: unknown, message: string): void;
  };
}

export interface SupervisorWakeRouterOptions {
  batchLimit?: number;
}

export interface SupervisorWakeSchedulerRegistry {
  role: string;
  activeSessionId: string | null;
}

export interface SupervisorWakeSchedulerDeps {
  listSupervisors(): Promise<SupervisorWakeSchedulerRegistry[]>;
  router: Pick<SupervisorWakeRouter, "ingest" | "flush">;
  logger: {
    warn(payload: unknown, message: string): void;
  };
}

export interface SupervisorWakeSchedulerOptions {
  debounceMs?: number;
}

export class SupervisorWakeRouter {
  private readonly batchLimit: number;
  private readonly warnedUnknownEventTypes = new Set<string>();
  private readonly warnedClassificationFailures = new Set<string>();

  constructor(
    private readonly deps: SupervisorWakeRouterDeps,
    options: SupervisorWakeRouterOptions = {},
  ) {
    this.batchLimit = options.batchLimit ?? 100;
  }

  async ingest(supervisorId: string, eventType: string): Promise<{ scheduled: boolean }> {
    const wakeClass = this.classifyEvent(supervisorId, eventType);
    return { scheduled: wakeClass !== null && wakeClass !== "quiet" };
  }

  async flush(
    supervisorId: string,
    activeSessionId?: string | null,
  ): Promise<{ woken: boolean; drained: number }> {
    const cursor = await this.deps.getCursor(supervisorId);
    const events = await this.deps.readEventsAfter(cursor, this.batchLimit);
    if (events.length === 0) return { woken: false, drained: 0 };

    const head = events[events.length - 1]?.offset ?? cursor;

    const wakeEvents = activeSessionId
      ? events.filter((event) => event.sourceSessionId !== activeSessionId)
      : events;
    if (wakeEvents.length === 0) {
      await this.deps.setCursor(supervisorId, head);
      return { woken: false, drained: events.length };
    }

    const classifiedWakeEvents = wakeEvents
      .map((event) => ({
        event,
        wakeClass: this.classifyEvent(supervisorId, event.eventType, event.offset),
      }))
      .filter((entry): entry is { event: SupervisorWakeEvent; wakeClass: WakeClass } =>
        entry.wakeClass !== null
      );

    const wakeClass = strongestWakeClass(
      classifiedWakeEvents.map((entry) => entry.wakeClass),
    );
    if (wakeClass === "quiet") {
      await this.deps.setCursor(supervisorId, head);
      return { woken: false, drained: events.length };
    }
    await this.deps.wake({
      supervisorId,
      events: classifiedWakeEvents.map((entry) => entry.event),
      wakeClass,
    });
    await this.deps.setCursor(supervisorId, head);
    return { woken: true, drained: events.length };
  }

  private classifyEvent(
    supervisorId: string,
    eventType: string,
    offset?: number,
  ): WakeClass | null {
    try {
      const wakeClass = classifyWakeEvent(eventType);
      if (wakeClass) return wakeClass;
      this.warnUnmappedEventType(supervisorId, eventType, offset);
      return null;
    } catch (err) {
      this.warnClassificationFailure(supervisorId, eventType, offset, err);
      return null;
    }
  }

  private warnUnmappedEventType(
    supervisorId: string,
    eventType: string,
    offset?: number,
  ): void {
    if (this.warnedUnknownEventTypes.has(eventType)) return;
    this.warnedUnknownEventTypes.add(eventType);
    this.deps.logger?.warn(
      {
        supervisorId,
        eventType,
        ...(offset !== undefined ? { offset } : {}),
      },
      "Supervisor wake router skipped unmapped SSE event type",
    );
  }

  private warnClassificationFailure(
    supervisorId: string,
    eventType: string,
    offset: number | undefined,
    err: unknown,
  ): void {
    if (this.warnedClassificationFailures.has(eventType)) return;
    this.warnedClassificationFailures.add(eventType);
    this.deps.logger?.warn(
      {
        err,
        supervisorId,
        eventType,
        ...(offset !== undefined ? { offset } : {}),
      },
      "Supervisor wake router skipped event classification failure",
    );
  }
}

export class SupervisorWakeScheduler {
  private readonly debounceMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: SupervisorWakeSchedulerDeps,
    options: SupervisorWakeSchedulerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 250;
  }

  async ingest(eventType: string): Promise<{ scheduled: boolean }> {
    let scheduled = false;
    const supervisors = await this.deps.listSupervisors();
    for (const supervisor of supervisors) {
      if (!supervisor.activeSessionId) continue;
      const decision = await this.deps.router.ingest(supervisor.role, eventType);
      if (!decision.scheduled) continue;
      scheduled = true;
      this.schedule(supervisor.role);
    }
    return { scheduled };
  }

  async flush(supervisorId: string): Promise<void> {
    const timer = this.timers.get(supervisorId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(supervisorId);
    }
    const activeSessionId = await this.resolveActiveSessionId(supervisorId);
    await this.deps.router.flush(supervisorId, activeSessionId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(supervisorId: string): void {
    if (this.timers.has(supervisorId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(supervisorId);
      void this.flush(supervisorId).catch((err) => {
        this.deps.logger.warn(
          { err, supervisorId },
          "Supervisor wake router flush failed",
        );
      });
    }, this.debounceMs);
    this.timers.set(supervisorId, timer);
  }

  private async resolveActiveSessionId(supervisorId: string): Promise<string | null> {
    const supervisors = await this.deps.listSupervisors();
    return supervisors.find((supervisor) => supervisor.role === supervisorId)
      ?.activeSessionId ?? null;
  }
}

function strongestWakeClass(classes: WakeClass[]): WakeClass {
  if (classes.includes("critical")) return "critical";
  if (classes.includes("wake")) return "wake";
  if (classes.includes("batch")) return "batch";
  return "quiet";
}
