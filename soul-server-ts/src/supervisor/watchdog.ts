export interface SupervisorWatchdogRegistry {
  role: string;
  activeSessionId: string | null;
  lastSeenAt: Date | null;
}

export interface SupervisorWatchdogAlert {
  role: string;
  activeSessionId: string;
  missingForMs: number;
  lastSeenAt: Date | null;
}

export function detectMissingSupervisors(
  registries: SupervisorWatchdogRegistry[],
  now: Date,
  missingThresholdMs: number,
): SupervisorWatchdogAlert[] {
  return registries.flatMap((registry) => {
    if (!registry.activeSessionId) return [];
    const missingForMs = registry.lastSeenAt
      ? now.getTime() - registry.lastSeenAt.getTime()
      : missingThresholdMs;
    if (missingForMs < missingThresholdMs) return [];
    return [{
      role: registry.role,
      activeSessionId: registry.activeSessionId,
      missingForMs,
      lastSeenAt: registry.lastSeenAt,
    }];
  });
}
