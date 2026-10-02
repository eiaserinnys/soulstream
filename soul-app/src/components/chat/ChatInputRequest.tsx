import { usePersistentDraft } from '../../hooks/usePersistentDraft';
/**
 * ChatInputRequest — Claude AskUserQuestion 인라인 카드
 *
 * 질문 전체의 답을 수집해 한 번에 전송한다. 단일 질문·단일 선택만 기존처럼 선택 즉시
 * 전송하고, 다중 질문 또는 다중 선택은 명시적인 제출 버튼을 사용한다.
 */

import React, { memo, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import type {
  InputRequestPayload,
  InputRequestQuestion,
  InputRequestStatusPayload,
  SessionEvent,
} from '../../api/types';
import { createApiClient } from '../../api/client';
import { useSettingsStore } from '../../store/settingsStore';
import { useChatStore } from '../../store/chatStore';
import { useInputRequestTimer } from '../../hooks/useInputRequestTimer';
import { useTokens } from '../../theme';
import { GlassButton, GlassSurface } from '../GlassSurface';
import { makeChatInputRequestStyles } from './ChatInputRequest.styles';

interface Props {
  event: SessionEvent;
  sessionId: string;
}

type AnswerSelections = Record<number, string[]>;
type SubmissionState = 'idle' | 'submitting' | 'submitted';

const SUBMIT_ERROR_MESSAGE =
  '응답을 보내지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function isMultiSelect(question: InputRequestQuestion): boolean {
  return question.multiSelect === true;
}

function allQuestionsAnswered(
  questions: InputRequestQuestion[],
  selections: AnswerSelections,
): boolean {
  return questions.every(
    (_question, index) => (selections[index]?.length ?? 0) > 0,
  );
}

function buildAnswerPayload(
  questions: InputRequestQuestion[],
  selections: AnswerSelections,
): Record<string, string> {
  return questions.reduce<Record<string, string>>((answers, question, index) => {
    const selected = selections[index] ?? [];
    if (selected.length > 0) {
      answers[question.question] = isMultiSelect(question)
        ? selected.join(', ')
        : selected[0];
    }
    return answers;
  }, {});
}

