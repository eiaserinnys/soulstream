import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { TabNavigator } from '../navigation/TabNavigator';

/** Actual phone entry tree, also shown wide to compare the picker control. */
export function ReviewFolderTabs() {
  return <NavigationContainer><TabNavigator /></NavigationContainer>;
}
