import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import type { PersistentSessionResource } from '../../api/persistentSessionEndpoints';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import {
  SettingsFormGroup as Group,
  SettingsAction as Action,
  SettingsInput as Input,
  SettingsNotice as Notice,
  SettingsReadOnlyField as ReadOnlyField,
  SettingsToggleRow,
  useSettingsFormStyles,
} from './SettingsFormParts';
import { SettingsOptionRow as OptionRow } from './SettingsOptionRow';
import { SettingsSection } from './SettingsSection';
import { useTokens } from '../../theme';

export type PersistentSessionDisplayField =
  | 'show_character'
  | 'animate_character'
  | 'show_generation_separator'
  | 'show_jev_candidates'
  | 'show_turn_usage';

export type PersistentSessionDisplayValues = Record<PersistentSessionDisplayField, boolean>;
export type PersistentSessionEditorSection = 'all' | 'account-model' | 'display';

export function persistentSessionDisplayValues(session: PersistentSessionResource): PersistentSessionDisplayValues {
  return {
    show_character: session.settings.show_character !== false,
    animate_character: session.settings.animate_character !== false,
    show_generation_separator: session.settings.show_generation_separator === true,
    show_jev_candidates: session.settings.show_jev_candidates === true,
    show_turn_usage: session.settings.show_turn_usage !== false,
  };
}

export function persistentSessionRuntimeLabels(session: PersistentSessionResource, presets: ModelPresetAvailability[]) {
  const presetLabel = (id: string | null) => id ? presets.find((item) => item.id === id)?.label ?? id : '모델 정보 없음';
  const current = session.runtime.current_model;
  const pending = session.runtime.pending;
  return {
    currentModel: [current.model_preset ? presetLabel(current.model_preset) : null, current.model].filter(Boolean).join(' · ') || '모델 정보 없음',
    pending: pending ? `다음 실행부터 ${presetLabel(pending.target_model_preset)}` : '대기 중인 변경 없음',
  };
}

export function PersistentSessionRuntimeFields({ session, presets, needsResave = false }: {
  session: PersistentSessionResource;
  presets: ModelPresetAvailability[];
  needsResave?: boolean;
}) {
  const runtime = persistentSessionRuntimeLabels(session, presets);
  return <Group title="현재 정보">
    <ReadOnlyField label="현재 실행 모델" value={runtime.currentModel} />
    <ReadOnlyField label="대기 중인 변경" value={runtime.pending} />
    {needsResave ? <Notice text="기본 모델 변경 요청이 없습니다. 다시 저장해 주세요." /> : null}
  </Group>;
}

export function PersistentSessionSettingsFields({
  section,
  session,
  name,
  onNameChange,
  modelPreset,
  onModelChange,
  presets,
  display,
  displaySaving,
  displayStatus,
  onDisplayChange,
  loadingTargets,
  targetsError,
  onRetryTargets,
  modelError,
  defaultsNotice,
  nodeMissing,
  needsResave,
}: {
  section: PersistentSessionEditorSection;
  session: PersistentSessionResource;
  name: string;
  onNameChange(value: string): void;
  modelPreset: string;
  onModelChange(value: string): void;
  presets: ModelPresetAvailability[];
  display: PersistentSessionDisplayValues;
  displaySaving: boolean;
  displayStatus: 'saving' | 'error' | null;
  onDisplayChange(field: PersistentSessionDisplayField, value: boolean): void;
  loadingTargets: boolean;
  targetsError: string | null;
  onRetryTargets(): void;
  modelError: string | null;
  defaultsNotice: string | null;
  nodeMissing: boolean;
  needsResave: boolean;
}) {
  const styles = useSettingsFormStyles();
  const t = useTokens();
  const accountFields = <>
    <Input label="세션 이름" value={name} onChangeText={onNameChange} />
    <ReadOnlyField label="프로필" value={session.agent_name ?? session.agent_id ?? '프로필 정보 없음'} />
    {nodeMissing ? <Text accessibilityRole="alert" style={styles.error}>이 세션의 노드를 알 수 없어 편집할 수 없습니다.</Text> : null}
    {loadingTargets ? <ActivityIndicator color={t.colors.accent} /> : null}
    {targetsError ? <View><Text accessibilityRole="alert" style={styles.error}>{targetsError}</Text><Action label="다시 시도" onPress={onRetryTargets} testID="persistent-targets-retry" /></View> : null}
    {defaultsNotice ? <Notice text={defaultsNotice} /> : null}
    <Text style={styles.label}>기본 모델</Text>
    <OptionRow label="기본 모델" selected={modelPreset} options={presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      available: preset.available,
      reason: preset.reason_label,
    }))} onSelect={onModelChange} emptyLabel="선택 가능한 모델이 없습니다." />
    {modelError ? <Text accessibilityRole="alert" style={styles.error}>{modelError}</Text> : null}
    {!modelPreset && !loadingTargets ? <Notice text="기본 모델을 선택해야 저장할 수 있습니다." /> : null}
  </>;
  const displayFields = <>
    <SettingsToggleRow
      label="캐릭터 표시"
      value={display.show_character}
      disabled={displaySaving}
      testID="persistent-show-character"
      onValueChange={(value) => onDisplayChange('show_character', value)}
    />
    <SettingsToggleRow
      label="캐릭터 움직임"
      value={display.animate_character}
      disabled={displaySaving}
      testID="persistent-animate-character"
      onValueChange={(value) => onDisplayChange('animate_character', value)}
    />
    <SettingsToggleRow
      label="세대 구분선 표시"
      value={display.show_generation_separator}
      disabled={displaySaving}
      testID="persistent-show-generation-separator"
      help="세대가 바뀐 자리에 구분선을 보여 줍니다. 끄면 화면에서만 숨기고 기록은 남습니다."
      onValueChange={(value) => onDisplayChange('show_generation_separator', value)}
    />
    <SettingsToggleRow
      label="Jev 후보 표시"
      value={display.show_jev_candidates}
      disabled={displaySaving}
      testID="persistent-show-jev-candidates"
      help="내 입력 아래에 Jev가 찾은 후보를 접힌 줄로 보여 줍니다. 끄면 화면에서만 숨기고 기록은 남습니다."
      onValueChange={(value) => onDisplayChange('show_jev_candidates', value)}
    />
    <SettingsToggleRow
      label="턴 끝 사용량 표시"
      value={display.show_turn_usage}
      disabled={displaySaving}
      testID="persistent-show-turn-usage"
      onValueChange={(value) => onDisplayChange('show_turn_usage', value)}
    />
  </>;

  if (section === 'account-model') {
    return <SettingsSection id="persistent-editor-groups" title="" flattened>
      <Group>{accountFields}</Group>
      <PersistentSessionRuntimeFields session={session} presets={presets} needsResave={needsResave} />
    </SettingsSection>;
  }
  if (section === 'display') {
    return <SettingsSection id="persistent-editor-groups" title="" flattened>{session.persistent ? <Group>
      {displayFields}
      {displayStatus === 'error' ? <Text accessibilityRole="alert" style={styles.error}>저장 실패. 다시 눌러 주세요.</Text> : null}
    </Group> : null}</SettingsSection>;
  }
  return <SettingsSection id="persistent-editor-groups" title="" flattened>
    <Group title="세션 설정">{accountFields}</Group>
    {session.persistent ? <Group title="채팅 표시">{displayFields}</Group> : null}
    <PersistentSessionRuntimeFields session={session} presets={presets} needsResave={needsResave} />
  </SettingsSection>;
}
