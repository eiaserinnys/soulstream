type HomePhase = 'drawer' | 'settings' | 'search';
let listener: ((phase: HomePhase) => void) | undefined;

export function subscribeHomePhase(next: (phase: HomePhase) => void) {
  listener = next;
  return () => { listener = undefined; };
}

export function recordHomePress(testID: string) {
  const phase = { 'duo-main-menu': 'drawer', 'duo-main-settings': 'settings', 'duo-main-search': 'search' }[testID] as HomePhase | undefined;
  if (phase) listener?.(phase);
}