export const ChatInputRequest = memo(function ChatInputRequest({
  event,
  sessionId,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeChatInputRequestStyles(t), [t]);
  const payload = event.data as unknown as InputRequestPayload;
  const requestId = payload?.request_id;
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const receivedAt = payload?.started_at
    ? payload.started_at * 1000
    : undefined;
  const timeoutSec = payload?.timeout_sec;
  const { remainingSec, isExpired: timerExpired } = useInputRequestTimer(
    receivedAt,
    timeoutSec,
  );

  const isResponded = useChatStore(
    (state) =>
      (state.eventsBySession[sessionId] ?? []).some(
        (candidate) =>
          candidate.type === 'input_request_responded' &&
          (candidate.data as unknown as InputRequestStatusPayload).request_id ===
            requestId,
      ),
  );
  const isExpired = useChatStore(
    (state) =>
      (state.eventsBySession[sessionId] ?? []).some(
        (candidate) =>
          candidate.type === 'input_request_expired' &&
          (candidate.data as unknown as InputRequestStatusPayload).request_id ===
            requestId,
      ),
  );

  const draft = usePersistentDraft<AnswerSelections>('chat-question', [sessionId, requestId ?? event.id], {});
  const [confirmedSelections, setConfirmedSelections] = useState<AnswerSelections | null>(null);
  const selections = confirmedSelections ?? draft.value;
  const setSelections = draft.setValue;
  const [submissionState, setSubmissionState] =
    useState<SubmissionState>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (questions.length === 0) return null;

  const needsExplicitSubmit =
    questions.length > 1 || questions.some(isMultiSelect);
  const isDone = isResponded || submissionState === 'submitted';
  const isTimedOut = isExpired || (timerExpired && !isDone);
  const isSubmitting = submissionState === 'submitting';
  const interactionDisabled = !draft.ready || isDone || isTimedOut || isSubmitting;
  const canSubmit =
    !interactionDisabled && allQuestionsAnswered(questions, selections);

  const reportSubmissionFailure = (
    reason: string,
    detail?: Record<string, unknown>,
  ) => {
    try {
      console.error('[ChatInputRequest] 응답 전송 실패', {
        reason,
        requestId,
        sessionId,
        ...detail,
      });
    } catch {
      // 진단 로그 실패가 사용자의 재시도 경로를 막으면 안 된다.
    }
    setSubmissionState('idle');
    setSubmitError(SUBMIT_ERROR_MESSAGE);
  };

  const submitSelections = async (nextSelections: AnswerSelections) => {
    if (isDone || isTimedOut || isSubmitting) return;
    if (!allQuestionsAnswered(questions, nextSelections)) return;
    setSubmitError(null);
    setSubmissionState('submitting');

    if (!requestId || !sessionId) {
      reportSubmissionFailure('missing_request_identity');
      return;
    }
    const serverUrl = useSettingsStore.getState().serverUrl;
    if (!serverUrl) {
      reportSubmissionFailure('missing_server_url');
      return;
    }

    try {
      const response = await createApiClient(serverUrl).respond(
        sessionId,
        requestId,
        buildAnswerPayload(questions, nextSelections),
      );
      if (!response.ok) {
        reportSubmissionFailure('http_error', { status: response.status });
        return;
      }
      setConfirmedSelections(nextSelections);
      draft.clearIfMatches(nextSelections);
      setSubmissionState('submitted');
    } catch (error) {
      reportSubmissionFailure('network_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleOptionPress = (
    questionIndex: number,
    optionLabel: string,
  ) => {
    if (interactionDisabled || !draft.ready) return;
    setSubmitError(null);
    const question = questions[questionIndex];
    const current = selections[questionIndex] ?? [];
    const nextForQuestion = isMultiSelect(question)
      ? current.includes(optionLabel)
        ? current.filter((label) => label !== optionLabel)
        : [...current, optionLabel]
      : [optionLabel];
    const nextSelections = {
      ...selections,
      [questionIndex]: nextForQuestion,
    };
    setSelections(nextSelections);

    if (!needsExplicitSubmit) {
      void submitSelections(nextSelections);
    }
  };

  return (
    <View style={styles.container}>
      <GlassSurface
        role="glassCard"
        testID="input-request-card"
        style={styles.card}
      >
        <View style={styles.titleRow}>
          <View style={styles.titleIcon}>
            <Text style={styles.titleIconGlyph}>?</Text>
          </View>
          <View style={styles.titleCopy}>
            <Text style={styles.eyebrow}>CLAUDE의 질문</Text>
            <Text style={styles.title}>
              {questions.length > 1
                ? `${questions.length}개 질문에 답해 주세요`
                : '선택해 주세요'}
            </Text>
          </View>
          {!isDone && !isTimedOut ? (
            <Text style={styles.timerText}>
              {formatTime(remainingSec)}
            </Text>
          ) : null}
        </View>

        {questions.map((question, questionIndex) => (
          <View
            key={`${question.question}-${questionIndex}`}
            testID={`input-request-question-${questionIndex}`}
            style={styles.questionPanel}
          >
            <View style={styles.questionHeader}>
              <View style={styles.questionMetaRow}>
                {question.header ? (
                  <Text style={styles.questionHeaderLabel}>
                    {question.header}
                  </Text>
                ) : (
                  <Text style={styles.questionHeaderLabel}>
                    질문 {questionIndex + 1}
                  </Text>
                )}
                {questions.length > 1 ? (
                  <Text style={styles.questionCount}>
                    {questionIndex + 1}/{questions.length}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.questionText}>{question.question}</Text>
              {isMultiSelect(question) ? (
                <Text style={styles.selectionHint}>
                  여러 항목을 선택할 수 있습니다
                </Text>
              ) : null}
            </View>

            {!isDone && !isTimedOut ? (
              <View style={styles.optionsGroup}>
                {question.options?.map((option, optionIndex) => {
                  const selected = (
                    selections[questionIndex] ?? []
                  ).includes(option.label);
                  const accessibilityLabel = [
                    option.label,
                    option.description,
                    option.preview ? `미리보기: ${option.preview}` : null,
                  ]
                    .filter(Boolean)
                    .join('. ');

                  return (
                    <React.Fragment key={`${option.label}-${optionIndex}`}>
                      {optionIndex > 0 ? (
                        <View style={styles.optionDivider} />
                      ) : null}
                      <Pressable
                        testID={`input-request-option-${questionIndex}-${optionIndex}`}
                        onPress={() =>
                          handleOptionPress(questionIndex, option.label)
                        }
                        disabled={interactionDisabled}
                        accessibilityRole={
                          isMultiSelect(question) ? 'checkbox' : 'radio'
                        }
                        accessibilityLabel={accessibilityLabel}
                        accessibilityState={{
                          checked: selected,
                          disabled: interactionDisabled,
                        }}
                        style={({ pressed }) => [
                          styles.optionRow,
                          (selected || pressed) && styles.optionRowActive,
                        ]}
                      >
                        <View
                          style={[
                            styles.choiceIndicator,
                            isMultiSelect(question)
                              ? styles.checkboxIndicator
                              : styles.radioIndicator,
                            selected && styles.choiceIndicatorSelected,
                          ]}
                        >
                          {selected ? (
                            isMultiSelect(question) ? (
                              <Text style={styles.checkmark}>✓</Text>
                            ) : (
                              <View style={styles.radioDot} />
                            )
                          ) : null}
                        </View>
                        <View style={styles.optionCopy}>
                          <Text style={styles.optionLabel}>{option.label}</Text>
                          {option.description ? (
                            <Text style={styles.optionDescription}>
                              {option.description}
                            </Text>
                          ) : null}
                          {option.preview ? (
                            <ScrollView
                              horizontal
                              nestedScrollEnabled
                              showsHorizontalScrollIndicator={false}
                              style={styles.previewViewport}
                              contentContainerStyle={styles.previewContent}
                            >
                              <Text
                                testID={`input-request-preview-${questionIndex}-${optionIndex}`}
                                selectable
                                style={styles.previewText}
                              >
                                {option.preview}
                              </Text>
                            </ScrollView>
                          ) : null}
                        </View>
                      </Pressable>
                    </React.Fragment>
                  );
                })}
              </View>
            ) : null}
          </View>
        ))}

        {isTimedOut ? (
          <View style={styles.statusPanel}>
            <Text style={styles.statusText}>시간 초과</Text>
            <Text style={styles.statusDescription}>
              이 질문은 더 이상 응답할 수 없습니다.
            </Text>
          </View>
        ) : isDone ? (
          <View style={styles.statusPanel}>
            <Text style={styles.doneText}>✓ 응답 완료</Text>
            <Text style={styles.statusDescription}>
              답변을 전달했습니다. 에이전트가 이어서 진행합니다.
            </Text>
          </View>
        ) : (
          <View style={styles.footer}>
            {submitError ? (
              <Text
                testID="input-request-error"
                accessibilityRole="alert"
                style={styles.errorText}
              >
                {submitError}
              </Text>
            ) : null}
            {needsExplicitSubmit ? (
              <GlassButton
                testID="input-request-submit"
                variant="primary"
                disabled={!canSubmit}
                onPress={() => {
                  void submitSelections(selections);
                }}
                accessibilityLabel="선택한 답변 보내기"
                style={styles.submitButton}
              >
                {isSubmitting ? (
                  <ActivityIndicator color={t.colors.accentText} />
                ) : null}
                <Text style={styles.submitButtonText}>
                  {isSubmitting ? '보내는 중' : '답변 보내기'}
                </Text>
              </GlassButton>
            ) : isSubmitting ? (
              <View style={styles.submittingRow}>
                <ActivityIndicator color={t.colors.accent} />
                <Text style={styles.submittingText}>답변을 보내는 중</Text>
              </View>
            ) : null}
          </View>
        )}
      </GlassSurface>
    </View>
  );
});
