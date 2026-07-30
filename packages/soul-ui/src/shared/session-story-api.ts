import { z } from "zod";

const turnSummarySchema = z.object({
  event_id: z.number().int().positive(),
  turn_number: z.number().int().positive(),
  content: z.string().min(1),
  turn_start_event_id: z.number().int().positive().nullable(),
  final_response_event_id: z.number().int().positive().nullable(),
  created_at: z.string().min(1),
}).strict();

const sessionStorySchema = z.object({
  highlight: z.string().nullable(),
  narrative: z.string().nullable(),
  unfolded_turn_summaries: z.array(turnSummarySchema),
  narrative_through_event_id: z.number().int().positive().nullable(),
  fold_count: z.number().int().nonnegative(),
  updated_at: z.string().nullable(),
}).strict();

export type SessionStory = z.infer<typeof sessionStorySchema>;

export async function fetchSessionStory(
  sessionId: string,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<SessionStory> {
  const response = await fetcher(
    `/api/sessions/${encodeURIComponent(sessionId)}/story`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`session story request failed: ${response.status}`);
  }
  return sessionStorySchema.parse(await response.json());
}
