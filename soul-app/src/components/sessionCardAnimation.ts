import type { AppStateStatus } from 'react-native';

export interface SessionCardAnimationGate {
  isRunning: boolean;
  reducedMotion: boolean;
  appActive: boolean;
}

export interface SessionCardShimmerGate extends SessionCardAnimationGate {
  cardWidth: number;
}

export function isForegroundAppState(state: AppStateStatus): boolean {
  return state === 'active';
}

export function shouldRunStatusDotAnimation(
  status: string | undefined,
  appActive: boolean,
): boolean {
  return status === 'running' && appActive;
}

export function shouldRunSessionCardAnimation({
  isRunning,
  reducedMotion,
  appActive,
}: SessionCardAnimationGate): boolean {
  return isRunning && !reducedMotion && appActive;
}

export function shouldRenderSessionCardShimmer({
  cardWidth,
  ...gate
}: SessionCardShimmerGate): boolean {
  return shouldRunSessionCardAnimation(gate) && cardWidth > 0;
}
