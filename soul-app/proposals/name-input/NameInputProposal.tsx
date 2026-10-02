import React, { useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { AppModalSurface } from '../../src/components/AppModalSurface';
import { AppKeyboardAvoidingView } from '../../src/components/AppKeyboardAvoidingView';
import { GlassButton } from '../../src/components/GlassSurface';
import { cardStyles } from '../../src/components/planner/Card.styles';
import { useTokens } from '../../src/theme';

/** Isolated approval sample. Never imported by the app or component review. */
export function NameInputProposal() {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('앱 입력 보존 확인');
  const [fail, setFail] = useState(false);
  const [error, setError] = useState('');
  return <>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.heading}>사용자 검토용 이름 변경 시안</Text>
      <Text style={styles.body}>운영 화면에 연결하지 않은 시안입니다. 웹에서는 iOS 키보드와 native pageSheet를 확인할 수 없습니다.</Text>
      <GlassButton onPress={() => setOpen(true)}><Text style={styles.body}>세션 이름 변경 시안 열기</Text></GlassButton>
      <GlassButton onPress={() => setFail(value => !value)}><Text style={styles.body}>{fail ? '저장 실패 모의 켜짐' : '저장 실패 모의 꺼짐'}</Text></GlassButton>
    </ScrollView>
    <AppModalSurface visible={open} modalId="modal_card_assignment" variant="expanded"
      presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <AppKeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.heading}>세션 이름 변경 · 시안</Text>
          <TextInput accessibilityLabel="세션 이름" placeholder="세션 이름" value={text}
            onChangeText={setText} style={styles.input} placeholderTextColor={t.colors.textPlaceholder} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <GlassButton onPress={() => setOpen(false)}><Text style={styles.body}>닫기</Text></GlassButton>
            <GlassButton disabled={!text.trim()} onPress={() => {
              if (fail) { setError('저장 실패 모의: 입력을 유지합니다.'); return; }
              setText(''); setError(''); setOpen(false);
            }}><Text style={styles.actionText}>저장</Text></GlassButton>
          </View>
        </ScrollView>
      </AppKeyboardAvoidingView>
    </AppModalSurface>
  </>;
}
