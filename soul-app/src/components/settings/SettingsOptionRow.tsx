import React, { useMemo, useState } from 'react';
import { StyleSheet, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { GroupedGlassRow, GroupedGlassSheet } from '../planner/GroupedGlassSheet';
import { cardStyles } from '../planner/Card.styles';

export interface SettingsOption { id: string; label: string; available?: boolean; reason?: string | null }
export function SettingsOptionRow({ selected, options, onSelect, emptyLabel, label = '항목 선택' }: {
  selected: string; options: SettingsOption[]; onSelect(value: string): void; emptyLabel: string; label?: string;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const items = selected && !options.some(option => option.id === selected) ? [...options, { id: selected, label: selected, available: false, reason: '저장된 값이 현재 목록에 없습니다.' }] : options;
  const selectedOption = items.find(option => option.id === selected);
  const description = (option: SettingsOption) => option.reason ?? (option.available === false ? '현재 사용 불가' : null);
  const choose = (id: string) => { onSelect(id); setOpen(false); setQuery(''); };
  const large = items.length > 5 || items.some(option => option.label.length > 24);
  if (!items.length) return <Text style={styles.body}>{emptyLabel}</Text>;
  const rows = items.filter(option => `${option.label} ${option.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <View>
    {large ? <GlassButton accessibilityLabel={`${label}: ${selectedOption?.label ?? '선택 안 함'}`} onPress={() => { setQuery(''); setOpen(true); }}><Text style={styles.body}>{selectedOption?.label ?? '선택하세요'}{selectedOption && description(selectedOption) ? ` · ${description(selectedOption)}` : ''}</Text></GlassButton> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs }}>
      {items.map(option => <TouchableOpacity key={option.id} accessibilityRole="button" accessibilityState={{ selected: selected === option.id }} onPress={() => choose(option.id)} style={{ minHeight: t.hitTarget.min, minWidth: t.hitTarget.min, padding: t.spacing.sm, borderRadius: t.foundation.radius.field, borderWidth: StyleSheet.hairlineWidth, borderColor: selected === option.id ? t.colors.accent : t.colors.border, backgroundColor: selected === option.id ? t.colors.accentTint : t.colors.surfaceMuted }}><Text style={styles.body}>{option.label}</Text>{description(option) ? <Text style={styles.body}>{description(option)}</Text> : null}</TouchableOpacity>)}
    </View>}
    {open ? <AppModalSurface visible modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1, padding: t.cardLayout.padding, gap: t.spacing.md }}>
        <Text style={styles.heading}>{label}</Text>
        <TextInput accessibilityLabel={`${label} 검색`} placeholder="검색" value={query} onChangeText={setQuery} style={styles.input} placeholderTextColor={t.colors.textPlaceholder}/>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
          <GroupedGlassSheet>{rows.map(option => <GroupedGlassRow key={option.id} selected={option.id === selected} accessibilityLabel={[option.label, description(option)].filter(Boolean).join(' · ')} onPress={() => choose(option.id)} style={{ padding: t.cardLayout.padding, gap: t.spacing.xs }}><Text style={styles.body}>{option.label}</Text>{description(option) ? <Text style={styles.body}>{description(option)}</Text> : null}</GroupedGlassRow>)}</GroupedGlassSheet>
          {!rows.length ? <Text style={styles.body}>검색 결과가 없습니다.</Text> : null}
        </ScrollView>
        <GlassButton onPress={() => setOpen(false)}><Text style={styles.body}>닫기</Text></GlassButton>
      </View>
    </AppModalSurface> : null}
  </View>;
}
