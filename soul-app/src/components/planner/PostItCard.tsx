import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { findNodeHandle, Image, Platform, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { CardDto, CardStatus } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { createPostItRoles, type PostItVariant } from '../../theme/postItRoles';
import { postItActivityText } from '../../lib/postit-activity';
import { BOARD_COLUMNS, BOARD_LONG_PRESS_MS } from '../../lib/card-board-layout';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { AppGlassCard } from '../AppGlassCard';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { GlassButton } from '../GlassSurface';
import { showAppContextMenu } from '../menus/AppContextMenu';
import type { PlannerContextMenuAction } from '../../lib/planner-context-menu-model';
import { resolveSessionAgentLabel, resolveSessionCardAvatar } from '../sessionCardDisplay';
import { CardStatusChip } from './CardRow';
import { CardStatusMenu } from './CardStatusMenu';

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
    ...BOARD_COLUMNS.map(([status, label]) => ({
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
  canPress?(): boolean;
  canOpenContextMenu?(): boolean;
};

type CardMenuState = { entry: 'status' | 'color'; visible: boolean };

/** Foundation typography; paper and spacing scale together, while touch targets stay native. */
export const PostItCard = forwardRef<PostItCardHandle, PostItCardProps>(function PostItCard({
  api, card, variant = 'full', onOpen, boardManaged = false, canPress = () => true, canOpenContextMenu = () => true,
}, ref) {
  const t = useTokens();
  const roles = createPostItRoles(t, variant, card.color ?? 'yellow');
  const openTarget = useRef<View>(null);
  const directHold = useRef(false);
  const suppressDirectPress = useRef(false);
  const returnToContext = useRef(false);
  const [bodyLines, setBodyLines] = useState(roles.bodyLines);
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [requestedStatus, setRequestedStatus] = useState<CardStatus | null>(null);
  const assigned = useSessionStore((state) => card.assigneeSessionId ? state.sessions[card.assigneeSessionId] : undefined);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const identity = {
    agentSessionId: card.assigneeSessionId ?? card.id,
    agentId: assigned?.agentId ?? card.assigneeAgentId,
    agentName: assigned?.agentName,
    agentPortraitUrl: assigned?.agentPortraitUrl ?? (card.nodeId && card.assigneeAgentId
      ? `/api/nodes/${card.nodeId}/agents/${card.assigneeAgentId}/portrait` : null),
  };
  const avatar = resolveSessionCardAvatar(identity, serverUrl);
  const name = card.assigneeKind === 'human' ? card.assigneeUserId ?? '사용자'
    : card.assigneeKind ? resolveSessionAgentLabel(identity) : '담당 미지정';
  const { transition, pending } = useCardTransition(api, card.id);
  const activity = card.latestActivity;
  const body = activity ? postItActivityText(activity) : card.request || '아직 지시나 보고가 없습니다.';
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
          backgroundColor: roles.paper, borderRadius: roles.radius, transform: [{ rotate: `${postItRotation(card.id)}deg` }] }}>
          <Pressable ref={openTarget} testID={`postit-open-${card.id}`} onPress={open} accessibilityLabel={`${card.title} 카드 상세`}
            {...directHoldProps}
            style={{ flex: 1, minHeight: t.hitTarget.min, padding: roles.padding, paddingBottom: roles.padding + roles.footerHeight + roles.gap }}>
            <Text testID={`postit-title-${card.id}`} style={roles.title} numberOfLines={2}>{card.title}</Text>
            <View testID={`postit-body-area-${card.id}`} style={{ marginTop: roles.gap, flex: 1, minHeight: 0, overflow: 'hidden' }}
              onLayout={(event) => setBodyLines(Math.max(1, Math.floor(event.nativeEvent.layout.height / roles.body.lineHeight)))}>
              <Text testID={`postit-body-${card.id}`} style={roles.body} numberOfLines={bodyLines} ellipsizeMode="tail">
                <Text testID={`postit-activity-chip-${card.id}`} style={{ ...roles.label, fontWeight: '600', backgroundColor: roles.colors.surfaceCode }}>
                  {activity?.kind === 'report' ? '[보고]' : '[지시]'}
                </Text>{' '}{body}
              </Text>
            </View>
          </Pressable>
          <View testID={`postit-footer-${card.id}`} style={{ position: 'absolute', bottom: roles.padding, left: roles.padding, right: roles.padding,
            height: roles.footerHeight, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${card.title} 담당 상세`} onPress={open}
              {...directHoldProps}
              style={{ flex: 1, minWidth: 0, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
              {avatar.uri ? <Image source={{ uri: avatar.uri, ...(jwt && avatar.uri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }}
                style={{ width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round }} />
                : <Text style={roles.label}>{card.assigneeKind === 'human' ? '👤' : card.assigneeKind ? '🤖' : '·'}</Text>}
              <Text style={{ ...roles.label, flex: 1, minWidth: 0 }} numberOfLines={1}>{name}</Text>
            </Pressable>
            <CompactTouchTarget testID={`postit-status-${card.id}`} accessibilityRole="button" accessibilityLabel="상태 변경"
              disabled={!api || pending} onPress={openStatusMenu}>
              <CardStatusChip card={card} board colors={roles.colors} />
            </CompactTouchTarget>
            {!api && card.status === 'review' ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round}
              accessibilityLabel="완료" disabled onPress={() => {}} surfaceTestID={`postit-complete-${card.id}`}>
              <Ionicons name="checkmark" size={t.iconSize.standard} color={t.colors.textSecondary} />
            </GlassButton> : card.status === 'review' ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round}
              disabled={pending} accessibilityLabel="완료" surfaceTestID={`postit-complete-${card.id}`} onPress={() => { if (canInteract()) void transition(card, 'done'); }}>
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
