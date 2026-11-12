// 카드 #1197: 질문 장 「결정 한 장」의 앱 부품. PAS 판 장과 카드 상세 커멘트 탭이 같이 쓴다.
// 선택지는 앱의 AskUserQuestion(ChatInputRequest) 선택지 묶음(옅은 선으로 나눈 행)을 그대로 쓰되,
// 누르면 바로 가므로 동그라미 표시는 두지 않는다.
import React, { useMemo, useSyncExternalStore } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens, type DesignTokens } from '../../theme';
import { cardImageSource } from '../../lib/card-image-source';
import { scopedAttachmentUrl } from '../../lib/attachment-link-view';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { makeChatInputRequestStyles as makeRequestStyles } from '../chat/ChatInputRequest.styles';
import { AttachmentImage } from '../AttachmentImage';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { GlassButton } from '../GlassSurface';
import type { CardQuestionView } from './card-question-viewmodel';

/** 질문 장과 아래 입력창을 잇는 대상. 고칠 점 대상과 같은 자리에 선다. */
export type CardQuestionTarget = { kind: 'ask'; questionId: string } | { kind: 'append'; questionId: string; label: string };
type TargetEntry = { target: CardQuestionTarget | null; focus: number };
const targets = new Map<string, TargetEntry>();
const listeners = new Set<() => void>();
const EMPTY: TargetEntry = { target: null, focus: 0 };
export function setCardQuestionTarget(cardId: string, target: CardQuestionTarget | null, focus = false) {
  const current = targets.get(cardId) ?? EMPTY;
  targets.set(cardId, { target, focus: focus ? current.focus + 1 : current.focus });
  listeners.forEach(listener => listener());
}
export function useCardQuestionTarget(cardId: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => targets.get(cardId) ?? EMPTY, () => EMPTY);
}
export function cardQuestionTargetText(target: CardQuestionTarget) {
  return target.kind === 'ask' ? '되묻기' : `덧붙이기: ${target.label}`;
}
export function cardQuestionPlaceholder(target: CardQuestionTarget | null, open: boolean) {
  return target?.kind === 'ask' ? '물어볼 것' : target?.kind === 'append' ? '덧붙일 말' : open ? '다르게 답하기' : '커멘트';
}

/** 받은 답은 답한 뒤 남은 선택지 행을 흐리게 하는 데 쓴다(기존 흐림 값). */
const DIMMED_OPACITY = 0.45;

