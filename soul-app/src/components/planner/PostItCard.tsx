import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { findNodeHandle, Platform, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { CardStatus } from '../../../../packages/wire-schema/generated/typescript/index';
import type { CardDto } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { createPostItRoles, type PostItVariant } from '../../theme/postItRoles';
import { postItActivityText } from '../../lib/postit-activity';
import { MANUAL_STATUS_COLUMNS, BOARD_LONG_PRESS_MS } from '../../lib/card-board-layout';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { useAgentPortraitResolver } from '../../store/agentPortraitStore';
import { resolveRemoteImageSource } from '../../lib/remote-image';
import { RemoteImage } from '../RemoteImage';
import { AppGlassCard } from '../AppGlassCard';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { GlassButton } from '../GlassSurface';
import { showAppContextMenu } from '../menus/AppContextMenu';
import { withAlphaColor } from '../StatusPulseDecoration';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';
import type { PlannerContextMenuAction } from '../../lib/planner-context-menu-model';
import { resolveSessionAgentLabel, resolveSessionCardAvatar } from '../sessionCardDisplay';
import { CardStatusChip } from './CardRow';
import { CardStatusMenu } from './CardStatusMenu';
import { cardAskPreview, cardProgressText, cardItemDisplayColor, EMPTY_PENDING_ITEM_CONFIRMATIONS, summarizeCardItems } from '../../lib/card-check-item-summary';
import { useCardStore } from '../../store/cardStore';
import { cardDependencyDisplay } from '../../../../packages/wire-schema/src/card_dependency_display';

// 오류 띠 바탕: 종이 다섯 색 모두에서 오류 글자 대비 4.5:1 이상이 나오도록 옅게 둔다(capture-card-dependencies.cjs가 화소로 잰다).
const DEPENDENCY_ERROR_ALPHA = 0.08;

export function postItRotation(id: string) {
  return ((Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5) - 2) * 0.4;
}

function buildPostItContextMenuActions(
  card: CardDto,
  pending: boolean,
  changeColor: () => void,
  selectStatus: (status: CardStatus) => void,
): PlannerContextMenuAction[] {
  return [
    { key: 'copy-id', label: '카드 ID 복사', onSelect: async () => { await Clipboard.setStringAsync(card.id); } },
    { key: 'change-color', label: '카드 색상 변경', separatorBefore: true, disabled: pending,
      disabledReason: pending ? '카드 변경 중입니다.' : undefined, onSelect: changeColor },
    ...MANUAL_STATUS_COLUMNS.map(([status, label]) => ({
      key: `status-${status}`,
      label,
      separatorBefore: status === 'todo',
      disabled: pending,
      disabledReason: pending ? '카드 변경 중입니다.' : undefined,
      onSelect: () => selectStatus(status),
    })),
  ];
}

export interface PostItCardHandle {
  openContextMenu(): void;
}

type PostItCardProps = {
  api: ApiClient | null;
  card: CardDto;
  variant?: PostItVariant;
  onOpen(target?: number): void;
  boardManaged?: boolean;
  alignPaper?: boolean;
  canPress?(): boolean;
  canOpenContextMenu?(): boolean;
};

type CardMenuState = { entry: 'status' | 'color'; visible: boolean };

/** Foundation typography; paper and spacing scale together, while touch targets stay native. */
export const PostItCard = forwardRef<PostItCardHandle, PostItCardProps>(function PostItCard({
  api, card, variant = 'full', onOpen, boardManaged = false, alignPaper = false, canPress = () => true, canOpenContextMenu = () => true,
}, ref) {
  const t = useTokens();
  const roles = createPostItRoles(t, variant, card.color ?? 'yellow');
  const rotation = postItRotation(card.id);
  const angle = rotation * Math.PI / 180;
  // Keep the rotated paper's visible left edge on its lane's content line.
  const alignment = alignPaper ? (Math.abs(Math.cos(angle)) * roles.width + Math.abs(Math.sin(angle)) * roles.height - roles.width) / 2 : 0;
  const openTarget = useRef<View>(null);
  const directHold = useRef(false);
  const suppressDirectPress = useRef(false);
  const returnToContext = useRef(false);
  const [bodyLines, setBodyLines] = useState(roles.bodyLines);
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [requestedStatus, setRequestedStatus] = useState<CardStatus | null>(null);
  const assigned = useSessionStore((state) => card.assigneeSessionId ? state.sessions[card.assigneeSessionId] : undefined);
  const pendingItemConfirmations = useCardStore((state) => state.pendingItemConfirmations[card.id] ?? EMPTY_PENDING_ITEM_CONFIRMATIONS);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const portraits = useAgentPortraitResolver();
  const identity = {
    agentSessionId: card.assigneeSessionId ?? card.id,
    agentId: assigned?.agentId ?? card.assigneeAgentId,
    agentName: assigned?.agentName,
    agentPortraitUrl: portraits.forSession(assigned?.agentPortraitUrl, assigned?.agentId ?? card.assigneeAgentId) || null,
  };
  const avatar = resolveSessionCardAvatar(identity, serverUrl);
  const name = card.assigneeKind === 'human' ? card.assigneeUserId ?? '사용자'
    : card.assigneeKind ? resolveSessionAgentLabel(identity) : '담당 미지정';
  const { transition, pending } = useCardTransition(api, card.id);
  const activity = card.latestActivity;
  const displayTitle = card.number == null ? card.title : `#${card.number} ${card.title}`;
  const body = activity ? postItActivityText(activity) : card.request || '아직 지시나 보고가 없습니다.';
  const itemSummary = summarizeCardItems(card.items, pendingItemConfirmations);
  const askPreview = cardAskPreview(itemSummary.needsReview, card.now?.ask);
  // 선행 대기·멈춤 문구는 같은 자리의 「볼 것 N」과 ask를 대신한다(웹 PostItCard와 같은 판정).
  const dependency = cardDependencyDisplay(card.status, card.dependsOn);
  const bandLines = variant === 'compact' ? 1 : 2;
  const dependencyReservedLines = dependency ? Math.ceil((roles.label.lineHeight * bandLines + t.uiSpacing.xs * 2) / roles.body.lineHeight) : 0;
  const canInteract = () => canPress() && !suppressDirectPress.current;
  const open = () => {
    if (!canInteract()) return;
    onOpen(Platform.OS === 'web' ? undefined : findNodeHandle(openTarget.current) ?? undefined);
  };
  const showCardContextMenu = () => {
    if (!api) return;
    const actions = buildPostItContextMenuActions(card, pending,
      () => { setRequestedStatus(null); setMenu({ entry: 'color', visible: true }); }, selectStatus);
    showAppContextMenu(actions, card.title);
  };
  const closeMenu = () => {
    returnToContext.current = false;
    setMenu(null);
    setRequestedStatus(null);
  };
  const selectStatus = (status: CardStatus) => {
    setRequestedStatus(status);
    setMenu({ entry: 'status', visible: false });
  };
  const openContextMenu = () => {
    if (!api || !canOpenContextMenu()) return;
    showCardContextMenu();
  };
  useImperativeHandle(ref, () => ({ openContextMenu }), [api, card.id, card.title, pending, canOpenContextMenu]);
  const openStatusMenu = () => {
    if (!api || !canInteract() || pending) return;
    returnToContext.current = false;
    setRequestedStatus(null);
    setMenu({ entry: 'status', visible: true });
  };
  const openContextColorBack = () => {
    returnToContext.current = true;
    setMenu((current) => current ? { ...current, visible: false } : null);
  };
  const menuDismissed = () => {
    if (!returnToContext.current) return;
    returnToContext.current = false;
    setMenu(null);
    requestAnimationFrame(openContextMenu);
  };
  const onDirectLongPress = () => { directHold.current = true; };
  const onDirectRelease = () => {
    if (!directHold.current) return;
    directHold.current = false;
    suppressDirectPress.current = true;
    requestAnimationFrame(() => {
      openContextMenuAfterHold();
      requestAnimationFrame(() => { suppressDirectPress.current = false; });
    });
  };
  const openContextMenuAfterHold = () => {
    showCardContextMenu();
  };
  const directHoldProps = boardManaged ? {} : {
    delayLongPress: BOARD_LONG_PRESS_MS,
    onLongPress: onDirectLongPress,
    onPressOut: onDirectRelease,
  };
  return <>
    <View accessible={false}>
      <AppGlassCard role="canvas" cornerRadius={roles.radius}>
        <View testID={`postit-card-${card.id}`} style={{ width: roles.width, height: roles.height, flexShrink: 0,
          backgroundColor: roles.paper, borderRadius: roles.radius, transform: [...(alignPaper ? [{ translateX: alignment }] : []), { rotate: `${rotation}deg` }] }}>
          <Pressable ref={openTarget} testID={`postit-open-${card.id}`} onPress={open} accessibilityLabel={`${displayTitle} 카드 상세`}
            {...directHoldProps}
            style={{ flex: 1, minHeight: t.hitTarget.min, padding: roles.padding, paddingBottom: roles.padding + roles.footerHeight + roles.gap }}>
            <Text testID={`postit-title-${card.id}`} style={roles.title} numberOfLines={2}>{displayTitle}</Text>
            <View testID={`postit-body-area-${card.id}`} style={{ marginTop: roles.gap, flex: 1, minHeight: 0, overflow: 'hidden' }}
              onLayout={(event) => setBodyLines(Math.max(1, Math.floor(event.nativeEvent.layout.height / roles.body.lineHeight)))}>
              {itemSummary.total ? <View testID={`postit-${card.id}-item-summary`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs }}>
                {itemSummary.unconfirmed.map((item) => <View key={item.id} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                  style={{ width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.capsule,
                    backgroundColor: cardItemDisplayColor(item.display, t.colors) }} />)}
                {cardProgressText(itemSummary) ? <Text style={roles.label} accessibilityLabel={cardProgressText(itemSummary)}>{cardProgressText(itemSummary)}</Text> : null}
              </View> : null}
              <Text testID={`postit-body-${card.id}`} style={roles.body} numberOfLines={card.now ? 1 : Math.max(1, bodyLines - (itemSummary.total ? 1 : 0) - dependencyReservedLines)} ellipsizeMode="tail">
                {card.now?.text ? card.now.text : <>
                  <Text testID={`postit-activity-chip-${card.id}`} style={{ ...roles.label, fontWeight: '600', backgroundColor: roles.colors.surfaceCode }}>
                    {activity?.kind === 'report' ? '[보고]' : '[지시]'}
                  </Text>{' '}{body}
                </>}
              </Text>
              {dependency ? <Text testID={`postit-${card.id}-dependency`} accessibilityLabel={dependency.text} numberOfLines={bandLines} ellipsizeMode="tail"
                style={{ ...roles.label,
                  // 가로 여백은 배경 상자가 있는 오류 톤에만 둔다. 중립 띠는 제목·본문과 같은 시작선에 놓는다.
                  ...(dependency.tone === 'error' ? { color: roles.colors.errorText, backgroundColor: withAlphaColor(roles.colors.error, DEPENDENCY_ERROR_ALPHA), paddingHorizontal: t.uiSpacing.sm } : {}),
                  borderRadius: t.radius.floor, paddingVertical: t.uiSpacing.xs }}>{dependency.text}</Text>
              : card.now?.turn === 'user' && askPreview ? <Text testID={`postit-${card.id}-ask-preview`} accessibilityLabel={askPreview} numberOfLines={variant === 'compact' ? 1 : 2} ellipsizeMode="tail"
                style={{ ...roles.label, color: roles.body.color, backgroundColor: withAlphaColor(roles.colors.warning, 0.12), borderRadius: t.radius.floor, paddingHorizontal: t.uiSpacing.sm, paddingVertical: t.uiSpacing.xs }}>
                {itemSummary.needsReview ? <Text style={{ color: roles.colors.warningText, fontWeight: '700' }}>볼 것 {itemSummary.needsReview}</Text> : null}{card.now.ask ? `${itemSummary.needsReview ? ' ' : ''}${card.now.ask}` : ''}
              </Text> : null}
            </View>
          </Pressable>
          <View testID={`postit-footer-${card.id}`} style={{ position: 'absolute', bottom: roles.padding, left: roles.padding, right: roles.padding,
            height: roles.footerHeight, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${card.title} 담당 상세`} onPress={open}
              {...directHoldProps}
              style={{ flex: 1, minWidth: 0, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
              {avatar.uri ? <RemoteImage source={resolveRemoteImageSource(avatar.uri, serverUrl, jwt)}
                style={{ width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.capsule }} />
                : <Text style={roles.label}>{card.assigneeKind === 'human' ? '👤' : card.assigneeKind ? '🤖' : '·'}</Text>}
              <Text style={{ ...roles.label, flex: 1, minWidth: 0 }} numberOfLines={1}>{name}</Text>
            </Pressable>
            <CompactTouchTarget testID={`postit-status-${card.id}`} accessibilityRole="button" accessibilityLabel="상태 변경"
              disabled={!api || pending} onPress={openStatusMenu}>
              <CardStatusChip card={card} board colors={roles.colors} />
            </CompactTouchTarget>
            {!api && card.status === 'review' ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.capsule}
              accessibilityLabel="완료" disabled onPress={() => {}} surfaceTestID={`postit-complete-${card.id}`}>
              <Ionicons name="checkmark" size={t.iconSize.standard} color={t.colors.textSecondary} />
            </GlassButton> : card.status === 'review' ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.capsule}
              busy={pending} accessibilityLabel="완료" surfaceTestID={`postit-complete-${card.id}`} onPress={() => { if (canInteract()) void transition(card, 'done'); }}>
              <Ionicons name="checkmark" size={t.iconSize.standard} color={t.colors.textSecondary} />
            </GlassButton> : null}
          </View>
        </View>
      </AppGlassCard>
    </View>
    {menu || requestedStatus ? <CardStatusMenu api={api} card={card} entry={menu?.entry ?? 'status'} visible={menu?.visible ?? false}
      requestedStatus={requestedStatus ?? undefined} onClose={closeMenu}
      onBack={menu?.entry === 'color' ? openContextColorBack : undefined} onDismiss={menuDismissed} /> : null}
  </>;
});
