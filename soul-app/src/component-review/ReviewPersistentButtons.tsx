import React from 'react';
import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { ChatNewMessageButton } from '../components/chat/ChatNewMessageButton';
import { useTokens } from '../theme';

export function ReviewPersistentButtons() {
  const t = useTokens();
  return (
    <View style={{ flex: 1, backgroundColor: t.persistentSession.paper, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.lg }}>
        <LiquidGlassButton
          iconOnly
          size="compact"
          variant="plain"
          accessibilityLabel="홈으로 돌아가기"
          onPress={() => undefined}
          testID="persistent-review-plain-button"
          surfaceTestID="persistent-review-plain-button-visual"
        >
          <Ionicons name="home-outline" size={t.iconSize.navigation} color={t.colors.textPrimary} />
        </LiquidGlassButton>
        <LiquidGlassButton
          iconOnly
          size="compact"
          variant="plain"
          disabled
          accessibilityLabel="비활성 설정 버튼"
          onPress={() => undefined}
          testID="persistent-review-plain-disabled-button"
          surfaceTestID="persistent-review-plain-disabled-button-visual"
        >
          <Ionicons name="options-outline" size={t.iconSize.navigation} color={t.colors.textPrimary} />
        </LiquidGlassButton>
        <ChatNewMessageButton onPress={() => undefined} />
      </View>
    </View>
  );
}
