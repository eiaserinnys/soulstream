import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { GlassButton } from '../components/GlassSurface';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useUIStore } from '../store/uiStore';
import { dialogueSamples, type DialogueSample } from './dialogue-inventory';
import { SheetErrorNotice, sheetErrorDetail } from '../components/planner/SheetErrorNotice';
import { ReviewSection } from './ReviewSection';
import { ReviewNativeDialogues } from './ReviewNativeDialogues';
import { ReviewDialogueSurface } from './ReviewDialogueSurface';

export function ReviewDialogues() {
  const t = useTokens();
  const text = { ...t.foundation.typography.body, color: t.colors.textPrimary };
  const [selected, setSelected] = useState<DialogueSample>('card-create');
  const [opened, setOpened] = useState<DialogueSample | null>(null);
  const [instance, setInstance] = useState(0);
  const [result, setResult] = useState('');
  const close = () => setOpened(null);
  return <>
    <ReviewSection title="iOS 다이얼로그">
      <Text style={text}>iOS 앱 컴포넌트의 웹 미리보기입니다. 원래 컴포넌트를 공개 예시로 엽니다. 저장은 메모리에만 남습니다.</Text>
      <Text style={text}>선택 행의 iOS 기본 메뉴는 웹에서 표시할 수 없습니다. 아래 기본 확인창 목록에서 문구와 종류를 확인합니다.</Text>
      <SettingsSegmentedControl<DialogueSample> id="review-dialogue" value={selected} onChange={setSelected} options={dialogueSamples} wrap />
      <GlassButton accessibilityLabel="선택한 다이얼로그 열기" onPress={() => { setResult(''); setInstance(value => value + 1); setOpened(selected); }}>
        <Text style={text}>{dialogueSamples.find(sample => sample.value === selected)?.label} 열기</Text>
      </GlassButton>
      {result ? <Text testID="review-dialogue-result" style={text}>{result}</Text> : null}
      <ReviewDialogueSurface key={instance} opened={opened} onClose={close} onResult={setResult} />
    </ReviewSection>
    <ReviewSection title="카드·폴더·세션 상세 오버레이">
      <Text style={text}>독립 Modal이 아닌 앱의 실제 상세 오버레이입니다.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }}>
        <GlassButton accessibilityLabel="카드 상세 오버레이 열기" onPress={() => useUIStore.getState().openCardOverlay('public-todo')}><Text style={text}>카드 상세</Text></GlassButton>
        <GlassButton accessibilityLabel="폴더 상세 오버레이 열기" onPress={() => useUIStore.getState().openFolderOverlay('public-page')}><Text style={text}>폴더 상세</Text></GlassButton>
        <GlassButton accessibilityLabel="세션 상세 오버레이 열기" onPress={() => useUIStore.getState().openSessionOverlay('public-idle')}><Text style={text}>세션 상세</Text></GlassButton>
      </View>
    </ReviewSection>
    <ReviewSection title="작성창 오류 상세">
      <SheetErrorNotice summary="저장하지 못했습니다. 입력을 유지했습니다. 다시 시도해 주세요."
        detail={sheetErrorDetail(new Error('HTTP 403 request_id: 12345678-1234-1234-1234-123456789abc'))} />
    </ReviewSection>
    <ReviewNativeDialogues />
  </>;
}
