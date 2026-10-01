import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { createPostItRoles, type PostItVariant } from '../../theme/postItRoles';
import { postItActivityText } from '../../lib/postit-activity';
import { useCardTransition } from '../../hooks/useCardTransition';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAuthStore } from '../../store/authStore';
import { AppGlassCard } from '../AppGlassCard';
import { GlassButton } from '../GlassSurface';
import { resolveSessionAgentLabel, resolveSessionCardAvatar } from '../sessionCardDisplay';
import { CardStatusChip } from './CardRow';

export function postItRotation(id: string) {
  return ((Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5) - 2) * 0.4;
}

/** Shared paper presentation. Compact changes paper tracks, never scales text or touch targets. */
export function PostItCard({ api, card, variant = 'full', onOpen, onMenu }: {
  api: ApiClient | null; card: CardDto; variant?: PostItVariant; onOpen(): void; onMenu?(): void;
}) {
  const t = useTokens();
  const roles = createPostItRoles(t, variant);
  const assigned = useSessionStore((state) => card.assigneeSessionId ? state.sessions[card.assigneeSessionId] : undefined);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const identity = { agentSessionId: card.assigneeSessionId ?? card.id, agentId: assigned?.agentId ?? card.assigneeAgentId,
    agentName: assigned?.agentName, agentPortraitUrl: assigned?.agentPortraitUrl ?? (card.nodeId && card.assigneeAgentId ? `/api/nodes/${card.nodeId}/agents/${card.assigneeAgentId}/portrait` : null) };
  const avatar = resolveSessionCardAvatar(identity, serverUrl);
  const name = card.assigneeKind === 'human' ? card.assigneeUserId ?? '사용자'
    : card.assigneeKind ? resolveSessionAgentLabel(identity) : '담당 미지정';
  const { transition, pending } = useCardTransition(api, card.id);
  const activity = card.latestActivity;
  const body = activity ? postItActivityText(activity) : card.request || '아직 지시나 보고가 없습니다.';
  return <AppGlassCard role="canvas" cornerRadius={roles.radius}>
    <View testID={`postit-card-${card.id}`} style={{ width: roles.width, height: roles.height, flexShrink: 0,
      backgroundColor: roles.paper, borderRadius: roles.radius, transform: [{ rotate: `${postItRotation(card.id)}deg` }] }}>
      <Pressable testID={`postit-open-${card.id}`} onPress={onOpen} accessibilityLabel={`${card.title} 카드 상세`}
        style={{ flex: 1, minHeight: t.hitTarget.min, padding: roles.padding }}>
        <Text testID={`postit-title-${card.id}`} style={{ ...roles.title, height: roles.title.lineHeight * 2 }} numberOfLines={2}>{card.title}</Text>
        <Text testID={`postit-label-${card.id}`} style={{ ...roles.label, marginTop: roles.gap }} numberOfLines={1}>
          {activity?.kind === 'report' ? '마지막 보고' : '마지막 지시'}
        </Text>
        <Text testID={`postit-body-${card.id}`} style={{ ...roles.body, marginTop: roles.gap }} numberOfLines={roles.bodyLines}>{body}</Text>
      </Pressable>
      <View testID={`postit-footer-${card.id}`} style={{ position: 'absolute', bottom: roles.padding, left: roles.padding, right: roles.padding,
        height: roles.footerHeight, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
        <Pressable accessibilityLabel={`${card.title} 담당과 상태 상세`} onPress={onOpen}
          style={{ flex: 1, minWidth: 0, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
          {avatar.uri ? <Image source={{ uri: avatar.uri, ...(jwt && avatar.uri.startsWith(serverUrl) ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }}
            style={{ width: t.avatarSize.compact, height: t.avatarSize.compact, borderRadius: t.foundation.radius.round }} />
            : <Text style={roles.label}>{card.assigneeKind === 'human' ? '👤' : card.assigneeKind ? '🤖' : '·'}</Text>}
          <Text style={{ ...roles.label, flex: 1, minWidth: 0 }} numberOfLines={1}>{name}</Text>
          <CardStatusChip card={card} board />
        </Pressable>
        {onMenu ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round} disabled={pending || !api}
          accessibilityLabel={`${card.title} 상태 메뉴`} onPress={onMenu}><Ionicons name="ellipsis-horizontal" size={t.iconSize.standard} color={t.colors.textSecondary} /></GlassButton>
          : card.status === 'review' ? <GlassButton iconOnly size="compact" borderRadius={t.foundation.radius.round} disabled={pending || !api}
          accessibilityLabel="완료" surfaceTestID={`postit-complete-${card.id}`} onPress={() => {
            void transition(card, 'done');
          }}><Ionicons name="checkmark" size={t.iconSize.standard} color={t.colors.textSecondary} /></GlassButton> : null}
      </View>
    </View>
  </AppGlassCard>;
}
