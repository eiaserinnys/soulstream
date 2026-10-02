import '@expo/metro-runtime';
import '../../component-review/review.css';
import React from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NameInputProposal } from './NameInputProposal';
function Proposal() {
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><NameInputProposal /></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Proposal);
