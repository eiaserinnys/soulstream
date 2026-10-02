/** Stands in for the HTTP request once a transport has already verified the orchestrator service credential. */
export const SERVICE_CALLER = Object.freeze({ kind: "service_caller" as const });
export type ServiceCaller = typeof SERVICE_CALLER;

export function isServiceCaller(value: unknown): value is ServiceCaller {
  return value === SERVICE_CALLER;
}
