import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { FolderAtomReference, Sourced } from '../../lib/folder-context';
import type { FolderSettingsDraft } from '../../lib/folder-settings';
import { useTokens } from '../../theme';
import { AddRow, FailedRow, HeadingRow, InheritedValue, ReferenceRow, SourceToggle } from './FolderContextParts';
import { FolderDefaultsFields, type FolderDefaultsFieldsChange } from './FolderDefaultsFields';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { GrowingMultilineInput } from './GrowingMultilineInput';
import { makeStyles } from './SessionSuccessionSheet.styles';

export interface FolderInheritedContext {
  guidance: { text: string; sourceName: string } | null;
  references: Array<Sourced<FolderAtomReference>>;
  defaults: { summary: string; sourceName: string | null } | null;
  loading: boolean;
  chainFailed: boolean;
  defaultsFailed: boolean;
  retry(): void;
}

/**
 * Body of the new folder and folder settings sheet: name, description, guidance, references, execution defaults.
 * A folder without a parent has nothing to inherit, so it shows its own fields without the inherit toggle.
 */
export function FolderSettingsForm({
  api, mode, parentName, hasParent, onPickParent, locked, draft, inherited,
  onChange, onDefaultsChange, onAddReference, onEditReference,
}: {
  api: ApiClient | null;
  mode: 'create' | 'edit';
  parentName: string | null;
  hasParent: boolean;
  onPickParent?: () => void;
  locked: boolean;
  draft: FolderSettingsDraft;
  inherited: FolderInheritedContext;
  onChange(patch: Partial<FolderSettingsDraft>): void;
  onDefaultsChange(change: FolderDefaultsFieldsChange): void;
  onAddReference(): void;
  onEditReference(index: number): void;
}) {
  const t = useTokens();
  const fieldMinHeight = t.foundation.minHeight.field - 2 * t.cardLayout.padding;
  const styles = useMemo(() => {
    const sheet = makeStyles(t);
    return {
      ...sheet,
      ...StyleSheet.create({
        parent: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, minHeight: t.hitTarget.min },
        nameInput: { ...sheet.initialInput, minHeight: t.foundation.minHeight.field - 2 * t.cardLayout.padding, textAlignVertical: 'center' },
      }),
    };
  }, [t]);
  const guidanceOwn = !hasParent || draft.guidanceSource === 'own';
  const defaultsOwn = !hasParent || draft.defaultsSource === 'own';
  const ownKeys = new Set(draft.atomReferences.map((reference) => `${reference.instance}:${reference.nodeId}`));
  const inheritedReferences = inherited.references.filter((reference) => !ownKeys.has(`${reference.instance}:${reference.nodeId}`));
  const multiline = (testID: string, value: string, placeholder: string, onText: (value: string) => void, label: string) => (
    <GroupedGlassSheet><View style={styles.formField}>
      <GrowingMultilineInput testID={testID} accessibilityLabel={label} value={value} onChangeText={onText} editable={!locked}
        minHeight={fieldMinHeight} maxHeight={t.foundation.minHeight.memo * 4} verticalPadding={0}
        placeholder={placeholder} placeholderTextColor={t.colors.textPlaceholder} style={styles.initialInput} />
    </View></GroupedGlassSheet>
  );

  return <>
    {parentName !== null ? (
      <View style={styles.section}>
        <Text style={styles.meta}>상위 폴더</Text>
        {onPickParent ? (
          <TouchableOpacity testID="new-task-project-selection" style={styles.parent} onPress={onPickParent} disabled={locked}
            accessibilityRole="button" accessibilityLabel="상위 폴더 선택" accessibilityValue={{ text: parentName }}>
            <Text style={styles.folderTitle} numberOfLines={1}>{parentName}</Text>
            <Ionicons name="chevron-down" size={t.iconSize.compact} color={t.colors.textTertiary} />
          </TouchableOpacity>
        ) : <Text testID="folder-settings-parent" style={styles.folderTitle} numberOfLines={1}>{parentName}</Text>}
      </View>
    ) : null}
    <View style={styles.section}>
      <HeadingRow title="이름" />
      <GroupedGlassSheet><View style={styles.formField}>
        <TextInput testID="folder-settings-title" accessibilityLabel="이름" value={draft.title} editable={!locked}
          onChangeText={(title) => onChange({ title })} placeholder="폴더 이름" placeholderTextColor={t.colors.textPlaceholder}
          style={styles.nameInput} autoFocus={mode === 'create'} />
      </View></GroupedGlassSheet>
    </View>
    <View style={styles.section}>
      <HeadingRow title="설명" />
      {multiline('folder-settings-description', draft.description, '목표와 완료 조건을 적어두세요.', (description) => onChange({ description }), '설명')}
    </View>
    <View style={styles.section}>
      <HeadingRow title="지침" />
      {hasParent ? <SourceToggle id="folder-guidance" value={draft.guidanceSource} disabled={locked} onChange={(guidanceSource) => onChange({ guidanceSource })} /> : null}
      {guidanceOwn
        ? multiline('folder-settings-guidance', draft.guidance, '이 폴더에서 에이전트가 따를 지침', (guidance) => onChange({ guidance }), '지침')
        : <GroupedGlassSheet>
          {inherited.loading ? <Loading /> : inherited.chainFailed
            ? <FailedRow testID="folder-settings-guidance-failed" message="물려받은 지침을 불러오지 못했습니다." onRetry={inherited.retry} />
            : <InheritedValue testID="folder-settings-inherited-guidance" lines={4}
            sourceName={inherited.guidance?.sourceName ?? null} text={inherited.guidance?.text ?? null} empty="물려받을 지침이 없습니다." />}
        </GroupedGlassSheet>}
    </View>
    <View style={styles.section}>
      <HeadingRow title="참고 자료" />
      <GroupedGlassSheet testID="folder-settings-references">
        {[
          hasParent && inherited.chainFailed && !inherited.loading
            ? <FailedRow key="failed" testID="folder-settings-references-failed" message="물려받은 참고 자료를 불러오지 못했습니다." onRetry={inherited.retry} />
            : null,
          ...inheritedReferences.map((reference) => (
            <ReferenceRow key={`inherited:${reference.instance}:${reference.nodeId}`} testID={`folder-reference-inherited-${reference.nodeId}`}
              item={reference} sourceName={reference.source.folderName} />
          )),
          ...draft.atomReferences.map((reference, index) => (
            <ReferenceRow key={`own:${reference.instance}:${reference.nodeId}`} testID={`folder-reference-${reference.nodeId}`}
              item={reference} disabled={locked} onPress={() => onEditReference(index)}
              onRemove={() => onChange({ atomReferences: draft.atomReferences.filter((_, position) => position !== index) })} />
          )),
          <AddRow key="add" testID="folder-reference-add" label="참고 자료 추가" disabled={locked} onPress={onAddReference} />,
        ].filter(Boolean)}
      </GroupedGlassSheet>
    </View>
    <View style={styles.section}>
      <HeadingRow title="기본 실행 환경" />
      {hasParent ? <SourceToggle id="folder-defaults" value={draft.defaultsSource} disabled={locked} onChange={(defaultsSource) => onChange({ defaultsSource })} /> : null}
      {defaultsOwn
        ? <FolderDefaultsFields api={api} initial={draft.defaults} disabled={locked} onChange={onDefaultsChange} />
        : <GroupedGlassSheet>
          {inherited.loading ? <Loading /> : inherited.defaultsFailed
            ? <FailedRow testID="folder-settings-defaults-failed" message="물려받은 기본 실행 환경을 불러오지 못했습니다." onRetry={inherited.retry} />
            : <InheritedValue testID="folder-settings-inherited-defaults"
            sourceName={inherited.defaults?.sourceName ?? null} text={inherited.defaults?.summary ?? null} empty="물려받을 기본 실행 환경이 없습니다." />}
        </GroupedGlassSheet>}
    </View>
  </>;
}

function Loading() {
  const t = useTokens();
  return <View style={{ minHeight: t.foundation.minHeight.field, justifyContent: 'center' }}>
    <ActivityIndicator color={t.colors.accent} />
  </View>;
}
