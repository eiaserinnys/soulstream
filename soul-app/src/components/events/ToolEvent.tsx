import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { SessionEvent } from '../../api/types';
import type { ToolTraceResponse } from '../../api/client';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';

interface Props {
  /** 도구 호출 이벤트 (event_type === 'tool_start'). 항상 존재한다. */
  start: SessionEvent;
  /** 매칭되는 결과 이벤트 (event_type === 'tool_result'). 아직 도착 전이면 undefined. */
  result?: SessionEvent;
  sessionId?: string;
  api?: {
    getTimelineTrace: (
      sessionId: string,
      timelineId: string,
    ) => Promise<ToolTraceResponse>;
  } | null;
}

/**
 * 도구 호출 + 결과를 한 카드로 묶어 표시한다.
 *
 * 빌드 13까지는 tool_start와 tool_result가 별개 카드로 흐름에 누적됐고,
 * REST messages 정규화에서 payload.type('tool_use'/'tool_result')을 쓰는 바람에
 * EventRenderer의 'tool_start' 케이스를 못 맞춰 ToolEvent에 도달하지도 못했다.
 *
 * 빌드 14:
 * - 부모(ChatScreen)가 tool_start와 매칭되는 tool_result를 페어링하여 둘을 함께 전달.
 * - 헤더는 도구명 + input preview + 결과 상태 아이콘.
 * - 펼침 시 input과 result를 위아래로 보여준다.
 */
export function ToolEvent({ start, result, sessionId, api }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const toolRole = createSessionVisualRoles(t).chat.tool;

  const [expanded, setExpanded] = useState(false);
  const [headerPressed, setHeaderPressed] = useState(false);
  const [trace, setTrace] = useState<ToolTraceResponse | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState(false);

  const startData = start.data as any;
  const resultData = result?.data as any;
  const traceId = startData?.timeline_id ?? resultData?.timeline_id;

  // 서버 페이로드 실측 (orch-server messages REST):
  //   tool_start: { type, timestamp, tool_name, tool_input, tool_use_id, parent_event_id }
  //                                                                       ^^^^^^^^^^^^^^^
  //                                          wire 호환성 보존 — FE 평면 모델에서 미사용
  //                                          (soulstream Phase 2-A atom 260507.01)
  //   tool_result: { type, result, is_error, timestamp, tool_name, tool_use_id }
  // 빌드 14까지는 클라이언트가 name/input/content 키를 읽어 모두 빈 값으로 보였음.
  const toolName: string = startData?.tool_name ?? startData?.name ?? '도구';

  const inputText = useMemo(
    () => formatBody(trace?.input ?? startData?.tool_input ?? startData?.input),
    [trace, startData]
  );
  const resultText = useMemo(
    () =>
      formatBody(
        trace?.result ?? resultData?.result ?? resultData?.content ?? resultData?.output,
      ),
    [trace, resultData]
  );
  const progressText = useMemo(() => formatProgress(trace), [trace]);

  const loadTrace = useCallback(async () => {
    if (!api || !sessionId || !traceId || trace || traceLoading) return;
    setTraceLoading(true);
    setTraceError(false);
    try {
      setTrace(await api.getTimelineTrace(sessionId, String(traceId)));
    } catch {
      setTraceError(true);
    } finally {
      setTraceLoading(false);
    }
  }, [api, sessionId, traceId, trace, traceLoading]);

  const isError = resultData?.is_error === true;
  const statusIcon = !result ? 'time-outline' : isError ? 'close-circle' : 'checkmark-circle';
  const statusLabel = !result ? '실행 중' : isError ? '오류' : '완료';
  const statusColor = !result ? t.colors.warning : isError ? t.colors.error : t.colors.success;

  // 헤더 우측 한 줄 미리보기 — 공백/줄바꿈을 단일 공백으로 압축한 뒤 그대로 넘긴다.
  // 빌드 18: 임의 60자 cap을 제거 — RN <Text numberOfLines={1}>이 실제 사용 가능 폭에 맞춰
  // 자동으로 truncate한다. iPad 가로 모드의 넓은 폭에서도 끝까지 활용된다.
  const previewLine = useMemo(() => {
    const src = inputText || resultText;
    if (!src) return '';
    return src.replace(/\s+/g, ' ').trim();
  }, [inputText, resultText]);

  return (
    <View testID="tool-event-row-slot" style={styles.rowSlot}>
      <View
        testID="tool-event-wrapper"
        style={[
          styles.wrapper,
          !expanded && styles.wrapperCollapsed,
          isError && styles.wrapperError,
          headerPressed && styles.wrapperPressed,
        ]}
      >
        <View testID="tool-event-header-visual" style={styles.header}>
          <Ionicons
            testID="tool-event-state-icon"
            name={statusIcon as never}
            size={toolRole.stateIconSize}
            color={statusColor}
          />
          <Text
            style={[styles.name, !previewLine && styles.nameOnly]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {toolName}
          </Text>
          {previewLine ? (
            <Text style={styles.preview} numberOfLines={1} ellipsizeMode="tail">
              {previewLine}
            </Text>
          ) : null}
          <Ionicons
            testID="tool-event-chevron"
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={toolRole.chevronSize}
            color={t.colors.textPlaceholder}
          />
        </View>
        {expanded && (
          <View testID="tool-event-body" style={styles.body}>
            <Text style={styles.sectionLabel}>입력</Text>
            {inputText ? (
              <Text style={styles.code}>{inputText}</Text>
            ) : (
              <Text style={styles.empty}>없음</Text>
            )}
            <Text style={[styles.sectionLabel, { marginTop: t.spacing.sm }]}>
              결과{!result ? ' (대기 중)' : isError ? ' (오류)' : ''}
            </Text>
            {resultText ? (
              <Text style={styles.code}>{resultText}</Text>
            ) : (
              <Text style={styles.empty}>
                {result ? '없음' : '아직 도착하지 않음'}
              </Text>
            )}
            {traceLoading ? (
              <Text style={[styles.empty, { marginTop: t.spacing.sm }]}>상세 불러오는 중...</Text>
            ) : null}
            {traceError ? (
              <CompactTouchTarget
                testID="tool-event-retry-touch"
                accessibilityRole="button"
                accessibilityLabel="도구 상세 다시 불러오기"
                frameStyle={styles.retryTouchFrame}
                onPress={loadTrace}
                activeOpacity={0.7}
              >
                <Text style={[styles.retry, { marginTop: t.spacing.sm }]}>
                  상세 로드 실패. 다시 시도
                </Text>
              </CompactTouchTarget>
            ) : null}
            {progressText ? (
              <>
                <Text style={[styles.sectionLabel, { marginTop: t.spacing.sm }]}>진행 로그</Text>
                <Text style={styles.code}>{progressText}</Text>
              </>
            ) : null}
          </View>
        )}
      </View>
      <TouchableOpacity
        testID="tool-event-header-touch"
        style={styles.headerTouchOverlay}
        accessibilityRole="button"
        accessibilityLabel={`${toolName}, ${statusLabel}${previewLine ? `, ${previewLine}` : ''}`}
        accessibilityState={{ expanded }}
        onPressIn={() => setHeaderPressed(true)}
        onPressOut={() => setHeaderPressed(false)}
        onPress={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) void loadTrace();
        }}
        activeOpacity={0.7}
      />
    </View>
  );
}

