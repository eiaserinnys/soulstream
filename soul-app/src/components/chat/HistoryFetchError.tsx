// fetch 영구 실패 시 ListFooterComponent 자리에 표시되는 에러 + 재시도 박스.
//
// useChatHistoryPagination 훅이 자동 retry 1회 후에도 실패하면 hasFetchError=true로
// 전환하고, 본 박스의 재시도 버튼이 retryFromError를 호출하여 사용자 수동 재시도를
// 트리거한다.
//
// 위치: inverted FlatList의 ListFooterComponent → 화면 위쪽(=가장 오래된 메시지의 위).
// spinner와 같은 자리이므로 사용자 시야가 "로딩 → 실패" 흐름을 그대로 이어받는다.
//
// 자연 재시도 경로(onEndReached / SSE 도착) 성공 시 훅의 success branch가
// setHasFetchError(false)로 자동 해제 → 박스 자연 사라짐 (사용자에게 "수동 재시도
// 안 해도 됐네" 인지).

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTokens } from '../../theme';
import { makeHistoryFetchErrorStyles } from './HistoryFetchError.styles';

interface Props {
  /** 사용자 수동 재시도 트리거 — 훅의 retryFromError를 그대로 연결. */
  onRetry: () => void;
  message?: string;
}

export function HistoryFetchError({ onRetry, message = '메시지를 불러오지 못했어요' }: Props) {
  const t = useTokens();
  const styles = makeHistoryFetchErrorStyles(t);
  return (
    <View style={styles.container}>
      {/* colors.textSecondary 사용 — 조용한 에러 표현. colors.error(빨강 강조)는
          시각적 마찰을 키워 채팅 흐름을 가로막으므로 회피. 사용자가 *액션을 취할
          수 있는 상태*임을 명시하는 것이 목적이지 *경고*가 아님 (ux-principles §1). */}
      <Ionicons
        name="alert-circle-outline"
        color={t.colors.textSecondary}
        size={t.iconSize.prominent}
      />
      <Text style={styles.message}>{message}</Text>
      <TouchableOpacity onPress={onRetry} style={styles.retryBtn}>
        <Text style={styles.retryText}>다시 시도</Text>
      </TouchableOpacity>
    </View>
  );
}
