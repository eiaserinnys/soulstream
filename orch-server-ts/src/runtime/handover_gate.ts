import { AsyncLocalStorage } from "node:async_hooks";

/** Admission and in-flight accounting for operations that cannot cross a lease handover. */
export class HandoverGate {
  private state: "waiting" | "open" | "closed" = "waiting";
  private readyResolve!: () => void;
  private readonly ready = new Promise<void>(resolve => { this.readyResolve = resolve; });
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private running = 0;
  private drained: Array<() => void> = [];

  open(): void { this.state = "open"; this.readyResolve(); }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return await work();
    await this.ready;
    if (this.state !== "open") throw Object.assign(new Error("Handover in progress; retry"), { statusCode: 503, code: "HANDOVER_RETRY" });
    this.running++;
    const scope = { active: true };
    try { return await this.context.run(scope, work); }
    finally {
      scope.active = false;
      if (--this.running === 0) this.drained.splice(0).forEach(resolve => resolve());
    }
  }
  async close(): Promise<void> {
    this.state = "closed";
    this.readyResolve();
    if (this.running) await new Promise<void>(resolve => this.drained.push(resolve));
  }
}

export function guardMethods<T extends object>(target: T, gate: HandoverGate, methods: readonly string[]): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      if (typeof key !== "string" || !methods.includes(key)) return value.bind(object);
      return (...args: unknown[]) => gate.run(async () => await value.apply(object, args));
    },
  });
}
