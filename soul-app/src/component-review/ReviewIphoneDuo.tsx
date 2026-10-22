import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTokens } from '../theme';
import { SessionCardView } from '../components/SessionCardView';
import { PhoneRailTabCluster } from '../navigation/TabNavigator';
import { FolderWorkspaceSinglePanel } from '../components/planner/FolderWorkspaceReadOverlay';
import { getFolderWorkspaceOverlayWidth, shouldUseSinglePanel } from '../lib/folder-workspace-layout';
import { dialogueSessions } from './dialogue-fixtures';

/**
 * 아이폰 듀오 6개 창 크기에서 새 반응형 규칙을 실제 컴포넌트로 보여 준다.
 * - 오른쪽 시스템 레일(84pt)이 있는 프레임은 세로 탭 클러스터를 레일 하단에 둔다.
 * - 피드 폭 400pt 미만은 카드가 시간을 identity 행으로 옮긴다.
 * - 오버레이 폭 640pt 미만은 상세/대화 단일 열이다.
 */
const DUO_RAIL_WIDTH = 84;
const STAGE_PADDING = 20;

export const IPHONE_DUO_FRAMES = [
  { id: 'outer-portrait', label: '바깥 세로', width: 466, height: 678, rail: false },
  { id: 'outer-landscape', label: '바깥 가로', width: 678, height: 466, rail: false },
  { id: 'inner-portrait', label: '안쪽 세로', width: 669, height: 951, rail: false },
  { id: 'inner-landscape', label: '안쪽 가로', width: 951, height: 669, rail: true },
  { id: 'inner-portrait-short', label: '안쪽 세로(높이 890)', width: 626, height: 890, rail: false },
  { id: 'inner-landscape-short', label: '안쪽 가로(높이 626)', width: 890, height: 626, rail: true },
] as const;

export function ReviewIphoneDuo() {
  const t = useTokens();
  const session = dialogueSessions[0];
  return (
    <View testID="review-iphone-duo" style={{ flex: 1, backgroundColor: t.colors.background }}>
      <ScrollView horizontal contentContainerStyle={{ padding: t.spacing.lg, gap: t.spacing.lg }}>
        {IPHONE_DUO_FRAMES.map((frame) => {
          const contentWidth = frame.width - (frame.rail ? DUO_RAIL_WIDTH : 0);
          const feedWidth = contentWidth - STAGE_PADDING * 2;
          const overlayWidth = getFolderWorkspaceOverlayWidth(contentWidth);
          return (
            <View key={frame.id} style={{ gap: t.spacing.sm }}>
              <View style={{ gap: 2 }}>
                <Text style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary }}>
                  {frame.label}
                </Text>
                <Text testID={`iphone-duo-frame-${frame.id}`}
                  style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>
                  {frame.width} × {frame.height} · 레일 {frame.rail ? DUO_RAIL_WIDTH : 0} · 피드 {feedWidth} · 오버레이 {overlayWidth}
                </Text>
              </View>
              <View
                testID={`iphone-duo-stage-${frame.id}`}
                style={{
                  width: frame.width,
                  height: frame.height,
                  flexDirection: 'row',
                  borderRadius: t.foundation.radius.panel,
                  borderWidth: 1,
                  borderColor: t.colors.border,
                  backgroundColor: t.colors.background,
                  overflow: 'hidden',
                }}
              >
                <View style={{ flex: 1, padding: STAGE_PADDING, gap: t.uiSpacing.sm }}>
                  <SessionCardView
                    session={session}
                    onPress={() => {}}
                    folderName="공개 폴더"
                    serverUrl=""
                    jwt={null}
                    review={{ acknowledge: async () => {}, inFlight: false }}
                    narrow={feedWidth < 400}
                    embedded
                    testID={`iphone-duo-card-${frame.id}`}
                  />
                  {frame.rail || frame.id.startsWith('inner') ? (
                    <View style={{ flex: 1, minHeight: 0, width: overlayWidth }}>
                      <FolderWorkspaceSinglePanel
                        api={null}
                        cardId={null}
                        pageId={null}
                        sessionId={null}
                        active
                        onClose={() => {}}
                      />
                    </View>
                  ) : null}
                  {shouldUseSinglePanel(overlayWidth) ? null : (
                    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>
                      2열 오버레이(상세 + 대화)
                    </Text>
                  )}
                </View>
                {frame.rail ? (
                  <View style={{
                    width: DUO_RAIL_WIDTH,
                    paddingBottom: 24,
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    borderLeftWidth: 1,
                    borderLeftColor: t.colors.border,
                  }}>
                    <PhoneRailTabCluster active="DailyTab" onSelect={() => {}} />
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
