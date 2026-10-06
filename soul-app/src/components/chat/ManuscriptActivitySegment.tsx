import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ToolTraceResponse } from '../../api/client';
import { createSessionVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { DisclosureIcon } from '../DisclosureIcon';
import { EventContextMenu } from '../events/EventContextMenu';
import { ThinkingEvent } from '../events/ThinkingEvent';
import { ToolEvent } from '../events/ToolEvent';
import { getChatRowHorizontalInset } from './ChatBody.styles';
import type { ManuscriptActivityEntry, ManuscriptActivityRenderItem } from './manuscriptActivityProjection';

interface Props {
  item: ManuscriptActivityRenderItem;
  sessionId: string;
  api: { getTimelineTrace: (sessionId: string, timelineId: string) => Promise<ToolTraceResponse> } | null;
}

export function ManuscriptActivitySegment({ item, sessionId, api }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [expanded, setExpanded] = useState(false);
  const tools = item.items.filter(
    (entry): entry is Extract<ManuscriptActivityEntry, { kind: 'tool' }> => entry.kind === 'tool',
  );
  const failedCount = tools.filter((entry) => (entry.result?.data as any)?.is_error === true).length;
  const hasRunningTool = tools.some((entry) => !entry.result);

  return (
    <View style={styles.row}>
      <TouchableOpacity
        testID="manuscript-activity-toggle"
        accessibilityRole="button"
        accessibilityLabel={[
          `도구 ${tools.length}회`,
          ...(hasRunningTool ? ['실행 중'] : []),
          ...(failedCount > 0 ? [`실패 ${failedCount}`] : []),
        ].join(', ')}
        accessibilityState={{ expanded }}
        style={styles.header}
        activeOpacity={0.7}
        onPress={() => setExpanded((value) => !value)}
      >
        <Ionicons
          testID="manuscript-activity-icon"
          name="construct-outline"
          size={t.iconSize.standard}
          color={t.colors.textSecondary}
        />
        <Text style={styles.title} numberOfLines={1}>도구 {tools.length}회</Text>
        {hasRunningTool ? <Text style={styles.status}>실행 중</Text> : null}
        {failedCount > 0 ? <Text style={styles.failure}>실패 {failedCount}</Text> : null}
        <DisclosureIcon expanded={expanded} tone="secondary" />
      </TouchableOpacity>
      {expanded ? (
        <View testID="manuscript-activity-items">
          {item.items.map((entry) => entry.kind === 'tool' ? (
            <EventContextMenu
              key={entry.key}
              sessionId={sessionId}
              event={entry.start}
              resultEvent={entry.result}
            >
              <ToolEvent
                start={entry.start}
                result={entry.result}
                sessionId={sessionId}
                api={api}
                presentation="manuscript"
              />
            </EventContextMenu>
          ) : (
            <ThinkingEvent key={entry.key} event={entry.event} presentation="manuscript" />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const sessionRoles = createSessionVisualRoles(t);
  return StyleSheet.create({
    row: {
      marginLeft: 0,
      marginRight: getChatRowHorizontalInset(t, 'manuscript'),
      marginVertical: sessionRoles.chat.messageGap / 2,
    },
    header: {
      minHeight: t.hitTarget.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
    },
    title: {
      flexShrink: 1,
      color: t.colors.textSecondary,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
    status: {
      color: t.colors.textSecondary,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
    failure: {
      color: t.colors.errorText,
      fontSize: t.chatFontSize.meta,
      lineHeight: t.chatFontSize.meta * t.lineHeightRatio,
    },
  });
}