export function CardQuestionBody({ view, cardId, portraitUri, userInitial = '나', onChoose, busy = false }: {
  view: CardQuestionView; cardId: string; portraitUri: string | null; userInitial?: string; onChoose(label: string): void; busy?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const requestStyles = useMemo(() => makeRequestStyles(t), [t]);
  const jwt = useAuthStore(state => state.jwt);
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const openContentLink = useOpenContentLink({ type: 'card', id: cardId });
  const images = view.attachments.filter(item => item.type === 'image');
  const links = view.attachments.filter(item => item.type === 'link');
  const imageSources = images.map(item => cardImageSource(
    scopedAttachmentUrl(item.previewUrl ?? item.originalUrl ?? item.url, serverUrl, { type: 'card', id: cardId }),
    serverUrl, jwt));
  const avatar = (author: 'user' | 'agent') => author === 'agent' && portraitUri
    ? <Image source={{ uri: portraitUri, ...(jwt && serverUrl && portraitUri.startsWith(serverUrl)
      ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) }} style={styles.avatar} accessibilityIgnoresInvertColors />
    : <View style={[styles.avatar, styles.avatarFallback]}><Text style={styles.avatarFallbackText}>{author === 'user' ? userInitial : '담'}</Text></View>;
  return <View testID={`card-question-${view.id}`} style={styles.body}>
    <Text selectable style={styles.background}>{view.background}</Text>
    {images.length ? <View style={styles.evidence}>{images.map((item, index) => <View key={`${item.attachment_id ?? item.url}-${index}`} style={styles.imageEvidence}>
      <AttachmentImage accessibilityLabel={item.label || `볼 것 ${index + 1}`} onOpen={undefined}
        unavailableMessage={item.availability === 'missing' ? '찾을 수 없음' : item.availability ? '불러오지 못함' : undefined}
        source={imageSources[index]} sources={imageSources} captions={images.map(image => image.label)}
        index={index} variant="cardCheckItem" />
    </View>)}</View> : null}
    {links.length ? <View style={styles.evidenceLinks}>{links.map((item, index) => <CompactTouchTarget
      key={`${item.attachment_id ?? item.url}-${index}`} accessibilityRole="link" accessibilityLabel={item.label || item.url}
      frameStyle={styles.linkFrame} surfaceStyle={styles.linkSurface} onPress={() => void openContentLink(item.url, item.label)}>
      <View style={styles.linkContent}>
        <Ionicons name="open-outline" size={t.foundation.typography.meta.fontSize} color={t.colors.link} />
        <Text numberOfLines={1} style={styles.linkText}>{item.label || item.url}</Text>
      </View>
    </CompactTouchTarget>)}</View> : null}
    {view.thread.length ? <View testID={`card-question-thread-${view.id}`} style={styles.thread}>
      {view.thread.map(turn => <View key={turn.id} style={styles.turn}>{avatar(turn.author)}
        <Text selectable style={styles.turnText}>{turn.body}</Text></View>)}
      {view.awaitingAgent ? <View testID={`card-question-waiting-${view.id}`} style={styles.turn} accessibilityLabel="담당의 답을 기다리는 중">
        {avatar('agent')}
        <View style={styles.waiting}><ActivityIndicator size="small" color={t.colors.textMuted} /><Text style={styles.meta}>답을 기다리는 중</Text></View>
      </View> : null}
    </View> : null}
    {view.kind === 'choice' && view.options.length ? <View accessibilityRole="radiogroup" style={[requestStyles.optionsGroup, styles.choices]}>
      {view.options.map((option, index) => {
        const chosen = !view.open && view.selectedOption === option.label;
        return <React.Fragment key={option.label}>
          {index > 0 ? <View style={requestStyles.optionDividerBare} /> : null}
          <Pressable testID={`card-question-choice-${index}`} accessibilityRole="button" disabled={!view.open || busy}
            accessibilityLabel={[option.label, option.recommended ? '권함' : null, option.description].filter(Boolean).join('. ')}
            accessibilityState={{ selected: chosen, disabled: !view.open || busy }} onPress={() => onChoose(option.label)}
            style={({ pressed }) => [requestStyles.optionRow, styles.choiceRow, (chosen || pressed) && requestStyles.optionRowActive, !view.open && !chosen && styles.dimmed]}>
            <View style={requestStyles.optionCopy}>
              <View style={styles.labelRow}><Text style={styles.choiceLabel}>{option.label}</Text>
                {option.recommended ? <Text style={styles.recommended}>권함</Text> : null}</View>
              {option.description ? <Text style={styles.effect}>{option.description}</Text> : null}
            </View>
          </Pressable>
        </React.Fragment>;
      })}
    </View> : null}
  </View>;
}

/** 늘 있는 동작. 아래 입력창이 보이는 자리에서는 입력창이 「다르게 답하기」라 단추를 두지 않는다. */
export function CardQuestionActions({ view, composerVisible = false, busy = false, onAnswerFreely, onAskBack, onDone }: {
  view: CardQuestionView; composerVisible?: boolean; busy?: boolean; onAnswerFreely(): void; onAskBack(): void; onDone?(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  if (!view.open) return null;
  const button = (label: string, onPress: () => void, primary = false) => <GlassButton key={label} variant={primary ? 'primary' : 'paper'} size="compact"
    disabled={busy} accessibilityLabel={label} onPress={onPress} style={styles.button}>
    <Text style={[styles.buttonLabel, primary && { color: t.colors.accentText }]}>{label}</Text>
  </GlassButton>;
  return <View testID="card-question-actions" style={styles.actions}>
    {composerVisible ? null : button('다르게 답하기', onAnswerFreely)}
    {button('되묻기', onAskBack)}
    {view.kind === 'request' ? button('했어', () => onDone?.(), true) : null}
  </View>;
}

/** 답을 보낸 뒤: 받은 답과 「덧붙이기」. 덧붙인 말은 같은 질문에 이어진 커멘트로 간다. */
export function CardQuestionAnswered({ view, onAppend }: { view: CardQuestionView; onAppend(): void }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  if (view.open || !view.answer) return null;
  return <View testID="card-question-answered" style={styles.answered}>
    <Text style={styles.answerText}><Text style={styles.meta}>받은 답  </Text>{view.answer}</Text>
    <GlassButton variant="plain" size="compact" accessibilityLabel="덧붙이기" onPress={onAppend}><Text style={styles.metaLink}>덧붙이기</Text></GlassButton>
  </View>;
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  return StyleSheet.create({
    body: { gap: t.uiSpacing.md },
    background: { ...type.body, color: t.colors.textPrimary },
    evidence: { flexDirection: 'row', flexWrap: 'wrap', gap: t.uiSpacing.sm },
    imageEvidence: { alignItems: 'flex-start' },
    evidenceLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.uiSpacing.xs },
    linkFrame: { alignSelf: 'flex-start', maxWidth: '100%' },
    linkSurface: { minHeight: t.controlHeight.chip, backgroundColor: t.colors.surfaceCode, maxWidth: '100%', borderRadius: t.foundation.radius.round,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, paddingHorizontal: t.uiSpacing.sm },
    linkContent: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xxs, maxWidth: '100%' },
    linkText: { ...type.meta, color: t.colors.link, fontWeight: '600', flexShrink: 1 },
    thread: { gap: t.uiSpacing.sm },
    turn: { flexDirection: 'row', alignItems: 'flex-start', gap: t.uiSpacing.sm },
    avatar: { width: t.avatarSize.message, height: t.avatarSize.message, borderRadius: t.avatarSize.message / 2, backgroundColor: t.colors.border },
    avatarFallback: { alignItems: 'center', justifyContent: 'center' },
    avatarFallbackText: { ...type.meta, color: t.colors.textMuted, fontWeight: '600' },
    turnText: { ...type.body, flex: 1, minWidth: 0, color: t.colors.textPrimary, paddingTop: (t.avatarSize.message - type.body.lineHeight) / 2 },
    waiting: { flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, minHeight: t.avatarSize.message },
    choices: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border },
    dimmed: { opacity: DIMMED_OPACITY },
    choiceRow: { minHeight: t.foundation.minHeight.row, alignSelf: 'stretch' },
    labelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: t.uiSpacing.sm },
    choiceLabel: { ...type.body, fontWeight: '600', color: t.colors.textPrimary },
    recommended: { ...type.label, color: t.colors.accent },
    effect: { ...type.body, color: t.colors.textSecondary },
    actions: { marginLeft: 'auto', flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: t.uiSpacing.sm, rowGap: t.uiSpacing.xs },
    button: { maxWidth: '100%' },
    buttonLabel: { ...type.body, color: t.colors.textPrimary },
    answered: { flexBasis: 0, flexGrow: 1, flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', columnGap: t.uiSpacing.sm, minHeight: t.hitTarget.min },
    answerText: { ...type.body, color: t.colors.textPrimary },
    meta: { ...type.meta, color: t.colors.textSecondary },
    metaLink: { ...type.meta, color: t.colors.link },
  });
}
