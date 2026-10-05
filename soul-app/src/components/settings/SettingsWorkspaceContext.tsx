import React, { createContext, useContext, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import type { SettingsCategory } from './settingsCategories';

export interface SettingsSaveScope {
  dirty: boolean;
  busy?: boolean;
  canSave?: boolean;
  saveLabel?: string;
  saveTestID?: string;
  save(): void | Promise<void>;
  discard(): void;
}
export type SettingsJobDestination = { kind: 'list' } | { kind: 'editor'; jobId?: string } | { kind: 'history'; jobId: string };
export type SettingsPersistentDestination = { kind: 'list' } | { kind: 'editor'; sessionId?: string };
export interface SettingsWorkspaceState {
  category: SettingsCategory | null;
  wide: boolean;
  columns: boolean;
  jobs: SettingsJobDestination;
  setJobs(value: SettingsJobDestination): void;
  persistent: SettingsPersistentDestination;
  setPersistent(value: SettingsPersistentDestination): void;
  register(id: SettingsCategory, scope: SettingsSaveScope | null): void;
  changeConnection(action: () => void): void;
  select(id: SettingsCategory): void;
  guard(id: SettingsCategory, action: () => void): void;
}
export const SettingsWorkspaceContext = createContext<SettingsWorkspaceState | null>(null);
export const useSettingsWorkspace = () => useContext(SettingsWorkspaceContext);

/** Only dirty/save ownership crosses the shell boundary; each form keeps its controller. */
export function useSettingsSaveScope(id: SettingsCategory, scope: SettingsSaveScope) {
  const workspace = useSettingsWorkspace();
  const latest = useRef(scope);
  latest.current = scope;
  const register = workspace?.register;
  useEffect(() => {
    if (!register) return;
    register(id, { ...latest.current, save: () => latest.current.save(), discard: () => latest.current.discard() });
    return () => register(id, null);
  }, [register, id, scope.dirty, scope.busy, scope.canSave, scope.saveLabel, scope.saveTestID]);
  return workspace;
}

export function confirmSettingsDiscard(action: () => void, onSaveScreen?: () => void) {
  Alert.alert('저장하지 않은 변경', '입력을 버리거나 저장할 화면으로 돌아갈 수 있습니다.', [
    { text: '계속 편집', style: 'cancel' },
    ...(onSaveScreen ? [{ text: '저장할 화면으로', onPress: onSaveScreen }] : []),
    { text: '버리기', style: 'destructive', onPress: action },
  ]);
}
