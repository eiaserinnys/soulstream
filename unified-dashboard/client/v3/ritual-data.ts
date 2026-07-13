import type { SessionSummary } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import {
  listAllPages,
  loadDailyPlanner,
  type PlannerDataDependencies,
} from "./planner-data";
import {
  buildMorningRitualQueue,
  selectHistoricalDailyDates,
  type RitualQueueItem,
} from "./ritual-model";

export interface MorningRitualData {
  dailyPageId: string;
  items: RitualQueueItem[];
}

export async function loadMorningRitualData(input: {
  api: PageApiClient;
  today: string;
  sessions: readonly SessionSummary[];
  plannerDependencies: PlannerDataDependencies;
}): Promise<MorningRitualData> {
  const pages = await listAllPages(input.api);
  const historicalDates = selectHistoricalDailyDates(pages, input.today);
  const [todayPlanner, ...historicalPlanners] = await Promise.all([
    loadDailyPlanner(input.api, input.today, input.plannerDependencies),
    ...historicalDates.map((date) => (
      loadDailyPlanner(input.api, date, input.plannerDependencies)
    )),
  ]);

  return {
    dailyPageId: todayPlanner.daily.page.id,
    items: buildMorningRitualQueue({
      historicalDays: historicalDates.map((date, index) => ({
        date,
        tasks: historicalPlanners[index]?.tasks ?? [],
      })),
      todayTaskPageIds: new Set(todayPlanner.tasks.map((task) => task.page.id)),
      sessions: input.sessions,
    }),
  };
}
