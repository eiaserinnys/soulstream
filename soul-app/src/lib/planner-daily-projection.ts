import type { PlannerBlock, PlannerPage } from '../api/plannerTypes';
import type { PlannerProjectionState } from './planner-mutation-projection';

export function patchDailyMemoProjection(
  state: PlannerProjectionState,
  date: string,
  blockId: string | null,
  text: string,
): PlannerProjectionState {
  const daily = state.dailyByDate[date];
  if (!daily) return state;
  let memoBlocks: PlannerBlock[];
  if (blockId) {
    let changed = false;
    memoBlocks = daily.memoBlocks.map((block) => {
      if (block.id !== blockId || block.text === text) return block;
      changed = true;
      return { ...block, text };
    });
    if (!changed) return state;
  } else if (text.trim()) {
    memoBlocks = [...daily.memoBlocks, {
      id: `pending-memo-${date}`,
      pageId: daily.daily.page.id,
      parentId: null,
      positionKey: '',
      blockType: 'paragraph',
      text,
      properties: {},
      collapsed: false,
    }];
  } else {
    return state;
  }
  return {
    ...state,
    dailyByDate: { ...state.dailyByDate, [date]: { ...daily, memoBlocks } },
  };
}

export function mergeDailyPageProjection(
  state: PlannerProjectionState,
  date: string,
  page: PlannerPage,
  blocks: PlannerBlock[],
): PlannerProjectionState {
  const daily = state.dailyByDate[date];
  if (!daily) return state;
  const memoBlocks = blocks.filter((block) => !/^\[\[[^\]]+\]\]$/.test(block.text.trim()));
  return {
    ...state,
    dailyByDate: {
      ...state.dailyByDate,
      [date]: {
        ...daily,
        daily: { ...daily.daily, page },
        memoBlocks,
      },
    },
  };
}
