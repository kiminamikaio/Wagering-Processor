export const REFERENCE_RETRY_BASE_MS = 1_000;
export const REFERENCE_RETRY_MAX_DELAY_MS = 300_000;

export function referenceRetryDelayMs(
  attempts: number,
  random: () => number = Math.random,
  baseDelayMs = REFERENCE_RETRY_BASE_MS,
): number {
  const exponential = Math.min(
    REFERENCE_RETRY_MAX_DELAY_MS,
    baseDelayMs * 2 ** Math.min(Math.max(attempts - 1, 0), 20),
  );
  return Math.min(
    REFERENCE_RETRY_MAX_DELAY_MS,
    Math.max(1, Math.floor(exponential * (0.5 + random()))),
  );
}
