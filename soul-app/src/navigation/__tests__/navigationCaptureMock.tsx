import React from 'react';

export interface CapturedNavigator {
  navigatorProps: Record<string, unknown> | null;
  screens: Array<Record<string, any>>;
}

const nativeStacks: CapturedNavigator[] = [];
const bottomTabs: CapturedNavigator[] = [];

function createCapture(target: CapturedNavigator[]) {
  const capture: CapturedNavigator = { navigatorProps: null, screens: [] };
  target.push(capture);
  return {
    Navigator({ children, ...props }: Record<string, any>) {
      capture.navigatorProps = props;
      return React.createElement(React.Fragment, null, children);
    },
    Screen(props: Record<string, any>) {
      const existing = capture.screens.findIndex((screen) => screen.name === props.name);
      if (existing >= 0) capture.screens[existing] = props;
      else capture.screens.push(props);
      return null;
    },
  };
}

export function createNativeStackNavigatorCapture() {
  return createCapture(nativeStacks);
}

export function createBottomTabNavigatorCapture() {
  return createCapture(bottomTabs);
}

export function resetNavigationCapture(): void {
  for (const capture of [...nativeStacks, ...bottomTabs]) {
    capture.navigatorProps = null;
    capture.screens.splice(0);
  }
}

export function getNativeStackCaptures(): readonly CapturedNavigator[] {
  return nativeStacks;
}

export function getBottomTabCaptures(): readonly CapturedNavigator[] {
  return bottomTabs;
}