/**
 * 도구의 input/output 값을 표시 가능한 문자열로 정규화한다.
 * - 문자열: 그대로
 * - 배열/객체: JSON.stringify (들여쓰기 2)
 * - null/undefined/빈 객체: 빈 문자열
 */
function formatBody(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    if (!Array.isArray(raw) && Object.keys(raw as object).length === 0) return '';
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

function formatProgress(trace: ToolTraceResponse | null): string {
  if (!trace?.progress?.length) return '';
  return trace.progress
    .map((event) => {
      const payload = event.payload as any;
      return typeof payload?.text === 'string'
        ? payload.text
        : typeof payload?.message === 'string'
          ? payload.message
          : '';
    })
    .filter(Boolean)
    .join('\n');
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  const sessionRoles = createSessionVisualRoles(t);
  const toolVisualHeight = sessionRoles.chat.tool.visualMinHeight;
  const touchInsetTop = Math.max(0, t.hitTarget.min - toolVisualHeight);
  return StyleSheet.create({
    rowSlot: {
      // 빌드 17: 좌측 들여쓰기를 어시스턴트 말풍선의 본문 시작 지점에 정렬한다
      // (avatar 32pt + gap 8pt + spacing.md). 우측 마진은 일반 메시지와 동일.
      marginLeft: t.assistantBubbleIndent,
      marginRight: t.spacing.md,
      minHeight: t.hitTarget.min,
      paddingTop: touchInsetTop,
      marginBottom: sessionRoles.chat.tool.rowGap - touchInsetTop,
      position: 'relative',
    },
    wrapper: {
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
      backgroundColor: c.surfaceMuted,
    },
    wrapperCollapsed: { height: toolVisualHeight },
    wrapperError: { backgroundColor: c.errorBg },
    wrapperPressed: { opacity: 0.7 },
    headerTouchOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      zIndex: 1,
    },
    header: {
      width: '100%',
      minHeight: sessionRoles.chat.tool.visualMinHeight,
      height: toolVisualHeight,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: sessionRoles.chat.tool.paddingHorizontal,
      paddingVertical: sessionRoles.chat.tool.paddingVertical,
      gap: sessionRoles.chat.tool.gap,
    },
    name: {
      maxWidth: '36%',
      minWidth: 0,
      flexShrink: 1,
      color: c.textSecondary,
      fontSize: sessionRoles.chat.tool.fontSize,
      lineHeight: sessionRoles.chat.tool.lineHeight,
      fontWeight: '600',
    },
    nameOnly: { maxWidth: '100%', flex: 1 },
    preview: {
      flex: 1,
      minWidth: 0,
      color: c.textMuted,
      fontSize: sessionRoles.chat.tool.fontSize,
      lineHeight: sessionRoles.chat.tool.lineHeight,
      fontWeight: '400',
    },
    body: {
      backgroundColor: c.surfaceCode,
      padding: sessionRoles.chat.tool.bodyPadding,
    },
    sectionLabel: {
      color: c.textMuted,
      fontSize: t.chatFontSize.meta,
      fontWeight: '600',
      marginBottom: t.spacing.xs,
    },
    code: {
      color: c.codeText,
      fontFamily: 'Courier',
      fontSize: sessionRoles.chat.tool.codeFontSize,
      lineHeight: sessionRoles.chat.tool.codeLineHeight,
    },
    empty: {
      color: c.textPlaceholder,
      fontSize: t.chatFontSize.meta,
      fontStyle: 'italic',
    },
    retry: {
      color: c.errorText,
      fontSize: t.chatFontSize.meta,
      fontWeight: '600',
    },
    retryTouchFrame: { alignSelf: 'flex-start' },
  });
}
