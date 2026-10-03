import React from 'react';
import { ActionSheetIOS, Alert, Platform, Text } from 'react-native';
import { useTokens } from '../theme';
import { GlassButton } from '../components/GlassSurface';
import { confirmPlannerAction, promptPlannerText } from '../components/planner/plannerNativeUI';
import { ReviewSection } from './ReviewSection';
import { alertOwners, nativeConfirmations, nativeMenuTypes, nativeRenames } from './dialogue-inventory';

export function ReviewNativeDialogues() {
  const t = useTokens();
  const text = { ...t.foundation.typography.body, color: t.colors.textPrimary };
  return <ReviewSection title="iOS 기본 확인창">
    <Text style={text}>iOS 기본 창: 이 웹 미리보기에서는 표시할 수 없습니다</Text>
    <Text style={text}>Alert・Alert.prompt・ActionSheetIOS의 원래 문구와 종류입니다. 호출 버튼은 실제 RN API를 사용하며 운영 동작을 실행하지 않습니다.</Text>
    {nativeConfirmations.map(input => <ReviewSection key={input.title} title={input.title}>
      <Text style={text}>{input.message} · 취소 / {input.confirmText}</Text>
      <GlassButton accessibilityLabel={input.title + ' 기본 확인창 호출'} onPress={() => confirmPlannerAction({ ...input, destructive: true, onConfirm() {} })}><Text style={text}>기본 확인창 호출</Text></GlassButton>
    </ReviewSection>)}
    {nativeRenames.map(title => <ReviewSection key={title} title={title}>
      <Text style={text}>{title === '세션 이름 변경' ? '취소 / 확인 · 빈 이름도 허용합니다.' : '새 이름 · 취소 / 확인'}</Text>
      <GlassButton accessibilityLabel={title + ' 기본 입력창 호출'} onPress={() => promptPlannerText({ title, message: title === '세션 이름 변경' ? undefined : '새 이름', allowBlank: title === '세션 이름 변경', current: '공개 예시', onSubmit() {} })}><Text style={text}>기본 입력창 호출</Text></GlassButton>
    </ReviewSection>)}
    <ReviewSection title="iOS 기본 선택 메뉴">
      {nativeMenuTypes.map(title => <Text key={title} style={text}>{title}</Text>)}
      <GlassButton accessibilityLabel="기본 선택 메뉴 호출" onPress={() => {
        if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: ['취소', '공개 예시'], cancelButtonIndex: 0 }, () => {});
      }}><Text style={text}>기본 선택 메뉴 호출</Text></GlassButton>
    </ReviewSection>
    <ReviewSection title="공통 안내·실패 Alert">
      <Text style={text}>저장·삭제·첨부·세션 시작·권한·작업 조회 실패는 공통 Alert입니다. 다음 실제 호출 위치를 포함합니다.</Text>
      <Text style={text}>{alertOwners.join(' · ')}</Text>
      <GlassButton accessibilityLabel="공통 실패 안내 호출" onPress={() => Alert.alert('작업을 완료하지 못했습니다.', '공개 예시 오류입니다.')}><Text style={text}>공통 Alert 호출</Text></GlassButton>
    </ReviewSection>
    <ReviewSection title="대화상자와 구분한 메뉴">
      <Text style={text}>AppContextMenu와 EventContextMenu는 컨텍스트 메뉴입니다. 카드 상태 메뉴는 실제 Modal이어서 위 비교 목록에 포함합니다. tooltip은 별도 Modal이 아닙니다.</Text>
    </ReviewSection>
  </ReviewSection>;
}
