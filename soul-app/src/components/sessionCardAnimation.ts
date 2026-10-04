import type { AppStateStatus } from 'react-native';

export interface SessionCardAnimationGate {
  isRunning: boolean;
  animationActive?: boolean;
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
  animationActive = true,
}: SessionCardAnimationGate): boolean {
  return isRunning && !reducedMotion && appActive && animationActive;
}

export function shouldRenderSessionCardShimmer({
  cardWidth,
  ...gate
}: SessionCardShimmerGate): boolean {
  return shouldRunSessionCardAnimation(gate) && cardWidth > 0;
}
