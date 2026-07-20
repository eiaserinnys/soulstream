import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import {
  loadDailyHistoryDates,
  loadDailyPlanner,
  type PlannerDataDependencies,
} from "./planner-data";
import {
  buildMorningRitualQueue,
  type RitualQueueItem,
} from "./ritual-model";

export interface MorningRitualData {
  dailyPageId: string;
  items: RitualQueueItem[];
}

export async function loadMorningRitualData(input: {
  api: PageApiClient;
  today: string;
  plannerDependencies: PlannerDataDependencies;
}): Promise<MorningRitualData> {
  const historicalDates = await loadDailyHistoryDates(
    input.plannerDependencies,
    input.today,
    2,
  );
  const [todayPlanner, ...historicalPlanners] = await Promise.all([
    loadDailyPlanner(input.api, input.today, input.plannerDependencies),
    ...historicalDates.map((date) => (
      loadDailyPlanner(input.api, date, input.plannerDependencies)
    )),
  ]);

  return {
    dailyPageId: todayPlanner.daily.page.id,
    items: buildMorningRitualQueue({
      historicalDays: historicalPlanners.map((planner, index) => ({
        date: historicalDates[index]!,
        pageId: planner.daily.page.id,
        tasks: planner.tasks,
      })),
      todayTaskPageIds: new Set(todayPlanner.tasks.map((task) => task.page.id)),
    }),
  };
}
