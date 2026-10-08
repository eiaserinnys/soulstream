import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import type {
  PersistentSessionInstruction,
  PersistentSessionResource,
  PersistentTurnUsageMode,
} from '../../api/persistentSessionEndpoints';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import {
  SettingsFormGroup as Group,
  SettingsAction as Action,
  SettingsInput as Input,
  SettingsListRow,
  SettingsNotice as Notice,
  SettingsReadOnlyField as ReadOnlyField,
  SettingsToggleRow,
  useSettingsFormStyles,
} from './SettingsFormParts';
import { SettingsOptionRow as OptionRow } from './SettingsOptionRow';
import { SettingsSection } from './SettingsSection';
import { SettingsSegmentedControl } from './SettingsSegmentedControl';
import { useTokens } from '../../theme';

export type PersistentSessionDisplayField =
  | 'show_character'
  | 'animate_character'
  | 'show_generation_separator'
  | 'show_jev_candidates'
  | 'turn_usage_mode';

export type PersistentSessionDisplayValues = Omit<Record<PersistentSessionDisplayField, boolean>, 'turn_usage_mode'> & {
  turn_usage_mode: PersistentTurnUsageMode;
};
export type PersistentSessionDisplayValue = boolean | PersistentTurnUsageMode;
export type PersistentSessionEditorSection = 'all' | 'account-model' | 'display';

export function PersistentSessionInstructionsFields({
  title = '지속 지시',
  instructions,
  loading,
  loadError,
  mutationError,
  editingId,
  editingText,
  addingText,
  busy,
  onRetry,
  onEditStart,
  onEditText,
  onEditSave,
  onEditCancel,
  onDelete,
  onAddText,
  onAdd,
}: {
  title?: string;
  instructions: PersistentSessionInstruction[];
  loading: boolean;
  loadError: boolean;
  mutationError: string | null;
  editingId: string | null;
  editingText: string;
  addingText: string;
  busy: boolean;
  onRetry(): void;
  onEditStart(instruction: PersistentSessionInstruction): void;
  onEditText(value: string): void;
  onEditSave(): void;
  onEditCancel(): void;
  onDelete(instruction: PersistentSessionInstruction): void;
  onAddText(value: string): void;
  onAdd(): void;
}) {
  const styles = useSettingsFormStyles();
  const t = useTokens();
  const formatDate = (value: string) => new Date(value).toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const detail = (instruction: PersistentSessionInstruction) => [
    instruction.source_turns.length ? instruction.source_turns.join(', ') : null,
    formatDate(instruction.updated_at),
  ].filter(Boolean).join(' · ');

  return <Group title={title}>
    {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
    {loadError ? <View style={styles.block}>
      <Text accessibilityRole="alert" style={styles.error}>조회 실패</Text>
      <Action label="다시 시도" disabled={busy} onPress={onRetry} testID="persistent-instructions-retry" />
    </View> : null}
    {!loading && !loadError && instructions.length === 0 ? <Notice text="지속 지시 없음" /> : null}
    {!loadError ? instructions.map((instruction) => editingId === instruction.id
      ? <View key={instruction.id} style={{ gap: t.spacing.sm }} testID={`persistent-instruction-edit-${instruction.id}`}>
        <Input
          label="지시"
          value={editingText}
          onChangeText={onEditText}
          onSubmitEditing={onEditSave}
          returnKeyType="done"
          blurOnSubmit
          editable={!busy}
          testID={`persistent-instruction-input-${instruction.id}`}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }}>
          <Action label="저장" disabled={busy} primary onPress={onEditSave} testID={`persistent-instruction-save-${instruction.id}`} />
          <Action label="취소" disabled={busy} onPress={onEditCancel} testID={`persistent-instruction-cancel-${instruction.id}`} />
        </View>
      </View>
      : <View key={instruction.id} style={{ gap: t.spacing.xs }} testID={`persistent-instruction-${instruction.id}`}>
        <SettingsListRow title={instruction.text} detail={detail(instruction)} onPress={() => onEditStart(instruction)} disabled={busy} testID={`persistent-instruction-open-${instruction.id}`} />
        <View style={{ flexDirection: 'row', gap: t.spacing.sm }}>
          <Action label="삭제" disabled={busy} onPress={() => onDelete(instruction)} testID={`persistent-instruction-delete-${instruction.id}`} />
        </View>
      </View>) : null}
    {!loadError ? <View style={{ gap: t.spacing.sm }}>
      <Input
        label="새 지시"
        value={addingText}
        placeholder="지속 지시 추가"
        onChangeText={onAddText}
        onSubmitEditing={onAdd}
        returnKeyType="done"
        blurOnSubmit
        editable={!busy}
        testID="persistent-instruction-add-input"
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }}>
        <Action label="추가" disabled={busy || !addingText.trim()} primary onPress={onAdd} testID="persistent-instruction-add" />
      </View>
      {mutationError ? <Text accessibilityRole="alert" style={styles.error}>{mutationError}</Text> : null}
    </View> : null}
  </Group>;
}

export function persistentSessionDisplayValues(session: PersistentSessionResource): PersistentSessionDisplayValues {
  return {
    show_character: session.settings.show_character !== false,
    animate_character: session.settings.animate_character !== false,
    show_generation_separator: session.settings.show_generation_separator === true,
    show_jev_candidates: session.settings.show_jev_candidates === true,
    turn_usage_mode: session.settings.turn_usage_mode,
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
  onDisplayChange(field: PersistentSessionDisplayField, value: PersistentSessionDisplayValue): void;
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
      help="표시를 꺼도 기록은 남습니다."
      onValueChange={(value) => onDisplayChange('show_generation_separator', value)}
    />
    <SettingsToggleRow
      label="Jev 후보 표시"
      value={display.show_jev_candidates}
      disabled={displaySaving}
      testID="persistent-show-jev-candidates"
      help="내 입력 아래에 후보를 보여 줍니다."
      onValueChange={(value) => onDisplayChange('show_jev_candidates', value)}
    />
    <View style={{ gap: t.spacing.xs }}>
      <Text style={styles.label}>턴 끝 사용량</Text>
      <SettingsSegmentedControl<PersistentTurnUsageMode>
        id="persistent-turn-usage"
        value={display.turn_usage_mode}
        disabled={displaySaving}
        options={[
          { value: 'collapsed', label: '접어서' },
          { value: 'expanded', label: '펼쳐서' },
          { value: 'hidden', label: '숨김' },
        ]}
        onChange={(value) => onDisplayChange('turn_usage_mode', value)}
      />
    </View>
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
