import React, { useMemo } from 'react';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { ScrollView, Text, View } from 'react-native';
import { useTokens } from '../theme';
import { SessionCardView } from '../components/SessionCardView';
import { PhoneRailTabCluster } from '../navigation/TabNavigator';
import { PersistentSessionProvider } from '../navigation/PersistentSessionContext';
import {
  CardConversationPane,
  FolderWorkspaceDetailPane,
  FolderWorkspaceSinglePanel,
} from '../components/planner/FolderWorkspaceReadOverlay';
import {
  getFolderWorkspaceOverlayWidth,
  shouldUseSinglePanel,
} from '../lib/folder-workspace-layout';
import { resolvePersistentConversationLeft } from '../lib/persistent-session-column';
import { MainListPane } from '../components/split/MainListPane';
import { calculateTwoPaneWidths } from '../components/split/paneWidths';
import { dialogueSessions } from './dialogue-fixtures';
import { createReviewApi } from './fixtures';

/**
 * 아이폰 듀오 6개 창 크기에서 새 반응형 규칙을 실제 컴포넌트로 보여 준다.
 * - 바깥(5.4형)은 오른쪽 시스템 레일 84pt 위에 세로 탭 클러스터를 둔다.
 * - 안쪽(7.6형)은 태블릿 2단이고, 레일이 있어도 안전 폭만 줄어든다.
 * - 안쪽 세로에서 좁은 헤더·좁은 피드 카드·단일 열 오버레이·PAS 열 이동이 드러난다.
 */
const DUO_RAIL_WIDTH = 84;
const STAGE_PADDING = 20;

export const IPHONE_DUO_FRAMES = [
  { id: 'outer-portrait', label: '바깥 세로', width: 466, height: 678, rail: true, insetRight: DUO_RAIL_WIDTH },
  { id: 'outer-landscape', label: '바깥 가로', width: 678, height: 466, rail: true, insetRight: DUO_RAIL_WIDTH },
  { id: 'inner-portrait', label: '안쪽 세로', width: 669, height: 951, rail: false, insetRight: 0 },
  { id: 'inner-portrait-short', label: '안쪽 세로(높이 890)', width: 626, height: 890, rail: false, insetRight: 0 },
  { id: 'inner-landscape', label: '안쪽 가로', width: 951, height: 669, rail: false, insetRight: DUO_RAIL_WIDTH },
  { id: 'inner-landscape-short', label: '안쪽 가로(높이 626)', width: 890, height: 626, rail: false, insetRight: DUO_RAIL_WIDTH },
] as const;

function PasColumnStrip({ width, left }: { width: number; left: number }) {
  const t = useTokens();
  return <View
    testID={`iphone-duo-pas-strip-${width}`}
    style={{
      width,
      height: 56,
      borderRadius: t.foundation.radius.panel,
      borderWidth: 1,
      borderColor: t.colors.border,
      justifyContent: 'center',
      overflow: 'hidden',
    }}
  >
    <View style={{ position: 'absolute', left, top: 0, bottom: 0, width: 2, backgroundColor: t.colors.accent }} />
    <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted, paddingLeft: t.uiSpacing.sm }}>
      PAS 대화 열 x={left}pt / {width}pt
    </Text>
  </View>;
}

export function ReviewIphoneDuo() {
  const t = useTokens();
  const session = dialogueSessions[0];
  const api = useMemo(() => createReviewApi('normal'), []);
  const navigationTheme = {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: t.colors.background },
  };
  return (
    <NavigationContainer theme={navigationTheme}>
      <PersistentSessionProvider>
        <View testID="review-iphone-duo" style={{ flex: 1, backgroundColor: t.colors.background }}>
          <ScrollView horizontal contentContainerStyle={{ padding: t.spacing.lg, gap: t.spacing.lg }}>
            {IPHONE_DUO_FRAMES.map((frame) => {
              const safeWidth = frame.width - frame.insetRight;
              const bodyWidth = safeWidth - STAGE_PADDING * 2;
              // 실제 2단은 좌우 outerInset(12)을 뺀 행 폭에서 계산한다.
              const middle = calculateTwoPaneWidths(Math.max(0, safeWidth - 24)).middle;
              const overlayWidth = getFolderWorkspaceOverlayWidth(safeWidth);
              const single = shouldUseSinglePanel(overlayWidth);
              const pasLeft = resolvePersistentConversationLeft({
                appWidth: safeWidth,
                columnWidth: frame.id.startsWith('inner-landscape') ? 480 : 400,
                tasksWidth: frame.id.startsWith('inner-landscape') ? 240 : 170,
                phone: false,
                cardsScene: true,
                pageInset: t.foundation.pageInset,
                gap: t.spacing.md,
                cardPanelRightOffset: t.foundation.pageInset - t.uiSpacing.sm,
              });
              return (
                <View key={frame.id} style={{ gap: t.spacing.sm }}>
                  <View style={{ gap: 2 }}>
                    <Text style={{ ...t.foundation.typography.cardTitle, color: t.colors.textPrimary }}>
                      {frame.label}
                    </Text>
                    <Text testID={`iphone-duo-frame-${frame.id}`}
                      style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>
                      {frame.width} × {frame.height} · 레일 {frame.insetRight} · 본문 {safeWidth} · 피드 {bodyWidth} · 오버레이 {overlayWidth}
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
                        narrow={frame.rail ? bodyWidth < 400 : middle < 400}
                        embedded
                        testID={`iphone-duo-card-${frame.id}`}
                      />
                      {frame.rail ? (
                        <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>
                          {frame.id === 'outer-landscape'
                            ? '설정 1열 유지 (SETTINGS_FORM_COLUMNS_MIN_WIDTH = 700)'
                            : '설정 wide 해제 (device = phone)'}
                        </Text>
                      ) : (
                        <>
                          {frame.id.startsWith('inner-portrait') ? (
                            <View style={{ width: middle, height: 200 }}>
                              <MainListPane paneWidth={middle} />
                            </View>
                          ) : null}
                          {single ? (
                            <View style={{ width: overlayWidth, flex: 1, minHeight: 0 }}>
                              <FolderWorkspaceSinglePanel
                                api={api}
                                cardId={null}
                                pageId="public-page"
                                sessionId={session.agentSessionId}
                                active
                                onClose={() => {}}
                              />
                            </View>
                          ) : (
                            <View style={{
                              width: overlayWidth,
                              flex: 1,
                              minHeight: 0,
                              flexDirection: 'row',
                              borderWidth: 1,
                              borderColor: t.colors.border,
                              borderRadius: t.foundation.radius.panel,
                              overflow: 'hidden',
                            }}>
                              <FolderWorkspaceDetailPane
                                api={api}
                                cardId={null}
                                pageId="public-page"
                                sessionId={session.agentSessionId}
                                active
                                width={overlayWidth - Math.round(overlayWidth * 0.5)}
                                onClose={() => {}}
                              />
                              <CardConversationPane active sessionId={session.agentSessionId} />
                            </View>
                          )}
                          <PasColumnStrip width={safeWidth} left={pasLeft} />
                        </>
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
      </PersistentSessionProvider>
    </NavigationContainer>
  );
}
