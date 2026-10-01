import React from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  requireNativeViewManager,
  requireOptionalNativeModule,
} from 'expo-modules-core';

export interface SearchCommandEvent {
  input: string;
  command: boolean;
}

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onCommand(event: SearchCommandEvent): void;
};

const hasNativeSearchCommands =
  Platform.OS === 'ios' &&
  requireOptionalNativeModule('SoulAppSearchCommands') !== null;

const NativeSearchCommandsView: React.ComponentType<any> =
  hasNativeSearchCommands
    ? requireNativeViewManager('SoulAppSearchCommands')
    : View;

export function SearchCommandsView({
  children,
  style,
  onCommand,
}: Props) {
  if (!hasNativeSearchCommands) {
    return <View style={[styles.container, style]}>{children}</View>;
  }
  return (
    <NativeSearchCommandsView
      style={[styles.container, style]}
      onCommand={(event: { nativeEvent: SearchCommandEvent }) =>
        onCommand(event.nativeEvent)
      }
    >
      {children}
    </NativeSearchCommandsView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
