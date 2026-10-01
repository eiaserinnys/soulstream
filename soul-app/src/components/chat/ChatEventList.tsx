import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { Session } from '../../api/types';
import type { ToolTraceResponse } from '../../api/client';
import type { ChatBodyStyles } from './ChatBody.styles';
import type { ChatRenderItem } from './groupChatEvents';
import { EventContextMenu } from '../events/EventContextMenu';
import { EventRenderer } from '../events/EventRenderer';
import {
  createMessageSelectionModel,
  type MessageSelectionModel,
} from '../events/message-selection-model';
import { ToolEvent } from '../events/ToolEvent';
import { TurnSummaryCaption } from '../events/TurnSummaryCaption';
import { TypingIndicator } from './TypingIndicator';
import { HistoryFetchError } from './HistoryFetchError';
import { useTokens } from '../../theme';

// FlatList onEndReachedThreshold 시맨틱: remainingLength / viewportLength.
// 1.0 = 끝까지 한 화면 분량이 남았을 때 미리 페치 트리거. inverted 모드에서는 위쪽(과거)
// 으로 한 화면 더 가기 전에 다음 페이지가 도착하도록 하여 사용자 스크롤 시 보충 로딩이
// 시각적으로 노출되지 않게 한다. (사용자 의도: "여유 있게 미리 요청")
const PREFETCH_THRESHOLD = 1.0;

interface Props {
  flatListRef: React.RefObject<FlatList<ChatRenderItem> | null>;
  items: ChatRenderItem[];
  onRetryPending?: (eventId: string) => void;
  onRestorePending?: (eventId: string) => void;
  session: Session | undefined;
  sessionId: string;
  api: { getTimelineTrace: (sessionId: string, timelineId: string) => Promise<ToolTraceResponse> } | null;
  styles: ChatBodyStyles;
  accentColor: string;
  requestOlder: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollBeginDrag: () => void;
  historyLoading: boolean;
  reachedTop: boolean;
  hasFetchError: boolean;
  retryFromError: () => void;
  mvcpEnabled: boolean;
  highlightedItemKey?: string | null;
  onContentSizeChange: (height: number) => void;
  onScrollToIndexFailed?: (info: {
    index: number;
    highestMeasuredFrameIndex: number;
    averageItemLength: number;
  }) => void;
}

