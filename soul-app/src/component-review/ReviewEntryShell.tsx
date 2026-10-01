import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { TabNavigator } from '../navigation/TabNavigator';
import { ThreePaneLayout } from '../components/split/ThreePaneLayout';
import { useDeviceType } from '../theme';

/** Real phone tab/stack/home and tablet split tree. Metro injects fixture transport. */
export function ReviewEntryShell() {
  return <NavigationContainer>{useDeviceType() === 'phone' ? <TabNavigator /> : <ThreePaneLayout />}</NavigationContainer>;
}
