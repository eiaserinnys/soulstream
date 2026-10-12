import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CardItemCheckbox } from '../components/CardItemCheckbox';
import { SettingsInput } from '../components/settings/SettingsFormParts';
import { SettingsOptionRow } from '../components/settings/SettingsOptionRow';
import { useTokens } from '../theme';

const planOptions = [
  { id: 'starter', label: '기본 요금제' },
  { id: 'personal', label: '개인 요금제' },
  { id: 'team', label: '팀 요금제' },
  { id: 'studio', label: '스튜디오 요금제' },
  { id: 'enterprise', label: '기업 요금제' },
  { id: 'custom', label: '사용자 지정 요금제' },
  { id: 'extended', label: '기업용 분석 및 내부 검수 자료 포함' },
];

export function ReviewChatUiPrimitives() {
  const t = useTokens();
  const body = {
    fontSize: t.chatFontSize.body,
    lineHeight: t.chatFontSize.body * t.lineHeightRatio,
    color: t.colors.textPrimary,
  };
  const [attendeeCount, setAttendeeCount] = useState('12');
  const [amount, setAmount] = useState('278400');
  const [annual, setAnnual] = useState(true);
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>(['summary']);
  const [billing, setBilling] = useState('monthly');
  const [plan, setPlan] = useState('extended');
  const [defaultPlan, setDefaultPlan] = useState('starter');
  const [paperChoice, setPaperChoice] = useState('draft');
  const [note, setNote] = useState('기본 입력 예시');
  const [defaultChoice, setDefaultChoice] = useState('first');
  const [defaultChecked, setDefaultChecked] = useState(false);

  return <SafeAreaView testID="chat-ui-primitives-review" style={{ flex: 1, backgroundColor: t.colors.background }}>
    <ScrollView testID="chat-ui-primitives-scroll" style={{ flex: 1 }} contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.spacing.lg }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text accessibilityRole="header" style={{ ...body, fontWeight: '700' }}>앱 입력 부품</Text>

      <View style={{ gap: t.spacing.md }}>
        <Text accessibilityRole="header" style={{ ...body, fontWeight: '700' }}>채팅용</Text>
        <SettingsInput variant="chat" label="참석 인원" value={attendeeCount} onChangeText={setAttendeeCount} keyboardType="number-pad" inputMode="numeric" />
        <SettingsInput variant="chat" label="" accessibilityLabel="예산" value={amount} onChangeText={setAmount} keyboardType="number-pad" inputMode="numeric" />
        <CardItemCheckbox variant="chat" label="연간 결제" checked={annual} testID="chat-annual-plan" onPress={() => setAnnual(value => !value)} />
        <View style={{ gap: t.spacing.md }}>
          <Text style={body}>포함 항목</Text>
          <View>
            {[
              { id: 'summary', label: '요약' },
              { id: 'sources', label: '출처' },
            ].map(option => {
              const checked = selectedFeatures.includes(option.id);
              const toggle = () => setSelectedFeatures(current => checked
                ? current.filter(id => id !== option.id)
                : [...current, option.id]);
              return <CardItemCheckbox key={option.id} variant="chat" label={option.label} checked={checked} testID={`chat-feature-${option.id}`} onPress={toggle} />;
            })}
          </View>
        </View>
        <View style={{ gap: t.spacing.sm }}>
          <Text style={body}>결제 주기</Text>
          <SettingsOptionRow variant="chat" presentation="default" label="결제 주기" selected={billing} options={[
            { id: 'monthly', label: '월간' },
            { id: 'annual', label: '연간' },
          ]} emptyLabel="없음" onSelect={setBilling} />
        </View>
        <View style={{ gap: t.spacing.sm }}>
          <Text style={body}>문서 보관</Text>
          <SettingsOptionRow variant="chat" presentation="manuscript" label="문서 보관" selected={paperChoice} options={[
            { id: 'draft', label: '초안' },
            { id: 'final', label: '최종본' },
          ]} emptyLabel="없음" onSelect={setPaperChoice} />
        </View>
        <View style={{ gap: t.spacing.sm }}>
          <Text style={body}>요금제</Text>
          <SettingsOptionRow variant="chat" presentation="manuscript" label="요금제" selected={plan} options={planOptions} emptyLabel="없음" onSelect={setPlan} />
        </View>
        <View style={{ gap: t.spacing.sm }}>
          <Text style={body}>팀 요금제</Text>
          <SettingsOptionRow variant="chat" presentation="default" label="팀 요금제" selected={defaultPlan} options={planOptions} emptyLabel="없음" onSelect={setDefaultPlan} />
        </View>
      </View>

      <View testID="settings-default-primitives" style={{ gap: t.spacing.md }}>
        <Text accessibilityRole="header" style={{ ...body, fontWeight: '700' }}>설정 기본형</Text>
        <SettingsInput label="비고" value={note} onChangeText={setNote} />
        <View style={{ gap: t.spacing.xs }}>
          <Text style={body}>기본 선택</Text>
          <SettingsOptionRow label="기본 선택" selected={defaultChoice} options={[
            { id: 'first', label: '첫 번째' },
            { id: 'second', label: '두 번째' },
          ]} emptyLabel="없음" onSelect={setDefaultChoice} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
          <CardItemCheckbox itemId={7} title="기본 체크" checked={defaultChecked} onPress={() => setDefaultChecked(value => !value)} />
          <Text accessibilityRole="button" onPress={() => setDefaultChecked(value => !value)} style={body}>기본 체크</Text>
        </View>
      </View>
    </ScrollView>
  </SafeAreaView>;
}