export function ChatEventList({
  flatListRef,
  items,
  onRetryPending,
  onRestorePending,
  session,
  sessionId,
  api,
  styles,
  accentColor,
  requestOlder,
  onScroll,
  onScrollBeginDrag,
  historyLoading,
  reachedTop,
  hasFetchError,
  retryFromError,
  mvcpEnabled,
  highlightedItemKey = null,
  onContentSizeChange,
  onScrollToIndexFailed,
}: Props) {
  const [activeSelection, setActiveSelection] = useState<{
    eventKey: string;
    model: MessageSelectionModel;
  } | null>(null);
  // 스트리밍 delta가 이어져도 선택 진입 시점의 본문을 고정한다. 그렇지 않으면 매 delta마다
  // 전체 선택이 다시 적용되어 사용자가 조절한 핸들 범위가 초기화된다.
  const closeSelection = useCallback(() => setActiveSelection(null), []);

  return (
    <FlatList
      ref={flatListRef}
      data={items}
      inverted
      extraData={[activeSelection, highlightedItemKey]}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => {
        if (item.kind === 'typing') return <TypingIndicator session={session} />;
        if (item.kind === 'turn-summary') {
          return (
            <SearchFocusHighlight active={item.key === highlightedItemKey}>
              <TurnSummaryCaption content={item.content} />
            </SearchFocusHighlight>
          );
        }
        if (item.kind === 'tool') {
          return (
            <SearchFocusHighlight active={item.key === highlightedItemKey}>
              <>
                <EventContextMenu
                  sessionId={sessionId}
                  event={item.start}
                  resultEvent={item.result}
                >
                  <ToolEvent
                    start={item.start}
                    result={item.result}
                    sessionId={sessionId}
                    api={api}
                  />
                </EventContextMenu>
                {item.summaries?.map((summary) => (
                  <TurnSummaryCaption
                    key={summary.key}
                    content={summary.content}
                  />
                ))}
              </>
            </SearchFocusHighlight>
          );
        }
        const selectionModel = createMessageSelectionModel(item.event);
        const selectionActive =
          activeSelection?.eventKey === item.key;
        return (
          <SearchFocusHighlight active={item.key === highlightedItemKey}>
            <>
              <EventContextMenu
                sessionId={sessionId}
                event={item.event}
                onSelectText={selectionModel
                  ? (model) => setActiveSelection({ eventKey: item.key, model })
                  : undefined}
                selectionActive={selectionActive}
              >
                <EventRenderer
                  event={item.event}
                  sessionId={sessionId}
                  session={session}
                  onRetryPending={onRetryPending}
                  onRestorePending={onRestorePending}
                  selectionModel={
                    selectionActive && activeSelection
                      ? activeSelection.model
                      : null
                  }
                  onSelectionDone={closeSelection}
                />
              </EventContextMenu>
              {item.summaries?.map((summary) => (
                <TurnSummaryCaption
                  key={summary.key}
                  content={summary.content}
                />
              ))}
            </>
          </SearchFocusHighlight>
        );
      }}
      onTouchStart={() => {
        if (activeSelection !== null) closeSelection();
      }}
      contentContainerStyle={styles.listContent}
      style={styles.list}
      onEndReached={requestOlder}
      onEndReachedThreshold={PREFETCH_THRESHOLD}
      // F-H-1: onScroll 핸들러는 useChatHistoryPagination 훅이 제공 — frontier 너머 진입 시
      // 동기적 scrollToOffset(frontier, animated=false) clamp. scrollEventThrottle=16
      // (iOS 최대 60fps).
      onScroll={onScroll}
      onScrollBeginDrag={onScrollBeginDrag}
      scrollEventThrottle={16}
      // F-D: 빠른 위로 스크롤 시 prepend된 cell이 가상화 윈도우 밖이라 mount + measure
      // 사이클 첫 프레임 동안 빈 박스로 노출되는 회귀를 완화한다.
      initialNumToRender={40}
      maxToRenderPerBatch={20}
      windowSize={31}
      removeClippedSubviews={false}
      // F-A: over-bounce 영역 진입 시 native MVCP `_firstVisibleView` 측정 race가
      // contentOffset jump을 일으키는 회귀를 양쪽 끝 항상 차단으로 구조적으로 제거한다.
      bounces={false}
      overScrollMode="never"
      maintainVisibleContentPosition={
        mvcpEnabled
          ? { minIndexForVisible: 0, autoscrollToTopThreshold: 10 }
          : undefined
      }
      onContentSizeChange={(_w, h) => onContentSizeChange(h)}
      onScrollToIndexFailed={onScrollToIndexFailed}
      ListFooterComponent={
        historyLoading && !reachedTop ? (
          <View style={styles.footerLoader}>
            <ActivityIndicator color={accentColor} />
          </View>
        ) : hasFetchError && !reachedTop ? (
          <HistoryFetchError onRetry={retryFromError} />
        ) : null
      }
    />
  );
}

function SearchFocusHighlight({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const t = useTokens();
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      opacity.setValue(0);
      return;
    }
    opacity.setValue(1);
    const animation = Animated.sequence([
      Animated.delay(900),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 1100,
        useNativeDriver: false,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [active, opacity]);
  const style = useMemo(() => ({
    backgroundColor: opacity.interpolate({
      inputRange: [0, 1],
      outputRange: ['transparent', t.colors.accentTint],
    }),
    borderLeftColor: t.colors.accent,
    borderLeftWidth: opacity.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 3],
    }),
  }), [opacity, t.colors.accent, t.colors.accentTint]);
  return <Animated.View style={style}>{children}</Animated.View>;
}
