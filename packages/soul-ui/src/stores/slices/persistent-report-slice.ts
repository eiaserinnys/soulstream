import type { StateCreator } from 'zustand';
import type { DashboardActions, DashboardState } from '../dashboard-store-types';

type Slice = Pick<DashboardState, 'persistentReports'> & Pick<DashboardActions, 'setPersistentReport'>;
/** Server report projection. A delayed REST/DELETE response may only replace its own baseline. */
export const createPersistentReportSlice: StateCreator<DashboardState & DashboardActions, [], [], Slice> = set => ({
  persistentReports: {},
  setPersistentReport: (sessionId, entries, expected) => set(state => {
    const current = state.persistentReports[sessionId];
    if ((expected && current !== expected.current) || current === entries) return state;
    return { persistentReports: { ...state.persistentReports, [sessionId]: entries } };
  }),
});
