// soul-app directly imports this source file, so keep it free of imports.
// Avoid destructuring, spread, and other syntax that can inject Babel runtime helpers.
export type TurnUsageSourceEvent<T> = { id: string | number; type: string; data: T };

export type TurnUsagePair<T> = {
  terminalId: string | number;
  terminalType: "complete" | "error";
  contextUsage: T | null;
  complete: T | null;
};

export function pairTurnUsage<T>(events: readonly TurnUsageSourceEvent<T>[]): TurnUsagePair<T>[] {
  const pairs: TurnUsagePair<T>[] = [];
  let hasPendingContext = false;
  let pendingContextUsage: T | null = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "context_usage") {
      pendingContextUsage = event.data;
      hasPendingContext = true;
      continue;
    }

    if (
      event.type === "user_message"
      || event.type === "intervention_sent"
      || event.type === "generation_started"
    ) {
      pendingContextUsage = null;
      hasPendingContext = false;
      continue;
    }

    if (event.type === "complete") {
      pairs.push({
        terminalId: event.id,
        terminalType: "complete",
        contextUsage: hasPendingContext ? pendingContextUsage : null,
        complete: event.data,
      });
      pendingContextUsage = null;
      hasPendingContext = false;
      continue;
    }

    if (event.type === "error") {
      if (hasPendingContext) {
        pairs.push({
          terminalId: event.id,
          terminalType: "error",
          contextUsage: pendingContextUsage,
          complete: null,
        });
      }
      pendingContextUsage = null;
      hasPendingContext = false;
    }
  }

  return pairs;
}
