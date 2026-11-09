export const title = 'Soulstream runner recovery: observed finite model';
export function state(v) {
  if (v.branch === 'reaped') {
    const protectedExecution = v.holdsExecution && (v.oldAlive || v.currentIdentity !== 'old');
    if (v.pc === 'observed') return ['Reaped cleanup', protectedExecution ? 'Execution protected' : 'Old registration ready'];
    return ['Reaped cleanup', v.touchedNewExecution ? 'New execution damaged' : protectedExecution ? 'Cleanup skipped' : 'Old registration recovered'];
  }
  const label = v.pc === 'observed' ? 'Terminal registration'
    : v.pc === 'replaying' ? 'Replaying records'
    : v.pc === 'retireCheck' ? v.replayed ? 'Replay complete' : 'Replay skipped'
    : v.retired ? 'Registration retired' : 'Preserved for retry';
  return ['Terminal replay', label];
}
export function step(action, from, to) {
  if (action === 'Finished') return null;
  if (action.startsWith('ReplayResult')) return to.replayed ? 'Replay succeeded' : 'Replay did not run';
  return ({ SkipReapedCleanup: 'Owner guard blocks cleanup', ApplyReapedCleanup: 'Apply cleanup', BeginReplay: 'Recover offline', Retire: 'Retire after replay', KeepForRetry: 'Keep registration' })[action] ?? action;
}
