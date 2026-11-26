const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function timestamp(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

export function summarizeWeeklyQuota(quota, now = Date.now()) {
  const remainingPercent = quota?.remainingPercent;
  const updatedAt = timestamp(quota?.updatedAt);
  const resetAt = timestamp(quota?.resetAt);
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100 ||
      !Number.isFinite(now) || updatedAt === null || updatedAt > now ||
      (resetAt !== null && resetAt <= now)) return null;

  const result = {
    remainingPercent, updatedAt, resetAt,
    untilResetMs: resetAt === null ? null : resetAt - now,
    pacePercent: null,
    expectedRemainingPercent: null,
    estimatedMs: null,
    forecast: remainingPercent === 0 ? 'depleted' : 'unavailable',
  };
  if (resetAt === null) return result;

  // Use the cached usage at the sample time to estimate the average across the weekly cycle.
  const elapsedMs = updatedAt - (resetAt - WEEK_MS);
  if (elapsedMs <= 0) return result;
  const expectedUsedPercent = elapsedMs / WEEK_MS * 100;
  const usedPercent = 100 - remainingPercent;
  result.expectedRemainingPercent = 100 - expectedUsedPercent;
  result.pacePercent = Math.round(usedPercent / expectedUsedPercent * 100);
  if (remainingPercent === 0) return result;

  // Match the forecast threshold to the whole-percent pace shown in the card.
  if (result.pacePercent <= 100) {
    result.forecast = 'until-reset';
  } else {
    const timeLeft = (remainingPercent / usedPercent) * elapsedMs - (now - updatedAt);
    if (timeLeft > 0) {
      result.estimatedMs = timeLeft;
      result.forecast = 'estimate';
    } else {
      result.forecast = 'outdated';
    }
  }
  return result;
}
