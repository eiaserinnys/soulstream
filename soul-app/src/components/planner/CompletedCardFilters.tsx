import React from 'react';
import { Text,TextInput,View } from 'react-native';
import { completedPeriods,type CompletedPeriod } from '../../../../packages/soul-ui/src/cards/completed-cards';
import { useTokens } from '../../theme';
import type { CompletedBrowser } from '../../hooks/useCompletedCards';
import { GlassButton } from '../GlassSurface';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { SessionSearchField } from '../search/SessionSearchField';
import { cardStyles } from './Card.styles';
export function CompletedCardFilters({browser}:{browser:CompletedBrowser}) {
  const t=useTokens(),styles=cardStyles(t);
  return <View style={{gap:t.uiSpacing.sm}}>
    <SettingsSegmentedControl<CompletedPeriod> evenRows id="completed-period" value={browser.period} options={completedPeriods} onChange={browser.setPeriod}/>
    {browser.period==='custom'?<View style={{flexDirection:'row',gap:t.uiSpacing.sm}}>
      <TextInput accessibilityLabel="완료 시작일" placeholder="시작일 YYYY-MM-DD" value={browser.start} onChangeText={browser.setStart} style={[styles.input,{flex:1,minWidth:0}]} autoCorrect={false}/>
      <TextInput accessibilityLabel="완료 종료일" placeholder="종료일 YYYY-MM-DD" value={browser.end} onChangeText={browser.setEnd} style={[styles.input,{flex:1,minWidth:0}]} autoCorrect={false}/>
    </View>:null}
    <SessionSearchField placeholder="제목 또는 요청 검색" accessibilityLabel="제목 또는 요청 검색" value={browser.search} onChangeText={browser.setSearch} testID="completed-search"/>
    {browser.error?<Text testID="completed-error" accessibilityRole="alert" style={styles.error}>{browser.error}</Text>:null}
    {/* 보드 조회 실패와 같은 단추를 글 폭으로 둔다. 조회 중에는 끈다. 범위 안내는 다시 받아도 고쳐지지 않으니 단추가 없다. */}
    {browser.error&&!browser.invalidRange?<GlassButton testID="completed-retry" accessibilityLabel="완료 카드 다시 조회" style={{alignSelf:'flex-start'}} disabled={browser.loading} onPress={browser.retry}>
      <Text style={{...t.foundation.typography.body,color:t.colors.textPrimary}}>다시 시도</Text>
    </GlassButton>:null}
  </View>;
}
