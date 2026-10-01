import { Alert, Platform } from 'react-native';

interface PlannerPromptInput {
  title: string;
  message?: string;
  current?: string;
  allowBlank?: boolean;
  onSubmit(value: string | null): void;
}

export function promptPlannerText({
  title,
  message,
  current = '',
  allowBlank = false,
  onSubmit,
}: PlannerPromptInput) {
  if (Platform.OS !== 'ios') {
    Alert.alert(title, '텍스트 입력은 iOS 앱에서 지원합니다.');
    return;
  }
  Alert.prompt(title, message, [
    { text: '취소', style: 'cancel' },
    {
      text: '확인',
      onPress: (value?: string) => {
        const normalized = value?.trim() ?? '';
        if (normalized) onSubmit(normalized);
        else if (allowBlank) onSubmit(null);
      },
    },
  ], 'plain-text', current);
}

export function confirmPlannerAction(input: {
  title: string;
  message: string;
  confirmText?: string;
  destructive?: boolean;
  onConfirm(): void;
}) {
  Alert.alert(input.title, input.message, [
    { text: '취소', style: 'cancel' },
    {
      text: input.confirmText ?? '확인',
      style: input.destructive ? 'destructive' : undefined,
      onPress: input.onConfirm,
    },
  ]);
}
