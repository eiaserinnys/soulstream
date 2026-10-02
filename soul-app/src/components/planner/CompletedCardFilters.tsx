import React from 'react';
import { Text,TextInput,View } from 'react-native';
import { completedPeriods,type CompletedPeriod } from '../../../../packages/soul-ui/src/cards/completed-cards';
import { useTokens } from '../../theme';
import type { CompletedBrowser } from '../../hooks/useCompletedCards';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { SessionSearchField } from '../search/SessionSearchField';
import { cardStyles } from './Card.styles';
export function CompletedCardFilters({browser}:{browser:CompletedBrowser}) {
  const t=useTokens(),styles=cardStyles(t);
  return <View style={{gap:t.uiSpacing.sm}}>
    <SettingsSegmentedControl<CompletedPeriod> id="completed-period" value={browser.period} options={completedPeriods} onChange={browser.setPeriod}/>
    {browser.period==='custom'?<View style={{flexDirection:'row',gap:t.uiSpacing.sm}}>
      <TextInput accessibilityLabel="완료 시작일" placeholder="시작일 YYYY-MM-DD" value={browser.start} onChangeText={browser.setStart} style={[styles.input,{flex:1,minWidth:0}]} autoCorrect={false}/>
      <TextInput accessibilityLabel="완료 종료일" placeholder="종료일 YYYY-MM-DD" value={browser.end} onChangeText={browser.setEnd} style={[styles.input,{flex:1,minWidth:0}]} autoCorrect={false}/>
    </View>:null}
    <SessionSearchField placeholder="제목 또는 요청 검색" accessibilityLabel="제목 또는 요청 검색" value={browser.search} onChangeText={browser.setSearch} testID="completed-search"/>
    {browser.error?<Text accessibilityRole="alert" style={styles.error}>{browser.error}</Text>:null}
  </View>;
}
