export type CardProgressTurn = {
  sessionId: string;
  eventId: number;
  startedAt: string;
  at: string;
  text: string;
  callerInfo: Record<string, unknown>;
};

export type CardProgressMilestone = {
  id: string;
  at: string;
  text: unknown;
  ask: unknown;
  turn: unknown;
};

export type CardProgressRecord = { sessionId: string; at: string };

export function projectCardProgress(input: {
  cardId: string;
  sessionIds: string[];
  turns: readonly CardProgressTurn[];
  milestones: readonly CardProgressMilestone[];
  recorded: readonly CardProgressRecord[];
}) {
  const milestones = [...input.milestones].sort((a, b) => a.at.localeCompare(b.at));
  const turns = [...input.turns].sort((a, b) =>
    a.at.localeCompare(b.at) || a.sessionId.localeCompare(b.sessionId) || a.eventId - b.eventId);
  const bundles: Array<{
    milestone: CardProgressMilestone | null;
    entries: Array<Omit<CardProgressTurn, "callerInfo"> & { truncated: boolean }>;
  }> = [];
  let milestoneIndex = -1;
  for (const turn of turns) {
    const trimmed = turn.text.trim();
    if (trimmed.startsWith("[SILENT]") || ["네", "네.", "넵", "넵."].includes(trimmed)) continue;
    if (turn.callerInfo.source === "system" && turn.callerInfo.card_launch !== true) continue;
    if (input.recorded.some(record => record.sessionId === turn.sessionId && record.at >= turn.startedAt && record.at <= turn.at)) continue;
    while (milestoneIndex + 1 < milestones.length && milestones[milestoneIndex + 1]!.at <= turn.at) milestoneIndex++;
    const milestone = milestones[milestoneIndex] ?? null;
    let bundle = bundles.at(-1);
    if (!bundle || bundle.milestone !== milestone) {
      bundle = { milestone, entries: [] };
      bundles.push(bundle);
    }
    const characters = [...turn.text];
    bundle.entries.push({
      sessionId: turn.sessionId, eventId: turn.eventId, startedAt: turn.startedAt, at: turn.at,
      text: characters.slice(0, 4000).join(""), truncated: characters.length > 4000,
    });
  }
  return { cardId: input.cardId, sessionIds: input.sessionIds, bundles };
}
