import React, { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardQuestion } from '../../api/cardTypes';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { cardStyles } from './Card.styles';

export function CardQuestionView({ api, question }: { api: ApiClient | null; question: CardQuestion }) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const [answer, setAnswer] = useState('');
  const { run, pending } = useCardActions(api);
  return <View style={styles.section}>
    <Text style={styles.body}>{question.text}</Text>
    {question.answer !== null ? <Text style={styles.body}>{question.answer}</Text> : <>
      {question.options?.map((option) => <GlassButton key={option} onPress={() => setAnswer(option)} disabled={pending}
        accessibilityLabel={option}>
        <Text style={answer === option ? styles.actionText : styles.body}>{option}</Text>
      </GlassButton>)}
      <TextInput accessibilityLabel="질문 답변" placeholder="답변 입력" placeholderTextColor={t.colors.textPlaceholder} style={styles.input}
        value={answer} onChangeText={setAnswer} editable={!pending} multiline />
      <GlassButton accessibilityLabel="답변 확인" disabled={!api || !answer.trim() || pending}
        onPress={() => { if (api) void run(() => api.answerCardQuestion(question.cardId, question.id, answer.trim(), cardOperationId())); }}>
        <Text style={styles.actionText}>확인</Text>
      </GlassButton>
    </>}
  </View>;
}
