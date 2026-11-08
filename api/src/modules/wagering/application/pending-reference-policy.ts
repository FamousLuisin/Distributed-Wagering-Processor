export const PENDING_REFERENCE_POLICY = {
  maxAttempts: 8,
  ttlMs: 15 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  leaseMs: 60_000,
  batchSize: 10,
  pollIntervalMs: 1_000,
} as const;

export function pendingReferenceRetryDelay(attempt: number): number {
  return Math.min(
    PENDING_REFERENCE_POLICY.baseDelayMs * 2 ** Math.max(attempt, 0),
    PENDING_REFERENCE_POLICY.maxDelayMs,
  );
}
