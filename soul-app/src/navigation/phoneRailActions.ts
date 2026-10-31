import { useCallback, useLayoutEffect, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { create } from 'zustand';
import type { ComponentProps } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';

export type PhoneRailAction = {
  id: string;
  label: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  onPress(): void;
  selected?: boolean;
  badgeCount?: number;
  dot?: boolean;
  disabled?: boolean;
};

type RootActionTab = 'DailyTab' | 'FolderTab' | 'FeedTab';
type RailOverrideMode = 'replace' | 'prepend';
type RailOverride = { key: symbol; actions: PhoneRailAction[]; mode: RailOverrideMode };
type RailState = {
  actions: Partial<Record<RootActionTab, PhoneRailAction[]>>;
  setActions(tab: RootActionTab, actions: PhoneRailAction[] | undefined): void;
  overrides: RailOverride[];
  pushOverride(key: symbol, actions: PhoneRailAction[], mode?: RailOverrideMode): void;
  updateOverride(key: symbol, actions: PhoneRailAction[], mode?: RailOverrideMode): void;
  removeOverride(key: symbol): void;
};

export const usePhoneRailActions = create<RailState>((set) => ({
  actions: {},
  setActions: (tab, actions) => set((state) => ({ actions: { ...state.actions, [tab]: actions } })),
  overrides: [],
  pushOverride: (key, actions, mode = 'replace') => set(state => ({ overrides: [...state.overrides, { key, actions, mode }] })),
  updateOverride: (key, actions, mode = 'replace') => set(state => ({ overrides: state.overrides.map(entry => entry.key === key ? { key, actions, mode } : entry) })),
  removeOverride: key => set(state => ({ overrides: state.overrides.filter(entry => entry.key !== key) })),
}));

export function useRegisterDuoRailOverride(id: string, enabled: boolean, actions: PhoneRailAction[], mode: RailOverrideMode = 'replace') {
  const key = useRef(Symbol(id)).current;
  const latest = useRef(actions);
  latest.current = actions;
  const signature = JSON.stringify(actions.map(({ id: actionId, label, icon, selected, badgeCount, dot, disabled }) =>
    [actionId, label, icon, selected, badgeCount, dot, disabled]));
  const stableActions = () => latest.current.map(action => ({ ...action,
    onPress: () => latest.current.find(current => current.id === action.id)?.onPress(),
  }));
  useLayoutEffect(() => {
    if (!enabled) return;
    usePhoneRailActions.getState().pushOverride(key, stableActions(), mode);
    return () => usePhoneRailActions.getState().removeOverride(key);
  }, [enabled, key]);
  useLayoutEffect(() => {
    if (enabled) usePhoneRailActions.getState().updateOverride(key, stableActions(), mode);
  }, [enabled, key, mode, signature]);
}

export function useActiveDuoRailOverrideEntry(): RailOverride | null {
  return usePhoneRailActions(state => state.overrides.at(-1) ?? null);
}

export function useActiveDuoRailOverride(): PhoneRailAction[] | null {
  return usePhoneRailActions(state => state.overrides.at(-1)?.actions ?? null);
}

export function useRegisterPhoneRailActions(tab: RootActionTab, enabled: boolean, actions: PhoneRailAction[]) {
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    usePhoneRailActions.getState().setActions(tab, actions);
    return () => usePhoneRailActions.getState().setActions(tab, undefined);
  }, [tab, enabled, actions]));
}
