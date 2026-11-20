import React, { useMemo, useState } from 'react';
import { StyleSheet, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { SettingsInput } from './SettingsFormParts';
import { GroupedGlassRow, GroupedGlassSheet } from '../planner/GroupedGlassSheet';
import { cardStyles } from '../planner/Card.styles';

// 선택지 폭 고정용 측정 상자. 높이 0으로 접혀 화면을 차지하지 않고 접근성 트리에서도 숨는다.
const widthProbeStyles = StyleSheet.create({
  probe: { position: 'absolute', left: 0, top: 0, height: 0, overflow: 'hidden', alignItems: 'flex-start' },
});

export interface SettingsOption { id: string; label: string; available?: boolean; reason?: string | null }
export function SettingsOptionRow({ selected, options, onSelect, emptyLabel, label = '항목 선택', variant, presentation = 'default', pickerMode = 'auto', stabilizePickerWidth = false }: {
  selected: string; options: SettingsOption[]; onSelect(value: string): void; emptyLabel: string; label?: string;
  variant?: 'chat'; presentation?: 'default' | 'manuscript';
  pickerMode?: 'auto' | 'picker';
  /** 피커 폭을 가장 긴 선택지의 내용 폭에 고정한다. 보기를 바꿔도 줄 모양이 흔들리지 않는다. 기본 꺼짐. */
  stabilizePickerWidth?: boolean;
}) {
  const t = useTokens();
  const baseStyles = useMemo(() => cardStyles(t), [t]);
  const styles = variant === 'chat'
    ? { ...baseStyles, body: { ...baseStyles.body, fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio } }
    : baseStyles;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [widestLabelWidth, setWidestLabelWidth] = useState(0);
  const items = selected && !options.some(option => option.id === selected) ? [...options, { id: selected, label: selected, available: false, reason: '저장된 값이 현재 목록에 없습니다.' }] : options;
  const selectedOption = items.find(option => option.id === selected);
  const description = (option: SettingsOption) => option.reason ?? (option.available === false ? '현재 사용 불가' : null);
  const choose = (id: string) => { onSelect(id); setOpen(false); setQuery(''); };
  const measureOptionWidth = (width: number) => setWidestLabelWidth(current => (width > current ? width : current));
  const large = pickerMode === 'picker' || items.length > 5 || items.some(option => option.label.length > 24);
  if (!items.length) return <Text style={styles.body}>{emptyLabel}</Text>;
  const rows = items.filter(option => `${option.label} ${option.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <View>
    {large ? <GlassButton {...(variant === 'chat' ? { variant: presentation === 'manuscript' ? 'paper' as const : 'secondary' as const, size: 'compact' as const } : {})} accessibilityLabel={`${label}: ${selectedOption?.label ?? '선택 안 함'}`} onPress={() => { setQuery(''); setOpen(true); }}>
      <Text style={[styles.body, stabilizePickerWidth ? { minWidth: widestLabelWidth, textAlign: 'center' as const } : null]}>{selectedOption?.label ?? '선택하세요'}{selectedOption && description(selectedOption) ? ' · ' : ''}{selectedOption && description(selectedOption) ? <Text style={styles.meta}>{description(selectedOption)}</Text> : null}</Text>
      {stabilizePickerWidth ? <View testID="settings-option-width-probe" aria-hidden accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={widthProbeStyles.probe}>
        {items.map(option => <Text key={option.id} testID={`settings-option-width-probe-${option.id}`} numberOfLines={1} onLayout={event => measureOptionWidth(event.nativeEvent.layout.width)} style={styles.body}>{option.label}</Text>)}
      </View> : null}
    </GlassButton> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs }}>
      {items.map(option => variant === 'chat'
        ? <GlassButton key={option.id} variant={presentation === 'manuscript' ? 'paper' : 'secondary'} size="compact"
            accessibilityLabel={`${label}: ${option.label}`} accessibilityState={{ selected: selected === option.id }}
            aria-pressed={selected === option.id} onPress={() => choose(option.id)}
            contentStyle={selected === option.id ? { backgroundColor: t.colors.accentTint } : undefined}>
            <Text style={styles.body}>{option.label}</Text>{description(option) ? <Text style={styles.meta}>{description(option)}</Text> : null}
          </GlassButton>
        : <TouchableOpacity key={option.id} accessibilityRole="button" accessibilityState={{ selected: selected === option.id }} onPress={() => choose(option.id)} style={{ minHeight: t.hitTarget.min, minWidth: t.hitTarget.min, padding: t.spacing.sm, borderRadius: t.foundation.radius.field, borderWidth: StyleSheet.hairlineWidth, borderColor: selected === option.id ? t.colors.accent : t.colors.border, backgroundColor: selected === option.id ? t.colors.accentTint : t.colors.surfaceMuted }}><Text style={styles.body}>{option.label}</Text>{description(option) ? <Text style={styles.meta}>{description(option)}</Text> : null}</TouchableOpacity>)}
    </View>}
    {open ? <AppModalSurface visible modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1, padding: t.cardLayout.padding, gap: t.spacing.md }}>
        <Text style={styles.heading}>{label}</Text>
        {variant === 'chat'
          ? <SettingsInput variant="chat" label="" accessibilityLabel={`${label} 검색`} placeholder="검색" value={query} onChangeText={setQuery}/>
          : <TextInput accessibilityLabel={`${label} 검색`} placeholder="검색" value={query} onChangeText={setQuery} style={styles.input} placeholderTextColor={t.colors.textPlaceholder}/>}
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={variant === 'chat' ? false : undefined} style={{ flex: 1 }}>
          <GroupedGlassSheet>{rows.map(option => <GroupedGlassRow key={option.id} selected={option.id === selected} accessibilityLabel={[option.label, description(option)].filter(Boolean).join(' · ')} onPress={() => choose(option.id)} style={{ padding: t.cardLayout.padding, gap: t.spacing.xs }}><Text style={styles.body}>{option.label}</Text>{description(option) ? <Text style={styles.meta}>{description(option)}</Text> : null}</GroupedGlassRow>)}</GroupedGlassSheet>
          {!rows.length ? <Text style={styles.body}>검색 결과가 없습니다.</Text> : null}
        </ScrollView>
        <GlassButton onPress={() => setOpen(false)}><Text style={styles.body}>닫기</Text></GlassButton>
      </View>
    </AppModalSurface> : null}
  </View>;
}
