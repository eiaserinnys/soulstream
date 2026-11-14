export const ACK_WINDOW_MS = 5 * 60_000;
export const ACK_P99_GATE_MS = 250;
export const ACK_MAX_GATE_MS = 1_000;

export type AckSample = { observedAtMs: number; durationMs: number };

/** 창 안의 표본에 이번 ack 시간을 더하고 그 가족의 지연 측정값을 낸다. */
export function recordAckSample(
  samples: AckSample[],
  nowMs: number,
  durationMs: number,
): Record<string, unknown> {
  samples.push({ observedAtMs: nowMs, durationMs });
  while (samples[0] && nowMs - samples[0].observedAtMs > ACK_WINDOW_MS) samples.shift();
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const maxMs = durations.at(-1) ?? 0;
  const p99Ms = durations.length < 20
    ? null
    : durations[Math.max(0, Math.ceil(durations.length * 0.99) - 1)]!;
  return {
    windowMs: ACK_WINDOW_MS,
    sampleCount: durations.length,
    p99Ms,
    maxMs,
    p99GateMs: ACK_P99_GATE_MS,
    maxGateMs: ACK_MAX_GATE_MS,
    withinGate: maxMs <= ACK_MAX_GATE_MS
      && (p99Ms === null || p99Ms <= ACK_P99_GATE_MS),
  };
}
