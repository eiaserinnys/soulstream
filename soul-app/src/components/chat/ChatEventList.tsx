import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { ToolTraceResponse } from '../../api/client';
import type { PersistentTurnUsageMode } from '../../api/persistentSessionEndpoints';
import type { ChatBodyStyles } from './ChatBody.styles';
import type { ChatRenderItem } from './groupChatEvents';
import { EventContextMenu } from '../events/EventContextMenu';
import { EventRenderer, type ChatMessageSession } from '../events/EventRenderer';
import {
  createMessageSelectionModel,
  type MessageSelectionModel,
} from '../events/message-selection-model';
import { ToolEvent } from '../events/ToolEvent';
import { TurnSummaryCaption } from '../events/TurnSummaryCaption';
import { TurnEndCaptions } from './TurnEndCaptions';
import { AgentMessageGroup } from './AgentMessageGroup';
import { TypingIndicator } from './TypingIndicator';
import { ManuscriptActivitySegment } from './ManuscriptActivitySegment';
import { HistoryFetchError } from './HistoryFetchError';
import { useTokens } from '../../theme';
import { ChatNewMessageButton } from './ChatNewMessageButton';
import { CollapsibleCaption, CollapsibleCaptionLine } from './CollapsibleCaption';
import { LabeledDivider } from './LabeledDivider';

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
  session: ChatMessageSession | undefined;
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
  presentation?: 'default' | 'manuscript';
  showNewMessage?: boolean;
  onPressNewMessage?: () => void;
}

export const ChatEventList = memo(function ChatEventList({
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
  presentation = 'default',
  showNewMessage = false,
  onPressNewMessage,
}: Props) {
  const t = useTokens();
  const [activeSelection, setActiveSelection] = useState<{
    eventKey: string;
    model: MessageSelectionModel;
  } | null>(null);
  // 스트리밍 delta가 이어져도 선택 진입 시점의 본문을 고정한다. 그렇지 않으면 매 delta마다
  // 전체 선택이 다시 적용되어 사용자가 조절한 핸들 범위가 초기화된다.
  const closeSelection = useCallback(() => setActiveSelection(null), []);

  const selectText = useCallback((eventKey: string, model: MessageSelectionModel) => {
    setActiveSelection({ eventKey, model });
  }, []);
  const extraData = useMemo(() => [activeSelection, highlightedItemKey], [activeSelection, highlightedItemKey]);
  const renderItem = useCallback(({ item }: { item: ChatRenderItem }) => {
    const highlighted = item.key === highlightedItemKey
      || (item.kind === 'agent-message-group' && item.events.some((event) => event.key === highlightedItemKey));
    return (
      <ChatEventRow item={item} session={item.kind === 'event' || item.kind === 'typing' || item.kind === 'agent-message-group' || item.kind === 'activity' ? session : undefined} sessionId={sessionId} api={api}
        onRetryPending={onRetryPending} onRestorePending={onRestorePending}
        selection={activeSelection?.eventKey === item.key ? activeSelection.model : null}
        activeSelection={activeSelection}
        highlighted={highlighted} highlightedItemKey={highlightedItemKey} selectText={selectText} closeSelection={closeSelection}
        presentation={presentation} />
    );
  }, [session, sessionId, api, onRetryPending, onRestorePending, activeSelection, highlightedItemKey, selectText, closeSelection, presentation]);

  const list = (
    <FlatList
      ref={flatListRef}
      data={items}
      inverted
      extraData={extraData}
      keyExtractor={itemKey}
      renderItem={renderItem}
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
  if (presentation !== 'manuscript') return list;
  return (
    <View style={{ flex: 1 }}>
      {list}
      {showNewMessage && onPressNewMessage ? (
        <View pointerEvents="box-none" style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: t.spacing.sm,
          alignItems: 'center',
        }}>
          <ChatNewMessageButton onPress={onPressNewMessage} />
        </View>
      ) : null}
    </View>
  );
});

interface RowProps {
  item: ChatRenderItem;
  session: Props['session'];
  sessionId: string;
  api: Props['api'];
  onRetryPending: Props['onRetryPending'];
  onRestorePending: Props['onRestorePending'];
  selection: MessageSelectionModel | null;
  activeSelection: { eventKey: string; model: MessageSelectionModel } | null;
  highlighted: boolean;
  highlightedItemKey: string | null;
  selectText(eventKey: string, model: MessageSelectionModel): void;
  closeSelection(): void;
  presentation: 'default' | 'manuscript';
}

