import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { createApiClient } from '../../api/client';
import { ApiHttpError } from '../../api/clientCore';
import type {
  SessionReviewPolicyPayload,
  SessionReviewSourceCatalogEntry,
} from '../../api/settingsEndpoints';
import { useTokens, type DesignTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { SettingsSection } from './SettingsSection';

const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const UNSAFE_SOURCE_COPY = /\b(?:user_id|email|display_name|ingress|mcp|parent)\b|권한|도구|상위\s*요청|알림|·/i;
const SOURCE_PRESENTATION = new Map<string, { label: string; description: string }>([
  ['slack', {
    label: 'Slack',
    description: 'Slack에서 새로 만든 세션',
  }],
  ['soul-app', {
    label: 'Soul 앱',
    description: 'Soul 앱에서 새로 만든 세션',
  }],
  ['external-llm', {
    label: '외부 LLM',
    description: '외부 LLM에서 새로 만든 세션',
  }],
  ['clipper', {
    label: 'Clipper',
    description: 'Clipper에서 새로 만든 세션',
  }],
  ['llm', {
    label: '공용 자동 요청',
    description: '공용 자동 요청에서 새로 만든 세션',
  }],
  ['agent', {
    label: '에이전트 자동 요청',
    description: '에이전트가 자동으로 만든 세션',
  }],
  ['system', {
    label: '시스템 자동 요청',
    description: '시스템이 자동으로 만든 세션',
  }],
  ['cron', {
    label: '예약 작업',
    description: '예약 작업으로 만든 세션',
  }],
  ['channel_observer', {
    label: '채널 관찰',
    description: '채널 관찰이 자동으로 만든 세션',
  }],
]);

interface PolicyConflictDraft {
  baseSources: readonly string[];
  draftSources: readonly string[];
}

export function SessionReviewPolicySettingsSection({
  flattened,
  serverUrl,
}: {
  flattened: boolean;
  serverUrl: string;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [payload, setPayload] = useState<SessionReviewPolicyPayload | null>(null);
  const form = usePersistentDraft('review-policy', [], { sources: payload?.policy.sourceAllowlist ?? [], input: '' });
  const { sources, input: draft } = form.value;
  const setSources = (update: React.SetStateAction<string[]>) => form.setValue(current => ({ ...current,
    sources: typeof update === 'function' ? update(current.sources) : update }));
  const setDraft = (input: string) => form.setValue(current => ({ ...current, input }));
  const formRef = React.useRef(form);
  formRef.current = form;
  const payloadRef = React.useRef(payload);
  payloadRef.current = payload;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changed = payload !== null
    && JSON.stringify(sources) !== JSON.stringify(payload.policy.sourceAllowlist);
  const catalog = useMemo(
    () => new Map(
      payload?.sourceCatalog.map((entry) => [entry.source, entry]) ?? [],
    ),
    [payload?.sourceCatalog],
  );
  const load = useCallback(async (conflict?: PolicyConflictDraft) => {
    if (!serverUrl) {
      setLoading(false);
      setError('서버 연결을 먼저 설정해 주세요.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await createApiClient(serverUrl).getSessionReviewPolicy();
      const previousSources = payloadRef.current?.policy.sourceAllowlist;
      setPayload(next);
      if (conflict) formRef.current.setValue(current => ({ ...current,
        sources: rebaseSourceChanges(conflict.baseSources, conflict.draftSources, next.policy.sourceAllowlist) }));
      else if (previousSources && formRef.current.hasDraft) formRef.current.setValue(current => ({ ...current,
        sources: rebaseSourceChanges(previousSources, current.sources, next.policy.sourceAllowlist) }));
      setMessage(
        conflict
          ? '다른 관리자가 먼저 저장했습니다. 최신 버전에 내 변경만 다시 적용했습니다. 확인 후 저장해 주세요.'
          : null,
      );
    } catch (cause) {
      setError(errorMessage(cause, '검수 정책을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  function addSource() {
    const source = draft.trim().toLowerCase();
    if (!source) return;
    if (source === 'browser') {
      setError('로그인한 브라우저 요청은 항상 검수되므로 이 목록에 추가할 수 없습니다.');
      return;
    }
    if (!SOURCE_PATTERN.test(source)) {
      setError('출처 ID는 영문 소문자, 숫자, 하이픈, 밑줄을 사용해 1~64자로 입력해 주세요.');
      return;
    }
    if (sources.length >= 64 && !sources.includes(source)) {
      setError('검수 출처는 최대 64개까지 등록할 수 있습니다.');
      return;
    }
    setSources((current) => current.includes(source)
      ? current
      : [...current, source]);
    setDraft('');
    setError(null);
    setMessage(null);
  }

  async function save() {
    if (!form.ready || !payload || !changed) return;
    const submitted = form.value;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await createApiClient(serverUrl).updateSessionReviewPolicy({
        sourceAllowlist: sources,
        expectedVersion: payload.policy.version,
      });
      setPayload(next);
      // The API saves the list, but an ID not added to it is still an unsaved input.
      if (!submitted.input) form.clearIfMatches(submitted);
      setMessage(`정책 v${next.policy.version}을 저장했습니다. 다음 신규 세션부터 모든 노드에 적용됩니다.`);
    } catch (cause) {
      if (cause instanceof ApiHttpError && cause.status === 409) {
        await load({
          baseSources: payload.policy.sourceAllowlist,
          draftSources: sources,
        });
      } else {
        setError(errorMessage(cause, '검수 정책을 저장하지 못했습니다.'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection id="review-policy" title="세션 검수" flattened={flattened}>
      <View style={styles.block}>
        <Text style={styles.heading}>브라우저 로그인 요청</Text>
        <Text style={styles.help}>
          로그인한 브라우저 요청은 이 목록과 관계없이 항상 검수됩니다.
        </Text>
      </View>

      <View style={[styles.block, styles.divided]}>
        <Text style={styles.heading}>검수할 출처</Text>
        <Text style={styles.help}>
          이 목록에 추가한 출처에서 시작된 신규 세션은 검수 대기열에 포함됩니다.
          저장한 정책은 다음 신규 세션부터 모든 노드에 적용됩니다. 기존 세션은
          바뀌지 않습니다. 공용 자동 요청 출처(llm)는 기본 검수 대상에서 제외됩니다.
        </Text>

        {loading && !payload ? (
          <ActivityIndicator testID="review-policy-loading" color={t.colors.accent} />
        ) : null}

        {sources.map((source) => {
          const entry = catalog.get(source);
          const presentation = sourcePresentation(source, entry);
          return (
            <View key={source} testID={`review-policy-source-${source}`} style={styles.sourceRow}>
              <View style={styles.sourceText}>
                <Text style={styles.sourceTitle}>{presentation.label}</Text>
                <Text style={styles.sourceId}>{source}</Text>
                <Text style={styles.help}>
                  {presentation.description}
                  {entry?.automatic ? ' 자동 요청 출처일 수 있으므로 포함 전 확인이 필요합니다.' : ''}
                </Text>
              </View>
              <TouchableOpacity
                testID={`review-policy-remove-${source}`}
                accessibilityRole="button"
                accessibilityLabel={`${presentation.label} 제거`}
                accessibilityState={{ disabled: loading || saving }}
                style={styles.removeButton}
                disabled={!form.ready || loading || saving}
                onPress={() => setSources((current) =>
                  current.filter((item) => item !== source))}
              >
                <Text style={styles.removeText}>제거</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <View style={styles.addRow}>
          <TextInput
            testID="review-policy-source-input"
            accessibilityLabel="추가할 출처 ID"
            style={styles.input}
            value={draft}
            placeholder="예: external-llm"
            placeholderTextColor={t.colors.textPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            editable={form.ready && !loading && !saving}
            onChangeText={setDraft}
            onSubmitEditing={addSource}
          />
          <GlassButton
            testID="review-policy-add"
            accessibilityLabel="출처 추가"
            style={styles.smallButton}
            onPress={addSource}
            disabled={!form.ready || !draft.trim() || loading || saving}
          >
            <Text style={styles.secondaryText}>추가</Text>
          </GlassButton>
        </View>

        {payload ? (
          <Text style={styles.metadata}>
            현재 v{payload.policy.version} / {payload.policy.updatedBy} /{' '}
            {formatTimestamp(payload.policy.updatedAt)}
          </Text>
        ) : null}
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
        ) : null}

        <View style={styles.actions}>
          <GlassButton
            testID="review-policy-reload"
            accessibilityLabel="검수 정책 다시 불러오기"
            style={styles.action}
            onPress={() => void load()}
            disabled={!form.ready || loading || saving}
          >
            <Text style={styles.secondaryText}>다시 불러오기</Text>
          </GlassButton>
          <GlassButton
            variant="primary"
            testID="review-policy-save"
            accessibilityLabel="검수 정책 저장"
            style={styles.action}
            onPress={() => void save()}
            disabled={!changed || loading || saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={t.colors.accentText} />
            ) : (
              <Text style={styles.primaryText}>정책 저장</Text>
            )}
          </GlassButton>
        </View>
      </View>
    </SettingsSection>
  );
}

function sourcePresentation(
  source: string,
  entry: SessionReviewSourceCatalogEntry | undefined,
): { label: string; description: string } {
  const fallback = SOURCE_PRESENTATION.get(source) ?? {
    label: source,
    description: '이 출처에서 새로 만든 세션',
  };
  return {
    label: userFacingCopy(entry?.label) ?? fallback.label,
    description: userFacingCopy(entry?.description) ?? fallback.description,
  };
}

function userFacingCopy(value: string | undefined): string | null {
  const copy = value?.trim();
  return copy && !UNSAFE_SOURCE_COPY.test(copy) ? copy : null;
}

function rebaseSourceChanges(
  baseSources: readonly string[],
  draftSources: readonly string[],
  latestSources: readonly string[],
): string[] {
  const base = new Set(baseSources);
  const draft = new Set(draftSources);
  const removed = new Set(baseSources.filter((source) => !draft.has(source)));
  const rebased = latestSources.filter((source) => !removed.has(source));
  const included = new Set(rebased);

  for (const source of draftSources) {
    if (!base.has(source) && !included.has(source)) {
      rebased.push(source);
      included.add(source);
    }
  }
  return rebased;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiHttpError) {
    try {
      const body = JSON.parse(cause.body) as {
        detail?: string | { error?: { message?: string } };
      };
      if (typeof body.detail === 'string') return body.detail;
      if (body.detail?.error?.message) return body.detail.error.message;
    } catch {
      // Fall through to the stable client-facing fallback.
    }
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString() : value;
}

function makeStyles(t: DesignTokens) {
  return StyleSheet.create({
    block: { padding: t.cardLayout.padding, gap: t.spacing.md },
    divided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
    heading: {
      ...t.foundation.typography.label,
      color: t.colors.textPrimary,
      fontWeight: '700',
    },
    help: {
      ...t.foundation.typography.body,
      color: t.colors.textSecondary,
      flexShrink: 1,
    },
    sourceRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.spacing.sm,
      padding: t.spacing.md,
      borderRadius: t.foundation.radius.field,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surfaceMuted,
    },
    sourceText: { flex: 1, minWidth: 0, gap: t.spacing.xxs },
    sourceTitle: {
      ...t.foundation.typography.body,
      color: t.colors.textPrimary,
      fontWeight: '700',
    },
    sourceId: {
      ...t.foundation.typography.label,
      color: t.colors.textMuted,
    },
    removeButton: {
      minWidth: t.hitTarget.min,
      minHeight: t.hitTarget.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    removeText: {
      ...t.foundation.typography.body,
      color: t.colors.errorText,
      fontWeight: '600',
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: t.spacing.sm,
    },
    input: {
      ...t.foundation.typography.body,
      color: t.colors.textPrimary,
      flex: 1,
      minWidth: 0,
      minHeight: t.foundation.minHeight.field,
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.foundation.radius.field,
      backgroundColor: t.colors.surfaceMuted,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    smallButton: { minWidth: 72 },
    metadata: {
      ...t.foundation.typography.label,
      color: t.colors.textMuted,
    },
    message: {
      ...t.foundation.typography.body,
      color: t.colors.successText,
    },
    error: {
      ...t.foundation.typography.body,
      color: t.colors.errorText,
    },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.spacing.sm,
    },
    action: { flex: 1, minWidth: 140 },
    secondaryText: {
      ...t.foundation.typography.body,
      color: t.colors.link,
      fontWeight: '600',
    },
    primaryText: {
      ...t.foundation.typography.body,
      color: t.colors.accentText,
      fontWeight: '700',
    },
  });
}
