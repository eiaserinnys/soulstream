import React, { useState, type PropsWithChildren } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSettingsStore } from '../store/settingsStore';

export function MockupShell({ children }: PropsWithChildren) {
  useState(() => {
    const theme = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('theme') : null;
    useSettingsStore.setState({ appearance: theme === 'dark' ? 'dark' : 'light' });
    return true;
  });
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    {children}
  </SafeAreaProvider></GestureHandlerRootView>;
}
