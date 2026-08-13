export function advanceUnacknowledgedSourceSequence(
  sourceSeq: number,
  ackedThrough: number,
  previousUnacknowledged: number,
): number {
  // ACKed rows may be sparse after compaction or quarantine. Only the
  // unacknowledged suffix is an orch replay contract and must be contiguous.
  if (sourceSeq <= ackedThrough) return previousUnacknowledged;
  if (sourceSeq !== previousUnacknowledged + 1) {
    throw new Error(
      `event outbox source_seq gap detected: expected ${previousUnacknowledged + 1}, `
      + `found ${sourceSeq}, acked_through ${ackedThrough}`,
    );
  }
  return sourceSeq;
}
