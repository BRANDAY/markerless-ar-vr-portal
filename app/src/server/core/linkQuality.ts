/**
 * Is the connection to the server good enough to look for the door at all? Asked before a
 * visitor's camera opens (the owner's decision of 2026-11-21: "first the connection to the
 * server and a check of its quality; with a bad connection there is no point in trying").
 * Pure TypeScript.
 *
 * What a look for the room needs from the network: a clip of about 1.5 MB goes up and a
 * small answer comes back, and the server's health is asked every few seconds. A server on
 * the same Wi-Fi answers `GET /health` in 5-40 ms (measured on the home network: 37 ms).
 */
export const LINK = {
  /** This many health requests, one after another... */
  probes: 5,
  /** ...this far apart... */
  gapMs: 250,
  /** ...each given this long (the heartbeat's own patience). */
  timeoutMs: 1500,
  /**
   * BAD when two or more of the five stay unanswered: such a link loses the clip or its
   * answer about as often as not, and every loss costs a whole look.
   */
  maxLost: 1,
  /**
   * BAD when half of the answers took longer than this. Ten times what a server on the
   * same Wi-Fi needs: the phone is at the edge of the network, or the PC is overloaded
   * (on the first pass an overloaded PC made a look take 39 s instead of 4).
   */
  maxMedianMs: 500,
} as const;

export interface LinkVerdict {
  good: boolean;
  /** Median of the answers that came, milliseconds; null when none came. */
  medianMs: number | null;
  /** Requests without an answer in time. */
  lost: number;
  probes: number;
}

/** `latencies`: one entry per request, null for one that was not answered in time. */
export function judgeLink(latencies: readonly (number | null)[]): LinkVerdict {
  const answered = latencies.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const lost = latencies.length - answered.length;
  if (answered.length === 0) {
    return { good: false, medianMs: null, lost, probes: latencies.length };
  }
  const sorted = [...answered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const medianMs = Math.round(median);
  return { good: lost <= LINK.maxLost && medianMs <= LINK.maxMedianMs, medianMs, lost, probes: latencies.length };
}
