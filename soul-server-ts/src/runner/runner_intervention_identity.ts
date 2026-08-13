export function runnerInterventionApplyCommandId(interventionId: string): string {
  return `apply-intervention:${interventionId}`;
}

export function runnerInterventionDiscardCommandId(interventionId: string): string {
  return `discard-intervention:${interventionId}`;
}