const ChatEventRow = memo(function ChatEventRow({
  item, session, sessionId, api, onRetryPending, onRestorePending,
  selection, activeSelection, highlighted, highlightedItemKey, selectText, closeSelection, presentation,
}: RowProps) {
  const t = useTokens();
  if (item.kind === 'typing') return <TypingIndicator session={session}
    {...(presentation === 'manuscript' ? { presentation } : {})} />;
  if (item.kind === 'agent-message-group') {
    return (
      <SearchFocusHighlight active={highlighted}>
        <AgentMessageGroup count={item.events.length}>
          {item.events.map((eventItem) => (
            <ChatEventRow
              key={eventItem.key}
              item={eventItem}
              session={session}
              sessionId={sessionId}
              api={api}
              onRetryPending={onRetryPending}
              onRestorePending={onRestorePending}
              selection={activeSelection?.eventKey === eventItem.key ? activeSelection.model : null}
              activeSelection={activeSelection}
              highlighted={eventItem.key === highlightedItemKey}
              highlightedItemKey={highlightedItemKey}
              selectText={selectText}
              closeSelection={closeSelection}
              presentation={presentation}
            />
          ))}
        </AgentMessageGroup>
      </SearchFocusHighlight>
    );
  }
  if (item.kind === 'activity') return (
    <SearchFocusHighlight active={highlighted}>
      <ManuscriptActivitySegment item={item} sessionId={sessionId} api={api} />
    </SearchFocusHighlight>
  );
  if (item.kind === 'turn-summary') {
    return (
      <SearchFocusHighlight active={highlighted}>
        <TurnSummaryCaption content={item.content} presentation={presentation} />
      </SearchFocusHighlight>
    );
  }
  if (item.kind === 'turn-end-captions') {
    const captions = <TurnEndCaptions
      usage={item.usage}
      turnUsageMode={item.turnUsageMode}
      summaries={item.summaries}
      persistentInstructionRecorded={item.persistentInstructionRecorded}
    />;
    return (
      <SearchFocusHighlight active={highlighted}>
        {item.usage ? (
          <EventContextMenu sessionId={sessionId} event={item.event}>
            {captions}
          </EventContextMenu>
        ) : captions}
      </SearchFocusHighlight>
    );
  }
  if (item.kind === 'turn-usage') {
    return (
      <SearchFocusHighlight active={highlighted}>
        <>
          <EventContextMenu sessionId={sessionId} event={item.event}>
            <TurnUsageCaptionRow
              title={item.title}
              expandedTitle={item.expandedTitle}
              lines={item.lines}
              presentation={presentation}
            />
          </EventContextMenu>
          {item.summaries?.map((summary) => (
            <TurnSummaryCaption
              key={summary.key}
              content={summary.content}
              presentation={presentation}
            />
          ))}
        </>
      </SearchFocusHighlight>
    );
  }
  if (item.kind === 'jev-candidates') {
    return (
      <SearchFocusHighlight active={highlighted}>
        <CollapsibleCaption title={item.title} align="end" alignmentInset={presentation === 'manuscript' ? 'content' : 'avatar'}>
          {item.lines.map((line, index) => <CollapsibleCaptionLine key={`${item.key}-${index}`}>{line}</CollapsibleCaptionLine>)}
        </CollapsibleCaption>
      </SearchFocusHighlight>
    );
  }
  if (item.kind === 'event' && item.event.type === 'generation_started') {
    const label = item.event.data.context_reset === true ? '새 세대 · 문맥 초기화' : '새 세대';
    return <SearchFocusHighlight active={highlighted}><LabeledDivider label={label} alignmentInset={presentation === 'manuscript' ? 'content' : 'avatar'}
      {...(presentation === 'manuscript' ? { lineColor: t.persistentSession.line } : {})} /></SearchFocusHighlight>;
  }
  if (item.kind === 'tool') {
    return (
      <SearchFocusHighlight active={highlighted}>
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
              presentation={presentation}
            />
          </EventContextMenu>
          {item.summaries?.map((summary) => (
            <TurnSummaryCaption
              key={summary.key}
              content={summary.content}
              presentation={presentation}
            />
          ))}
        </>
      </SearchFocusHighlight>
    );
  }
  const selectionModel = createMessageSelectionModel(item.event);
  const selectionActive =
    selection !== null;
  return (
    <SearchFocusHighlight active={highlighted}>
      <>
        <EventContextMenu
          sessionId={sessionId}
          event={item.event}
          onSelectText={selectionModel
            ? (model) => selectText(item.key, model)
            : undefined}
          selectionActive={selectionActive}
        >
          <EventRenderer
            event={item.event}
            sessionId={sessionId}
            session={session}
            onRetryPending={onRetryPending}
            onRestorePending={onRestorePending}
            presentation={presentation}
            selectionModel={
              selectionActive && selection
                ? selection
                : null
            }
            onSelectionDone={closeSelection}
          />
        </EventContextMenu>
        {item.turnUsageCaption
          ? <TurnUsageCaptionRow
            title={item.turnUsageCaption.title}
            expandedTitle={item.turnUsageCaption.expandedTitle}
            lines={item.turnUsageCaption.lines}
            turnUsageMode={item.turnUsageMode}
            presentation={presentation}
          />
          : null}
        {item.summaries?.map((summary) => (
          <TurnSummaryCaption
            key={summary.key}
            content={summary.content}
            presentation={presentation}
          />
        ))}
      </>
    </SearchFocusHighlight>
  );

});

function TurnUsageCaptionRow({
  title,
  expandedTitle,
  lines,
  turnUsageMode = 'collapsed',
  presentation,
}: {
  title: string;
  expandedTitle?: string;
  lines: string[];
  turnUsageMode?: PersistentTurnUsageMode;
  presentation: 'default' | 'manuscript';
}) {
  const [expanded, setExpanded] = useState(turnUsageMode === 'expanded');
  useEffect(() => setExpanded(turnUsageMode === 'expanded'), [turnUsageMode]);

  return (
    <CollapsibleCaption
      title={title}
      {...(expandedTitle !== undefined ? { expandedTitle } : {})}
      expanded={expanded}
      onExpandedChange={setExpanded}
      alignmentInset={presentation === 'manuscript' ? 'content' : 'avatar'}
    >
      {lines.map((line, index) => (
        <CollapsibleCaptionLine key={`${title}-${index}`} wrap>{line}</CollapsibleCaptionLine>
      ))}
    </CollapsibleCaption>
  );
}

const itemKey = (item: ChatRenderItem) => item.key;

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
